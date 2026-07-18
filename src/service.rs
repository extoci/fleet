use crate::discovery::{CaptainAdvertisement, SERVICE_TYPE};
use crate::identity;
use crate::skill;
use crate::state::{Machine, Role, StatePaths};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::net::IpAddr;
use std::process::{Child, Command, Output, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use tiny_http::{Header, Method, Response, Server, StatusCode};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct JoinRequest {
    pub machine: Machine,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LeaveRequest {
    pub id: Uuid,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SignedRequest {
    pub payload: serde_json::Value,
    pub signature: String,
}

pub fn run(paths: &StatePaths, listen: &str) -> Result<()> {
    let config = paths.require()?;
    if config.role != Role::Captain {
        bail!("only a captain can run the Fleet daemon");
    }
    std::fs::create_dir_all(paths.logs_dir())?;
    let identity = identity::ensure(paths)?;
    let server = Server::http(listen).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let port = server
        .server_addr()
        .to_ip()
        .context("captain service requires an IP listener")?
        .port();
    let advertisement = CaptainAdvertisement {
        protocol: 1,
        id: config.machine.id,
        name: config.machine.name.clone(),
        host: config.machine.host(),
        port,
        fingerprint: identity.fingerprint,
        ssh_public_key: identity.public_key,
    };
    let mut publisher = publish(&advertisement)?;
    eprintln!(
        "Fleet captain {} listening on port {port}",
        config.machine.host()
    );
    let shutdown = Arc::new(AtomicBool::new(false));
    let signal = shutdown.clone();
    ctrlc::set_handler(move || signal.store(true, Ordering::SeqCst))
        .context("install captain shutdown handler")?;
    while !shutdown.load(Ordering::SeqCst) {
        if let Some(status) = publisher.try_wait().context("check mDNS publisher")? {
            bail!("native mDNS publisher exited unexpectedly with {status}");
        }
        let Some(mut request) = server.recv_timeout(Duration::from_millis(250))? else {
            continue;
        };
        let result = handle_request(paths, &advertisement, &mut request);
        let response = match result {
            Ok(response) => response,
            Err(error) => {
                crate::logging::detail(paths, "captain-request", format!("{error:#}"));
                eprintln!("Fleet captain request failed. Run `fleet logs` for details.");
                let message = error.to_string();
                json_response(StatusCode(400), &serde_json::json!({"error": message}))?
            }
        };
        let _ = request.respond(response);
    }
    let _ = publisher.kill();
    let _ = publisher.wait();
    Ok(())
}

fn handle_request(
    paths: &StatePaths,
    advertisement: &CaptainAdvertisement,
    request: &mut tiny_http::Request,
) -> Result<Response<std::io::Cursor<Vec<u8>>>> {
    match (request.method(), request.url()) {
        (&Method::Get, "/v1/identity") => json_response(StatusCode(200), advertisement),
        (&Method::Post, "/v1/join") => {
            let peer_ip = request.remote_addr().map(|address| address.ip());
            let body = read_body(request)?;
            let signed: SignedRequest =
                serde_json::from_slice(&body).context("decode join request")?;
            let payload = serde_json::to_vec(&signed.payload)?;
            let registration: JoinRequest =
                serde_json::from_value(signed.payload).context("decode signed join payload")?;
            identity::verify(
                &registration.machine.public_identity,
                &payload,
                &signed.signature,
            )
            .context("join request was not signed by the member")?;
            validate_registration(&registration.machine)?;
            let members = skill::load_members(paths)?;
            validate_topology_conflicts(advertisement, &members, &registration.machine)?;
            validate_existing_pin(&members, &registration.machine)?;
            if let Err(error) = verify_member(paths, &registration.machine, peer_ip) {
                let _ = crate::ssh_client::regenerate(paths);
                return Err(error.context("captain could not verify passwordless SSH"));
            }
            skill::save_member(paths, &registration.machine)?;
            crate::ssh_client::regenerate(paths)?;
            json_response(StatusCode(201), &serde_json::json!({"joined": true}))
        }
        (&Method::Post, "/v1/leave") => {
            let body = read_body(request)?;
            let signed: SignedRequest =
                serde_json::from_slice(&body).context("decode leave request")?;
            let payload = serde_json::to_vec(&signed.payload)?;
            let leave: LeaveRequest =
                serde_json::from_value(signed.payload).context("decode signed leave payload")?;
            let members = skill::load_members(paths)?;
            let member = members
                .iter()
                .find(|member| member.id == leave.id)
                .context("member is not registered with this captain")?;
            identity::verify(&member.public_identity, &payload, &signed.signature)
                .context("leave request was not signed by the registered member")?;
            skill::remove_member(paths, leave.id)?;
            crate::ssh_client::regenerate(paths)?;
            json_response(StatusCode(200), &serde_json::json!({"left": true}))
        }
        _ => json_response(StatusCode(404), &serde_json::json!({"error": "not found"})),
    }
}

fn read_body(request: &mut tiny_http::Request) -> Result<Vec<u8>> {
    let length = request.body_length().unwrap_or(0);
    if length > 64 * 1024 {
        bail!("request body is too large");
    }
    let mut body = Vec::with_capacity(length);
    request
        .as_reader()
        .take(64 * 1024 + 1)
        .read_to_end(&mut body)?;
    if body.len() > 64 * 1024 {
        bail!("request body is too large");
    }
    Ok(body)
}

fn validate_registration(machine: &Machine) -> Result<()> {
    if machine.id.is_nil() {
        bail!("member identity must not be nil");
    }
    crate::state::validate_machine_name(&machine.name)?;
    if machine.ssh_user.is_empty()
        || machine.ssh_user.len() > 128
        || !machine
            .ssh_user
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        bail!("invalid SSH username");
    }
    crate::identity::public_key_material(&machine.public_identity)
        .context("invalid machine identity")?;
    let host_key = machine
        .ssh_host_key
        .as_deref()
        .context("member did not provide an SSH host key")?;
    crate::identity::public_key_material(host_key)
        .context("member did not provide a valid Ed25519 SSH host key")?;
    for (label, value) in [
        ("operating system", &machine.os),
        ("architecture", &machine.arch),
    ] {
        if value.is_empty()
            || value.len() > 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        {
            bail!("invalid {label}");
        }
    }
    if machine.tools.len() > crate::cli::Tool::ALL.len() {
        bail!("invalid tool inventory");
    }
    for (index, state) in machine.tools.iter().enumerate() {
        if machine.tools[..index]
            .iter()
            .any(|previous| previous.tool == state.tool)
        {
            bail!("tool inventory contains duplicate entries");
        }
    }
    Ok(())
}

fn validate_existing_pin(existing: &[Machine], candidate: &Machine) -> Result<()> {
    let Some(pinned) = existing.iter().find(|machine| machine.id == candidate.id) else {
        return Ok(());
    };
    if pinned.name != candidate.name {
        bail!(
            "member identity {} is pinned to {}.local, not {}.local",
            candidate.id,
            pinned.name,
            candidate.name
        );
    }
    if !same_public_key(&pinned.public_identity, &candidate.public_identity)? {
        bail!("member Fleet identity changed; refusing registration");
    }
    if !same_optional_public_key(
        pinned.ssh_host_key.as_deref(),
        candidate.ssh_host_key.as_deref(),
    )? {
        bail!("member SSH host key changed; refusing registration");
    }
    Ok(())
}

fn validate_topology_conflicts(
    captain: &CaptainAdvertisement,
    existing: &[Machine],
    candidate: &Machine,
) -> Result<()> {
    if candidate.id == captain.id {
        bail!("member identity conflicts with the captain");
    }
    if candidate.name == captain.name {
        bail!("the captain already uses {}.local", candidate.name);
    }
    if same_public_key(&candidate.public_identity, &captain.ssh_public_key)? {
        bail!("member Fleet identity conflicts with the captain");
    }

    for member in existing {
        if member.id != candidate.id && member.name == candidate.name {
            bail!("a different member already uses {}.local", candidate.name);
        }
        if member.id != candidate.id
            && same_public_key(&member.public_identity, &candidate.public_identity)?
        {
            bail!(
                "member Fleet identity is already registered as {}.local",
                member.name
            );
        }
        if member.id != candidate.id
            && same_optional_public_key(
                member.ssh_host_key.as_deref(),
                candidate.ssh_host_key.as_deref(),
            )?
        {
            bail!(
                "member SSH host key is already registered as {}.local",
                member.name
            );
        }
    }
    Ok(())
}

fn same_public_key(left: &str, right: &str) -> Result<bool> {
    Ok(identity::public_key_material(left)? == identity::public_key_material(right)?)
}

fn same_optional_public_key(left: Option<&str>, right: Option<&str>) -> Result<bool> {
    match (left, right) {
        (Some(left), Some(right)) => same_public_key(left, right),
        (None, None) => Ok(true),
        _ => Ok(false),
    }
}

#[derive(Debug, PartialEq, Eq)]
struct SshVerificationTarget {
    connect_host: String,
    host_key_alias: String,
}

fn ssh_verification_target(machine: &Machine, peer_ip: Option<IpAddr>) -> SshVerificationTarget {
    let host = machine.host();
    SshVerificationTarget {
        connect_host: peer_ip.map_or_else(|| host.clone(), |address| address.to_string()),
        host_key_alias: host,
    }
}

fn verify_member(paths: &StatePaths, machine: &Machine, peer_ip: Option<IpAddr>) -> Result<()> {
    let host_key = machine
        .ssh_host_key
        .as_deref()
        .context("missing SSH host key")?;
    let mut fields = host_key.split_whitespace();
    let algorithm = fields.next().context("missing SSH host-key algorithm")?;
    let encoded = fields.next().context("missing SSH host-key body")?;
    let host = machine.host();
    let desired = format!("{host} {algorithm} {encoded}");
    let existing = std::fs::read_to_string(paths.known_hosts()).unwrap_or_default();
    let mut lines: Vec<_> = existing
        .lines()
        .filter(|line| !line.starts_with(&format!("{host} ")))
        .map(str::to_owned)
        .collect();
    lines.push(desired);
    let mut next = lines.join("\n");
    next.push('\n');
    crate::state::atomic_write(&paths.known_hosts(), next.as_bytes(), 0o600)?;

    let identity = identity::ensure(paths)?;
    let target = ssh_verification_target(machine, peer_ip);
    let destination = format!("{}@{host}", machine.ssh_user);
    let mut command = Command::new("ssh");
    command
        .arg("-i")
        .arg(&identity.private_key)
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=3",
            "-o",
            "StrictHostKeyChecking=yes",
        ])
        .arg("-o")
        .arg(format!("HostKeyAlias={}", target.host_key_alias))
        .arg("-o")
        .arg(format!(
            "UserKnownHostsFile={}",
            paths.known_hosts().display()
        ))
        .arg("-l")
        .arg(&machine.ssh_user)
        .arg(&target.connect_host)
        .arg("true");
    retry_transient_ssh(
        || {
            let Some(output) = command_output_with_timeout(&mut command, Duration::from_secs(3))?
            else {
                bail!(
                    "failed to connect to {destination}: SSH verification timed out after 3 seconds"
                );
            };
            if output.status.success() {
                return Ok(());
            }
            let detail = String::from_utf8_lossy(&output.stderr);
            let detail = detail.trim();
            if detail.is_empty() {
                bail!(
                    "failed to connect to {destination}: SSH exited with {}",
                    output.status
                );
            }
            bail!("failed to connect to {destination}: {detail}")
        },
        Duration::from_secs(15),
        Duration::from_millis(250),
    )
}

