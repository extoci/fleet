use std::{
    fs,
    io::{self, BufRead, BufReader, IsTerminal, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    process::Command,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD_NO_PAD};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{config, discovery, ui::Ui};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessRecord {
    #[serde(default)]
    pub device_id: String,
    pub name: String,
    pub fingerprint: String,
    pub key: String,
    pub address: String,
    pub authorized_at: u64,
    #[serde(default)]
    pub managed: bool,
    #[serde(default)]
    pub marker: String,
}

struct KeyWrite {
    inserted: bool,
    managed: bool,
    marker: String,
}

#[derive(Debug)]
struct SshFailure {
    code: i32,
    message: String,
}

impl std::fmt::Display for SshFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SshFailure {}

pub fn exit_code(error: &anyhow::Error) -> Option<i32> {
    error
        .downcast_ref::<SshFailure>()
        .map(|failure| failure.code)
}

pub fn private_key() -> Result<PathBuf> {
    Ok(config::home()?.join(".ssh/id_ed25519_fleet"))
}

pub fn ensure_key() -> Result<PathBuf> {
    let key = private_key()?;
    if key.exists() {
        return Ok(key);
    }
    let parent = key.parent().context("invalid SSH key path")?;
    fs::create_dir_all(parent).context("create ~/.ssh")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    let status = Command::new("ssh-keygen")
        .args(["-t", "ed25519", "-f"])
        .arg(&key)
        .args(["-N", "", "-C", "fleet", "-q"])
        .status()
        .context("run ssh-keygen")?;
    if !status.success() {
        bail!("ssh-keygen failed")
    }
    Ok(key)
}

pub fn keygen(ui: Ui) -> Result<()> {
    let existed = private_key()?.exists();
    let key = ensure_key()?;
    if existed {
        ui.muted(format!("Fleet key already exists · {}", key.display()));
    } else {
        ui.success(format!("Created Fleet key · {}", key.display()));
    }
    Ok(())
}

pub fn print_public_key() -> Result<()> {
    let key = ensure_key()?;
    print!(
        "{}",
        fs::read_to_string(key.with_extension("pub")).context("read public key")?
    );
    Ok(())
}

pub fn pair(host: &str, expected_fingerprint: Option<&str>, ui: Ui) -> Result<()> {
    let peer = discovery::resolve(host, Duration::from_secs(2))?
        .with_context(|| format!("Fleet device `{host}` was not found; run `fleet ls`"))?;
    let key = fetch_public_key(&peer)?;
    let fingerprint = fingerprint(&key)?;
    if let Some(advertised) = &peer.fingerprint
        && advertised != &fingerprint
    {
        bail!(
            "{}'s advertised identity changed; refusing access",
            peer.name
        )
    }
    if let Some(expected) = expected_fingerprint {
        if expected != fingerprint {
            bail!("fingerprint mismatch: expected {expected}, received {fingerprint}")
        }
    } else {
        if !io::stdin().is_terminal() {
            bail!("confirmation is required; rerun with `--fingerprint {fingerprint}`")
        }
        eprintln!(
            "Allow {} at {} to SSH into this device?\n  Key: {}",
            peer.name,
            peer.connection_address()
                .map(|address| address.to_string())
                .unwrap_or_else(|| peer.hostname.clone()),
            fingerprint
        );
        if !confirm("Continue? [y/N] ")? {
            bail!("access was not granted")
        }
    }
    authorize_peer(&peer, &key)?;
    ui.success(format!(
        "{} can now connect to this device without a password",
        peer.name
    ));
    Ok(())
}

pub fn copy_key(host: &str, user: Option<&str>, ui: Ui) -> Result<()> {
    let key = ensure_key()?.with_extension("pub");
    let target = target(host, user)?;
    let status = Command::new("ssh-copy-id")
        .arg("-i")
        .arg(key)
        .arg(&target)
        .status()
        .context("run ssh-copy-id (install OpenSSH client tools if it is missing)")?;
    if !status.success() {
        bail!("could not authorize Fleet's key on {target}")
    }
    ui.success(format!("Paired with {target}"));
    ui.muted(format!("  Connect with: fleet connect {host}"));
    Ok(())
}

pub fn allow_peer(peer: &discovery::Peer) -> Result<()> {
    let remote_key = fetch_public_key(peer)?;
    if let Some(advertised) = &peer.fingerprint
        && advertised != &fingerprint(&remote_key)?
    {
        bail!(
            "{}'s advertised identity changed; refusing access",
            peer.name
        )
    }
    authorize_peer(peer, &remote_key)
}

fn authorize_peer(peer: &discovery::Peer, key: &str) -> Result<()> {
    let address = peer
        .connection_address()
        .map(|address| address.to_string())
        .unwrap_or_else(|| peer.hostname.clone());
    authorize_key(key, &peer.device_id, &peer.name, &address)
}

fn fetch_public_key(peer: &discovery::Peer) -> Result<String> {
    let address = peer
        .connection_address()
        .context("peer did not advertise an address")?;
    let socket = SocketAddr::new(address, peer.pair_port);
    let mut stream = TcpStream::connect_timeout(&socket, Duration::from_secs(3))
        .with_context(|| format!("read {}'s Fleet identity at {socket}", peer.name))?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    writeln!(stream, "KEY")?;
    let mut response = String::new();
    BufReader::new(stream)
        .take(16 * 1024 + 1)
        .read_line(&mut response)?;
    if response.len() > 16 * 1024 {
        bail!("Fleet public key response is too large")
    }
    parse_key_response(&response)
}

pub fn peer_fingerprint(peer: &discovery::Peer) -> Result<String> {
    let key = fetch_public_key(peer)?;
    let fingerprint = fingerprint(&key)?;
    if let Some(advertised) = &peer.fingerprint
        && advertised != &fingerprint
    {
        bail!("{}'s advertised identity changed", peer.name)
    }
    Ok(fingerprint)
}

pub fn start_key_listener(port: u16) -> Result<()> {
    let mut listeners = Vec::new();
    let mut last_error = None;
    for address in ["::", "0.0.0.0"] {
        match TcpListener::bind((address, port)) {
            Ok(listener) => listeners.push(listener),
            Err(error)
                if error.kind() == std::io::ErrorKind::AddrInUse && !listeners.is_empty() => {}
            Err(error) if !listeners.is_empty() => {
                eprintln!("Fleet identity listener unavailable on {address}: {error}");
            }
            Err(error) => last_error = Some(error),
        }
    }
    if listeners.is_empty() {
        let detail = last_error
            .map(|error| format!(": {error}"))
            .unwrap_or_default();
        bail!("could not serve the Fleet public key on port {port}{detail}")
    }
    for listener in listeners {
        start_key_listener_thread(listener);
    }
    Ok(())
}

fn start_key_listener_thread(listener: TcpListener) {
    static ACTIVE: AtomicUsize = AtomicUsize::new(0);
    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    if ACTIVE.fetch_add(1, Ordering::Relaxed) >= 64 {
                        ACTIVE.fetch_sub(1, Ordering::Relaxed);
                        drop(stream);
                        continue;
                    }
                    thread::spawn(|| {
                        struct ActiveGuard;
                        impl Drop for ActiveGuard {
                            fn drop(&mut self) {
                                ACTIVE.fetch_sub(1, Ordering::Relaxed);
                            }
                        }
                        let _guard = ActiveGuard;
                        if let Err(error) = serve_public_key(stream) {
                            eprintln!("Fleet identity request rejected: {error:#}");
                        }
                    });
                }
                Err(error) => eprintln!("Fleet identity listener error: {error}"),
            }
        }
    });
}

