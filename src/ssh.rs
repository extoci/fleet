use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    process::Command,
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};

use anyhow::{Context, Result, bail};

use crate::{config, discovery, ui::Ui};

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

pub fn pair(host: &str, ui: Ui) -> Result<()> {
    let peer = discovery::resolve(host, Duration::from_secs(2))?
        .with_context(|| format!("Fleet device `{host}` was not found; run `fleet ls`"))?;
    allow_peer(&peer)?;
    ui.success(format!(
        "{} can now connect to this device without a password",
        peer.name
    ));
    Ok(())
}

pub fn copy_key(host: &str, user: Option<&str>, ui: Ui) -> Result<()> {
    let key = ensure_key()?.with_extension("pub");
    let target = target(host, user);
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
    authorize_key(&remote_key, &peer.name)
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
    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    thread::spawn(|| {
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

fn authorize_key(key: &str, device: &str) -> Result<()> {
    static AUTHORIZED_KEYS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = AUTHORIZED_KEYS_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| anyhow::anyhow!("authorized_keys lock is poisoned"))?;
    validate_public_key(key)?;
    let ssh_dir = config::home()?.join(".ssh");
    fs::create_dir_all(&ssh_dir)?;
    let path = ssh_dir.join("authorized_keys");
    write_authorized_key(&path, key, device)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&ssh_dir, fs::Permissions::from_mode(0o700))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn write_authorized_key(path: &std::path::Path, key: &str, device: &str) -> Result<()> {
    validate_public_key(key)?;
    let old = fs::read_to_string(path).unwrap_or_default();
    let material = key.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
    let material_fields = material.split_whitespace().collect::<Vec<_>>();
    let already_present = old.lines().any(|line| {
        line.split_whitespace()
            .collect::<Vec<_>>()
            .windows(2)
            .any(|fields| fields == material_fields)
    });
    if !already_present {
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
        writeln!(file, "{material} fleet:{device}")?;
    }
    Ok(())
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

pub fn connect(host: &str, user: Option<&str>, extra: &[String], ui: Ui) -> Result<()> {
    let key = ensure_key()?;
    let (embedded_user, lookup_host) = host
        .split_once('@')
        .map_or((None, host), |(user, host)| (Some(user), host));
    let requested_user = user.or(embedded_user);
    let discovered = if !lookup_host.contains('.') {
        discovery::resolve(lookup_host, Duration::from_secs(2))?
    } else {
        None
    };
    let (destination, port) = if let Some(peer) = discovered {
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
        (
            format!("{}@{address}", requested_user.unwrap_or(&peer.user)),
            peer.port,
        )
    } else {
        (
            target(lookup_host, requested_user),
            config::load().map(|config| config.ssh_port).unwrap_or(22),
        )
    };
    let mut command = Command::new("ssh");
    command
        .arg("-i")
        .arg(key)
        .args([
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
        ])
        .arg("-p")
        .arg(port.to_string());
    command.arg(destination).args(extra);
    let status = command.status().context("run ssh")?;
    if !status.success() {
        let local_name = config::load_optional()?
            .map(|config| config.name)
            .unwrap_or_else(|| "<this-device>".into());
        bail!(
            "SSH connection failed ({status}); check the password, or run `fleet pair {local_name}` on {lookup_host} to allow passwordless access"
        )
    }
    Ok(())
}

fn target(host: &str, user: Option<&str>) -> String {
    if host.contains('@') {
        return normalize_host(host);
    }
    format!(
        "{}@{}",
        user.map(str::to_string)
            .unwrap_or_else(config::default_user),
        normalize_host(host)
    )
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
        write_authorized_key(&path, key, "studio\nssh-ed25519 AAAAinjected").unwrap();
        write_authorized_key(&path, key, "studio").unwrap();
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
}
