use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::{IpAddr, SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    process::Command,
    thread,
    time::Duration,
};

use anyhow::{Context, Result, bail};

use crate::{config, discovery};

pub fn private_key() -> Result<PathBuf> {
    Ok(config::home()?.join(".ssh/id_ed25519_fleet"))
}

pub fn ensure_key() -> Result<PathBuf> {
    let key = private_key()?;
    if key.exists() {
        println!("Fleet SSH key already exists: {}", key.display());
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
        .args(["-N", "", "-C", "fleet"])
        .status()
        .context("run ssh-keygen")?;
    if !status.success() {
        bail!("ssh-keygen failed")
    }
    println!("Created Fleet SSH key: {}", key.display());
    Ok(key)
}

pub fn print_public_key() -> Result<()> {
    let key = ensure_key()?;
    print!(
        "{}",
        fs::read_to_string(key.with_extension("pub")).context("read public key")?
    );
    Ok(())
}

pub fn pair(host: &str, user: Option<&str>) -> Result<()> {
    if user.is_none() {
        if let Some(peer) = discovery::resolve(host, Duration::from_secs(3))? {
            return pair_fleet(&peer);
        }
    }
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
    println!("Paired with {target}. Connect with `fleet ssh connect {host}`.");
    Ok(())
}

fn pair_fleet(peer: &discovery::Peer) -> Result<()> {
    let public_key = public_key()?;
    let address = peer
        .addresses
        .iter()
        .find(|address| matches!(address, IpAddr::V4(_)))
        .or_else(|| peer.addresses.iter().next())
        .context("peer did not advertise an address")?;
    let socket = SocketAddr::new(*address, peer.pair_port);
    let mut stream = TcpStream::connect_timeout(&socket, Duration::from_secs(3))
        .with_context(|| format!("connect to Fleet pairing service at {socket}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    writeln!(stream, "PAIR {public_key}")?;
    let mut response = String::new();
    BufReader::new(stream).read_line(&mut response)?;
    let remote_key = response
        .strip_prefix("OK ")
        .context("peer rejected the pairing request")?
        .trim();
    authorize_key(remote_key)?;
    println!(
        "Paired with {}. Connect with `fleet ssh connect {}`.",
        peer.name, peer.name
    );
    Ok(())
}

pub fn start_pair_listener(port: u16) -> Result<()> {
    let listener = TcpListener::bind(("0.0.0.0", port))
        .with_context(|| format!("listen for Fleet pairing on port {port}"))?;
    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    thread::spawn(|| {
                        if let Err(error) = accept_pair(stream) {
                            eprintln!("pairing request rejected: {error:#}");
                        }
                    });
                }
                Err(error) => eprintln!("pairing listener error: {error}"),
            }
        }
    });
    Ok(())
}

fn accept_pair(mut stream: TcpStream) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    let mut request = String::new();
    BufReader::new(stream.try_clone()?).read_line(&mut request)?;
    if request.len() > 16 * 1024 {
        bail!("pairing request is too large")
    }
    let key = request
        .strip_prefix("PAIR ")
        .context("unsupported pairing request")?
        .trim();
    authorize_key(key)?;
    writeln!(stream, "OK {}", public_key()?)?;
    Ok(())
}

fn public_key() -> Result<String> {
    let path = ensure_key()?.with_extension("pub");
    Ok(fs::read_to_string(path)?.trim().to_string())
}

fn authorize_key(key: &str) -> Result<()> {
    validate_public_key(key)?;
    let ssh_dir = config::home()?.join(".ssh");
    fs::create_dir_all(&ssh_dir)?;
    let path = ssh_dir.join("authorized_keys");
    let old = fs::read_to_string(&path).unwrap_or_default();
    let material = key.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
    let already_present = old.lines().any(|line| {
        line.split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ")
            == material
    });
    if !already_present {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        if !old.is_empty() && !old.ends_with('\n') {
            writeln!(file)?;
        }
        writeln!(file, "{material} fleet")?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&ssh_dir, fs::Permissions::from_mode(0o700))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
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

pub fn connect(host: &str, user: Option<&str>, extra: &[String]) -> Result<()> {
    let key = ensure_key()?;
    let discovered = if !host.contains('.') && !host.contains('@') {
        discovery::resolve(host, Duration::from_secs(2))?
    } else {
        None
    };
    let (destination, port) = if let Some(peer) = discovered {
        let address = peer
            .addresses
            .iter()
            .find(|address| matches!(address, IpAddr::V4(_)))
            .or_else(|| peer.addresses.iter().next())
            .context("peer did not advertise an address")?;
        (
            format!("{}@{address}", user.unwrap_or(&peer.user)),
            peer.port,
        )
    } else {
        (
            target(host, user),
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
        bail!("ssh exited with {status}")
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