fn serve_public_key(mut stream: TcpStream) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    let mut request = String::new();
    BufReader::new(stream.try_clone()?)
        .take(16 * 1024 + 1)
        .read_line(&mut request)?;
    if request.len() > 16 * 1024 {
        bail!("Fleet identity request is too large")
    }
    validate_identity_request(&request)?;
    writeln!(stream, "OK {}", public_key()?)?;
    Ok(())
}

fn validate_identity_request(request: &str) -> Result<()> {
    if request.trim() != "KEY" {
        bail!("unsupported Fleet identity request")
    }
    Ok(())
}

fn parse_key_response(response: &str) -> Result<String> {
    let key = response
        .strip_prefix("OK ")
        .context("peer did not provide a Fleet public key")?
        .trim();
    validate_public_key(key)?;
    Ok(key.to_string())
}

fn public_key() -> Result<String> {
    let path = ensure_key()?.with_extension("pub");
    Ok(fs::read_to_string(path)?.trim().to_string())
}

pub fn public_fingerprint() -> Result<String> {
    fingerprint(&public_key()?)
}

#[derive(Serialize)]
struct Identity {
    device_id: String,
    name: String,
    user: String,
    fingerprint: String,
}

pub fn print_identity(json: bool, ui: Ui) -> Result<()> {
    let config = config::load()?;
    let color = config.color;
    let identity = Identity {
        device_id: config.device_id,
        name: config.name,
        user: config.user,
        fingerprint: public_fingerprint()?,
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&identity)?);
    } else {
        println!("{}  {}\n", ui.diamond(color), identity.name);
        println!("  Device ID    {}", identity.device_id);
        println!("  SSH user     {}", identity.user);
        println!("  Fleet key    {}", identity.fingerprint);
        ui.muted("Compare this fingerprint on the device granting access.");
    }
    Ok(())
}