fn command_output_with_timeout(command: &mut Command, timeout: Duration) -> Result<Option<Output>> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("start timed command")?;
    let started = Instant::now();
    while started.elapsed() < timeout {
        if child.try_wait()?.is_some() {
            return child
                .wait_with_output()
                .map(Some)
                .context("read command output");
        }
        thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill();
    let _ = child.wait();
    Ok(None)
}

fn retry_transient_ssh<T>(
    mut attempt: impl FnMut() -> Result<T>,
    deadline: Duration,
    retry_delay: Duration,
) -> Result<T> {
    let started = Instant::now();
    loop {
        match attempt() {
            Ok(value) => return Ok(value),
            Err(error) => {
                let detail = format!("{error:#}");
                let transient = [
                    "No route to host",
                    "Connection refused",
                    "Connection timed out",
                    "Operation timed out",
                    "SSH verification timed out",
                ]
                .iter()
                .any(|needle| detail.contains(needle));
                if !transient || started.elapsed() >= deadline {
                    return Err(error);
                }
                thread::sleep(retry_delay);
            }
        }
    }
}

fn json_response<T: Serialize>(
    status: StatusCode,
    value: &T,
) -> Result<Response<std::io::Cursor<Vec<u8>>>> {
    let bytes = serde_json::to_vec(value)?;
    Ok(Response::from_data(bytes)
        .with_status_code(status)
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap()))
}

