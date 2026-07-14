use crate::discovery::{CaptainAdvertisement, SERVICE_TYPE};
use crate::identity;
use crate::skill;
use crate::state::{Machine, Role, StatePaths};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
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
                eprintln!("registration request failed: {error:#}");
                json_response(
                    StatusCode(400),
                    &serde_json::json!({"error": error.to_string()}),
                )?
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
            let body = read_body(request)?;
            let registration: JoinRequest =
                serde_json::from_slice(&body).context("decode join request")?;
            validate_registration(&registration.machine)?;
            let members = skill::load_members(paths)?;
            if members.iter().any(|member| {
                member.name == registration.machine.name && member.id != registration.machine.id
            }) {
                bail!(
                    "a different member already uses {}.local",
                    registration.machine.name
                );
            }
            validate_existing_pin(&members, &registration.machine)?;
            if let Err(error) = verify_member(paths, &registration.machine) {
                let _ = crate::ssh_client::regenerate(paths);
                return Err(error.context("captain could not verify passwordless SSH"));
            }
            skill::save_member(paths, &registration.machine)?;
            crate::ssh_client::regenerate(paths)?;
            json_response(StatusCode(201), &serde_json::json!({"joined": true}))
        }
        (&Method::Post, "/v1/leave") => {
            let body = read_body(request)?;
            let leave: LeaveRequest =
                serde_json::from_slice(&body).context("decode leave request")?;
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
    if pinned.public_identity != candidate.public_identity {
        bail!("member Fleet identity changed; refusing registration");
    }
    if pinned.ssh_host_key != candidate.ssh_host_key {
        bail!("member SSH host key changed; refusing registration");
    }
    Ok(())
}

fn verify_member(paths: &StatePaths, machine: &Machine) -> Result<()> {
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
    let destination = format!("{}@{host}", machine.ssh_user);
    let mut last = None;
    for _ in 0..8 {
        let result = Command::new("ssh")
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
            .arg(format!(
                "UserKnownHostsFile={}",
                paths.known_hosts().display()
            ))
            .arg(&destination)
            .arg("true")
            .status();
        match result {
            Ok(status) if status.success() => return Ok(()),
            Ok(status) => last = Some(format!("SSH exited with {status}")),
            Err(error) => last = Some(error.to_string()),
        }
        thread::sleep(Duration::from_secs(1));
    }
    bail!(
        "failed to connect to {destination}: {}",
        last.unwrap_or_else(|| "unknown SSH error".into())
    )
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

pub fn register(endpoint: &str, machine: &Machine) -> Result<()> {
    post(
        endpoint,
        "/v1/join",
        &JoinRequest {
            machine: machine.clone(),
        },
    )
}

pub fn notify_leave(endpoint: &str, id: Uuid) -> Result<()> {
    post(endpoint, "/v1/leave", &LeaveRequest { id })
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
        .timeout(std::time::Duration::from_secs(2))
        .build()?;
    let mut last_error = None;
    for _ in 0..8 {
        match client
            .post(&url)
            .json(body)
            .send()
            .and_then(|response| response.error_for_status())
        {
            Ok(_) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err(last_error.context("captain request failed")?.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Color;

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
    }
}