fn fingerprint(key: &str) -> Result<String> {
    validate_public_key(key)?;
    let encoded = key
        .split_whitespace()
        .nth(1)
        .context("public key is missing its data")?;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("public key data is not valid base64")?;
    Ok(format!(
        "SHA256:{}",
        STANDARD_NO_PAD.encode(Sha256::digest(blob))
    ))
}

fn access_path() -> Result<PathBuf> {
    Ok(config::dir()?.join("access.json"))
}

fn lock_access() -> Result<fs::File> {
    let dir = config::dir()?;
    fs::create_dir_all(&dir)?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("access.lock"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.lock_exclusive().context("lock Fleet access records")?;
    Ok(file)
}

pub fn access_records() -> Result<Vec<AccessRecord>> {
    let path = access_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let source = fs::read_to_string(&path)
        .with_context(|| format!("read access records at {}", path.display()))?;
    serde_json::from_str(&source).context("invalid Fleet access records")
}

fn save_access_records(records: &[AccessRecord]) -> Result<()> {
    let dir = config::dir()?;
    fs::create_dir_all(&dir)?;
    let path = access_path()?;
    let temporary = dir.join(format!("access.json.tmp.{}", std::process::id()));
    fs::write(&temporary, serde_json::to_vec_pretty(records)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(temporary, path).context("commit Fleet access records")
}

fn authorize_key(key: &str, device_id: &str, device: &str, address: &str) -> Result<()> {
    static AUTHORIZED_KEYS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = AUTHORIZED_KEYS_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| anyhow::anyhow!("authorized_keys lock is poisoned"))?;
    let _file_lock = lock_access()?;
    validate_public_key(key)?;
    let new_fingerprint = fingerprint(key)?;
    let mut records = access_records()?;
    let previous = records.iter().find(|existing| {
        (!device_id.is_empty() && existing.device_id == device_id)
            || existing.name.eq_ignore_ascii_case(device)
    });
    if let Some(existing) = previous
        && existing.fingerprint != new_fingerprint
    {
        bail!(
            "{}'s key changed from {} to {}; revoke it and verify the device before pairing again",
            existing.name,
            existing.fingerprint,
            new_fingerprint
        )
    }
    if let Some(existing) = records.iter().find(|existing| {
        existing.fingerprint == new_fingerprint
            && !device_id.is_empty()
            && existing.device_id != device_id
    }) {
        bail!(
            "this key is already recorded for {}; Fleet device keys must not be shared",
            existing.name
        )
    }
    let ssh_dir = config::home()?.join(".ssh");
    fs::create_dir_all(&ssh_dir)?;
    let path = ssh_dir.join("authorized_keys");
    let write = write_authorized_key(&path, key, device_id, device)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&ssh_dir, fs::Permissions::from_mode(0o700))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    let record = AccessRecord {
        device_id: device_id.to_string(),
        name: device.to_string(),
        fingerprint: new_fingerprint,
        key: key.split_whitespace().take(2).collect::<Vec<_>>().join(" "),
        address: address.to_string(),
        authorized_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        managed: write.managed,
        marker: write.marker.clone(),
    };
    records.retain(|existing| {
        existing.name != record.name
            && (record.device_id.is_empty() || existing.device_id != record.device_id)
    });
    records.push(record);
    records.sort_by(|a, b| a.name.cmp(&b.name));
    if let Err(error) = save_access_records(&records) {
        if write.inserted {
            let _ = remove_authorized_key(key, &write.marker, device_id, device);
        }
        return Err(error);
    }
    Ok(())
}