fn publish(advertisement: &CaptainAdvertisement) -> Result<Child> {
    let port = advertisement.port.to_string();
    let id = format!("id={}", advertisement.id);
    let fingerprint = format!("fp={}", advertisement.fingerprint);
    let mut command = if cfg!(target_os = "macos") {
        let mut command = Command::new("dns-sd");
        command.args([
            "-R",
            &advertisement.name,
            SERVICE_TYPE,
            "local",
            &port,
            "txtvers=1",
            &id,
            &fingerprint,
        ]);
        command
    } else {
        let mut command = Command::new("avahi-publish-service");
        command.args([
            &advertisement.name,
            SERVICE_TYPE,
            &port,
            "txtvers=1",
            &id,
            &fingerprint,
        ]);
        command
    };
    command
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .context("publish Fleet captain with native mDNS service")
}

pub fn register(paths: &StatePaths, endpoint: &str, machine: &Machine) -> Result<()> {
    signed_post(
        paths,
        endpoint,
        "/v1/join",
        &JoinRequest {
            machine: machine.clone(),
        },
    )
}

pub fn notify_leave(paths: &StatePaths, endpoint: &str, id: Uuid) -> Result<()> {
    signed_post(paths, endpoint, "/v1/leave", &LeaveRequest { id })
}

fn signed_post<T: Serialize>(
    paths: &StatePaths,
    endpoint: &str,
    path: &str,
    body: &T,
) -> Result<()> {
    let payload = serde_json::to_value(body)?;
    let bytes = serde_json::to_vec(&payload)?;
    let identity = identity::ensure(paths)?;
    let signature = identity::sign(&identity.private_key, &bytes)?;
    post(endpoint, path, &SignedRequest { payload, signature })
}

fn post<T: Serialize>(endpoint: &str, path: &str, body: &T) -> Result<()> {
    let endpoint = endpoint.trim_end_matches('/');
    let base = if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
        endpoint.to_owned()
    } else {
        format!("http://{endpoint}")
    };
    let url = format!("{base}{path}");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;
    let response = client
        .post(&url)
        .json(body)
        .send()
        .with_context(|| format!("send captain request to {endpoint}"))?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let body = response.text().unwrap_or_default();
    let reason = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value.get("error")?.as_str().map(str::to_owned))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("HTTP {status}"));
    bail!("captain rejected request: {reason}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Color;
    use std::sync::atomic::AtomicUsize;

    const KEY_ONE: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElmqI4v+7cZFSmB7soOSl3vymQTl8v7/15ZnHH2DA4d";
    const KEY_TWO: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIChI5Jpps7nIfSzIzaEtYx3aDU8IrgbGEmIcKJJE86la";

    fn valid_machine() -> Machine {
        Machine {
            id: Uuid::new_v4(),
            name: "emerald".into(),
            color: Color::Emerald,
            ssh_user: "developer".into(),
            os: "linux".into(),
            arch: "aarch64".into(),
            tools: vec![],
            public_identity: KEY_ONE.into(),
            ssh_host_key: Some(KEY_TWO.into()),
        }
    }

    fn captain_advertisement() -> CaptainAdvertisement {
        CaptainAdvertisement {
            protocol: 1,
            id: Uuid::new_v4(),
            name: "obsidian".into(),
            host: "obsidian.local".into(),
            port: 42170,
            fingerprint: "SHA256:test".into(),
            ssh_public_key: KEY_TWO.into(),
        }
    }

    #[test]
    fn registration_schema_rejects_untrusted_control_characters() {
        let mut machine = valid_machine();
        assert!(validate_registration(&machine).is_ok());
        machine.os = "linux\nHost attacker".into();
        assert!(validate_registration(&machine).is_err());
        machine = valid_machine();
        machine.ssh_user = "dev Match all".into();
        assert!(validate_registration(&machine).is_err());
    }

    #[test]
    fn existing_member_identity_and_host_key_are_pinned() {
        let pinned = valid_machine();
        assert!(validate_existing_pin(std::slice::from_ref(&pinned), &pinned).is_ok());

        let mut changed = pinned.clone();
        changed.ssh_host_key = Some(KEY_ONE.into());
        assert!(
            validate_existing_pin(std::slice::from_ref(&pinned), &changed)
                .unwrap_err()
                .to_string()
                .contains("host key changed")
        );

        changed = pinned.clone();
        changed.public_identity = KEY_TWO.into();
        assert!(
            validate_existing_pin(std::slice::from_ref(&pinned), &changed)
                .unwrap_err()
                .to_string()
                .contains("Fleet identity changed")
        );

        changed = pinned.clone();
        changed.public_identity.push_str(" another-comment");
        changed.ssh_host_key = changed
            .ssh_host_key
            .map(|key| format!("{key} another-comment"));
        assert!(validate_existing_pin(std::slice::from_ref(&pinned), &changed).is_ok());
    }

    #[test]
    fn registration_rejects_every_topology_identity_collision() {
        let captain = captain_advertisement();
        let existing = valid_machine();
        let mut candidate = valid_machine();
        candidate.id = Uuid::new_v4();
        candidate.name = "ruby".into();
        candidate.public_identity = KEY_TWO.into();
        candidate.ssh_host_key = Some(KEY_ONE.into());

        assert!(
            validate_topology_conflicts(&captain, std::slice::from_ref(&existing), &candidate)
                .unwrap_err()
                .to_string()
                .contains("captain")
        );

        candidate.public_identity = KEY_ONE.into();
        candidate.ssh_host_key = Some(KEY_TWO.into());
        assert!(
            validate_topology_conflicts(&captain, std::slice::from_ref(&existing), &candidate)
                .unwrap_err()
                .to_string()
                .contains("already registered")
        );

        candidate.public_identity = KEY_TWO.into();
        candidate.name = captain.name.clone();
        assert!(
            validate_topology_conflicts(&captain, &[], &candidate)
                .unwrap_err()
                .to_string()
                .contains("captain already uses")
        );
    }

    #[test]
    fn rejected_registration_is_returned_once_with_the_captains_reason() {
        let server = Server::http("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", server.server_addr());
        let requests = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let request_count = requests.clone();
        let server_stop = stop.clone();
        let handle = thread::spawn(move || {
            while !server_stop.load(Ordering::SeqCst) {
                if let Some(request) = server.recv_timeout(Duration::from_millis(50)).unwrap() {
                    request_count.fetch_add(1, Ordering::SeqCst);
                    request
                        .respond(
                            Response::from_string(r#"{"error":"SSH host key mismatch"}"#)
                                .with_status_code(StatusCode(400)),
                        )
                        .unwrap();
                }
            }
        });

        let error = post(&endpoint, "/v1/join", &serde_json::json!({})).unwrap_err();
        stop.store(true, Ordering::SeqCst);
        handle.join().unwrap();

        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert!(error.to_string().contains("SSH host key mismatch"));
    }

    #[test]
    fn ssh_verification_process_has_a_hard_deadline() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 10"]);
        let started = Instant::now();
        assert!(
            command_output_with_timeout(&mut command, Duration::from_millis(50))
                .unwrap()
                .is_none()
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn ssh_verification_uses_join_peer_while_pinning_the_fleet_hostname() {
        let machine = valid_machine();
        let target = ssh_verification_target(&machine, Some("192.168.1.69".parse().unwrap()));

        assert_eq!(target.connect_host, "192.168.1.69");
        assert_eq!(target.host_key_alias, "emerald.local");
    }

    #[test]
    fn ssh_verification_retries_a_temporarily_unreachable_member() {
        let attempts = AtomicUsize::new(0);
        let result: Result<()> = retry_transient_ssh(
            || {
                let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                if attempt < 2 {
                    bail!("ssh: connect to host 192.168.1.69 port 22: No route to host");
                }
                Ok(())
            },
            Duration::from_secs(1),
            Duration::ZERO,
        );

        assert!(result.is_ok());
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn ssh_verification_does_not_retry_security_or_authentication_failures() {
        let attempts = AtomicUsize::new(0);
        let result: Result<()> = retry_transient_ssh(
            || {
                attempts.fetch_add(1, Ordering::SeqCst);
                bail!("Host key verification failed")
            },
            Duration::from_secs(1),
            Duration::ZERO,
        );

        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }
}