fn write_authorized_key(
    path: &std::path::Path,
    key: &str,
    device_id: &str,
    device: &str,
) -> Result<KeyWrite> {
    validate_public_key(key)?;
    let old = fs::read_to_string(path).unwrap_or_default();
    let material = key.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
    let material_fields = material.split_whitespace().collect::<Vec<_>>();
    let existing = old.lines().find(|line| {
        line.split_whitespace()
            .collect::<Vec<_>>()
            .windows(2)
            .any(|fields| fields == material_fields)
    });
    if let Some(existing) = existing {
        let marker = existing
            .split_whitespace()
            .find(|token| token.starts_with("fleet:"))
            .unwrap_or("")
            .to_string();
        Ok(KeyWrite {
            inserted: false,
            managed: !marker.is_empty(),
            marker,
        })
    } else {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        if !old.is_empty() && !old.ends_with('\n') {
            writeln!(file)?;
        }
        let device = device
            .chars()
            .take_while(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
            .take(63)
            .collect::<String>();
        let marker = if device_id.is_empty() {
            format!("fleet:{device}")
        } else {
            format!("fleet:{device_id}:{device}")
        };
        writeln!(file, "{material} {marker}")?;
        Ok(KeyWrite {
            inserted: true,
            managed: true,
            marker,
        })
    }
}

pub fn print_access(json: bool, ui: Ui) -> Result<()> {
    let records = access_records()?;
    if json {
        println!("{}", serde_json::to_string_pretty(&records)?);
    } else if records.is_empty() {
        ui.muted("No Fleet devices have been granted passwordless access.");
    } else {
        println!("Fleet SSH access\n");
        for record in records {
            println!("  {:<18} {}", record.name, record.fingerprint);
            ui.muted(format!("    {}", record.address));
        }
    }
    Ok(())
}

pub fn revoke_access(name: &str, ui: Ui) -> Result<()> {
    static AUTHORIZED_KEYS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = AUTHORIZED_KEYS_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| anyhow::anyhow!("authorized_keys lock is poisoned"))?;
    let _file_lock = lock_access()?;
    let mut records = access_records()?;
    let index = records
        .iter()
        .position(|record| record.name.eq_ignore_ascii_case(name))
        .with_context(|| format!("`{name}` does not have recorded Fleet access"))?;
    let record = records.remove(index);
    if record.managed
        && !remove_authorized_key(&record.key, &record.marker, &record.device_id, &record.name)?
    {
        bail!(
            "Fleet's access marker for {} was not found; no access record was changed",
            record.name
        )
    }
    save_access_records(&records)?;
    if record.managed {
        ui.success(format!("Revoked passwordless access for {}", record.name));
    } else {
        ui.muted(format!(
            "Removed Fleet's record for {}, but its key predated Fleet and was left untouched",
            record.name
        ));
    }
    Ok(())
}

fn remove_authorized_key(
    key: &str,
    recorded_marker: &str,
    device_id: &str,
    name: &str,
) -> Result<bool> {
    let mut path = config::home()?.join(".ssh/authorized_keys");
    if !path.exists() {
        return Ok(false);
    }
    if fs::symlink_metadata(&path)?.file_type().is_symlink() {
        path = fs::canonicalize(&path).context("resolve authorized_keys symlink")?;
    }
    remove_authorized_key_at(&path, key, recorded_marker, device_id, name)
}

fn remove_authorized_key_at(
    path: &std::path::Path,
    key: &str,
    recorded_marker: &str,
    device_id: &str,
    name: &str,
) -> Result<bool> {
    let old = fs::read_to_string(path)?;
    let fields = key.split_whitespace().collect::<Vec<_>>();
    let exact_marker = !recorded_marker.is_empty();
    let marker = if exact_marker {
        recorded_marker.to_string()
    } else if device_id.is_empty() {
        format!("fleet:{name}")
    } else {
        format!("fleet:{device_id}:")
    };
    let mut removed = false;
    let retained = old
        .split_inclusive('\n')
        .filter(|line| {
            let tokens = line.split_whitespace().collect::<Vec<_>>();
            let marked = if exact_marker || device_id.is_empty() {
                tokens.contains(&marker.as_str())
            } else {
                tokens.iter().any(|token| token.starts_with(&marker))
            };
            let matches = tokens.windows(2).any(|candidate| candidate == fields) && marked;
            removed |= matches;
            !matches
        })
        .collect::<String>();
    let temporary = path.with_extension(format!("fleet.tmp.{}", std::process::id()));
    fs::write(&temporary, retained)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(temporary, path).context("update authorized_keys")?;
    Ok(removed)
}

fn confirm(prompt: &str) -> Result<bool> {
    eprint!("{prompt}");
    io::stderr().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    Ok(matches!(
        answer.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

fn validate_public_key(key: &str) -> Result<()> {
    let fields = key.split_whitespace().collect::<Vec<_>>();
    if fields.len() < 2
        || fields[0] != "ssh-ed25519"
        || fields[1].len() > 8192
        || !fields[1]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"+/=".contains(&byte))
    {
        bail!("only valid Ed25519 public keys are accepted")
    }
    Ok(())
}

pub fn connect(
    host: &str,
    user: Option<&str>,
    extra: &[String],
    trust_host: bool,
    ui: Ui,
) -> Result<()> {
    let key = ensure_key()?;
    let (embedded_user, lookup_host) = host
        .split_once('@')
        .map_or((None, host), |(user, host)| (Some(user), host));
    let requested_user = user.or(embedded_user);
    if lookup_host.starts_with('-') || lookup_host.chars().any(char::is_control) {
        bail!("invalid SSH host")
    }
    let discovered = if !lookup_host.contains('.') || lookup_host.ends_with(".local") {
        discovery::resolve(lookup_host, Duration::from_secs(2))?
    } else {
        None
    };
    let (destination, ssh_user, port, device_id) = if let Some(peer) = discovered {
        if extra.is_empty() {
            ui.muted(format!(
                "{}  Connecting to {}…",
                ui.diamond(peer.color),
                peer.name
            ));
        }
        let address = peer
            .connection_address()
            .context("peer did not advertise an address")?;
        let ssh_user = requested_user.unwrap_or(&peer.user);
        if !valid_user(ssh_user) {
            bail!("invalid SSH user advertised by {}", peer.name)
        }
        (
            address.to_string(),
            ssh_user.to_string(),
            peer.port,
            (!peer.device_id.is_empty()).then_some(peer.device_id),
        )
    } else {
        (
            normalize_host(lookup_host),
            requested_user
                .map(str::to_string)
                .unwrap_or_else(config::default_user),
            22,
            None,
        )
    };
    if !valid_user(&ssh_user) {
        bail!("invalid SSH user")
    }
    let mut command = Command::new("ssh");
    let host_key_check = if trust_host {
        "accept-new"
    } else if io::stdin().is_terminal() {
        "ask"
    } else {
        "yes"
    };
    command
        .arg("-i")
        .arg(key)
        .args([
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            &format!("StrictHostKeyChecking={host_key_check}"),
        ])
        .arg("-l")
        .arg(ssh_user)
        .arg("-p")
        .arg(port.to_string());
    if let Some(device_id) = device_id {
        fs::create_dir_all(config::dir()?)?;
        let known_hosts = config::dir()?.join("known_hosts");
        command
            .arg("-o")
            .arg(format!("UserKnownHostsFile={}", known_hosts.display()))
            .arg("-o")
            .arg(format!("HostKeyAlias=fleet-{device_id}"));
    }
    command.arg("--").arg(destination).args(extra);
    let status = command.status().context("run ssh")?;
    if !status.success() {
        let local_name = config::load_optional()?
            .map(|config| config.name)
            .unwrap_or_else(|| "<this-device>".into());
        return Err(anyhow::Error::new(SshFailure {
            code: status.code().unwrap_or(1),
            message: format!(
                "SSH connection failed ({status}); check the password, or run `fleet pair {local_name}` on {lookup_host} to allow passwordless access"
            ),
        }));
    }
    Ok(())
}

pub fn valid_user(user: &str) -> bool {
    !user.is_empty()
        && user.len() <= 64
        && !user.starts_with('-')
        && user
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn target(host: &str, user: Option<&str>) -> Result<String> {
    let (embedded_user, host) = host
        .split_once('@')
        .map_or((None, host), |(user, host)| (Some(user), host));
    let user = user
        .or(embedded_user)
        .map(str::to_string)
        .unwrap_or_else(config::default_user);
    if !valid_user(&user)
        || host.is_empty()
        || host.starts_with('-')
        || host.chars().any(char::is_control)
    {
        bail!("invalid SSH target")
    }
    Ok(format!("{}@{}", user, normalize_host(host)))
}

fn normalize_host(host: &str) -> String {
    if host.contains('.') || host.parse::<std::net::IpAddr>().is_ok() {
        host.to_string()
    } else {
        format!("{host}.local")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_ed25519_public_keys() {
        assert!(validate_public_key("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBogus fleet").is_ok());
        assert!(validate_public_key("ssh-rsa AAAA fleet").is_err());
        assert!(validate_public_key("ssh-ed25519 not_base64! fleet").is_err());
    }

    #[test]
    fn reads_public_key_responses_without_authorizing_requests() {
        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBogus fleet";
        assert_eq!(parse_key_response(&format!("OK {key}\n")).unwrap(), key);
        assert!(parse_key_response("PAIR ssh-ed25519 AAAA\n").is_err());
    }

    #[test]
    fn identity_endpoint_rejects_authorization_requests() {
        assert!(validate_identity_request("KEY\n").is_ok());
        assert!(validate_identity_request("PAIR ssh-ed25519 AAAA\n").is_err());
        assert!(validate_identity_request("KEY extra\n").is_err());
    }

    #[test]
    fn authorized_keys_preserves_existing_entries_and_deduplicates() {
        let path = std::env::temp_dir().join(format!(
            "fleet-authorized-keys-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = fs::remove_file(&path);
        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBogus fleet";
        fs::write(
            &path,
            "ssh-ed25519 AAAAexisting personal\nfrom=\"10.0.0.1\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBogus restricted\n",
        )
        .unwrap();
        write_authorized_key(&path, key, "", "studio\nssh-ed25519 AAAAinjected").unwrap();
        write_authorized_key(&path, key, "", "studio").unwrap();
        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents.contains("ssh-ed25519 AAAAexisting personal\n"));
        assert_eq!(
            contents.matches("AAAAC3NzaC1lZDI1NTE5AAAAIBogus").count(),
            1
        );
        assert!(!contents.contains("AAAAinjected"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn normalizes_bare_fleet_names() {
        assert_eq!(normalize_host("studio"), "studio.local");
        assert_eq!(normalize_host("studio.local"), "studio.local");
        assert_eq!(normalize_host("192.0.2.1"), "192.0.2.1");
    }

    #[test]
    fn rejects_ssh_option_and_terminal_injection_in_users() {
        assert!(valid_user("ubuntu"));
        assert!(valid_user("build-user_2"));
        assert!(!valid_user("-oProxyCommand=touch_/tmp/pwned"));
        assert!(!valid_user("user\u{1b}[31m"));
        assert!(!valid_user("name@example"));
    }

    #[test]
    fn revocation_uses_recorded_marker_and_preserves_unrelated_bytes() {
        let path = std::env::temp_dir().join(format!(
            "fleet-revoke-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBogus";
        let original = format!(
            "# personal heading\n\nssh-ed25519 AAAApersonal me  \n{key} fleet:abc123:old-name\nlast-line-without-newline"
        );
        fs::write(&path, &original).unwrap();
        assert!(
            remove_authorized_key_at(&path, key, "fleet:abc123:old-name", "abc123", "new-name")
                .unwrap()
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# personal heading\n\nssh-ed25519 AAAApersonal me  \nlast-line-without-newline"
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn legacy_fleet_markers_remain_managed() {
        let path = std::env::temp_dir().join(format!(
            "fleet-legacy-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBogus";
        fs::write(&path, format!("{key} fleet:studio\n")).unwrap();
        let result = write_authorized_key(&path, key, "new-id", "studio").unwrap();
        assert!(!result.inserted);
        assert!(result.managed);
        assert_eq!(result.marker, "fleet:studio");
        let _ = fs::remove_file(path);
    }
}
