//! Read-only access to the local Tailscale client.

use crate::state::{StatePaths, atomic_write};
use anyhow::{Context, Result, bail};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::Read;
use std::net::IpAddr;
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const TAILSCALE: &str = "tailscale";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
const OUTPUT_LIMIT: usize = 1024 * 1024;
const MAPPING_VERSION: u32 = 1;

static MAPPING_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Default, Serialize, Deserialize)]
struct MappingFile {
    version: u32,
    #[serde(default)]
    members: BTreeMap<Uuid, String>,
}

fn mapping_path(paths: &StatePaths) -> std::path::PathBuf {
    paths.root.join("tailscale.toml")
}

fn mapping_lock_path(paths: &StatePaths) -> std::path::PathBuf {
    paths.root.join("tailscale.lock")
}

pub fn mapped_peer(paths: &StatePaths, member: Uuid) -> Result<Option<String>> {
    let path = mapping_path(paths);
    if !path.exists() {
        return Ok(None);
    }
    let source =
        std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let file: MappingFile =
        toml::from_str(&source).with_context(|| format!("parse {}", path.display()))?;
    if file.version != MAPPING_VERSION {
        bail!("unsupported Tailscale mapping version {}", file.version);
    }
    file.members
        .get(&member)
        .map(|value| normalize_fqdn(value))
        .transpose()
}

pub fn save_mapping(paths: &StatePaths, member: Uuid, fqdn: &str) -> Result<()> {
    with_mapping_lock(paths, || {
        let mut file = load_mapping_file(paths)?;
        file.members.insert(member, normalize_fqdn(fqdn)?);
        save_mapping_file(paths, &file)
    })
}

pub fn remove_mapping(paths: &StatePaths, member: Uuid) -> Result<()> {
    with_mapping_lock(paths, || {
        let mut file = load_mapping_file(paths)?;
        if file.members.remove(&member).is_some() {
            save_mapping_file(paths, &file)?;
        }
        Ok(())
    })
}

fn with_mapping_lock<T>(paths: &StatePaths, operation: impl FnOnce() -> Result<T>) -> Result<T> {
    let lock = MAPPING_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| anyhow::anyhow!("Tailscale mapping lock is poisoned"))?;
    std::fs::create_dir_all(&paths.root)
        .with_context(|| format!("create mapping directory {}", paths.root.display()))?;
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock_file = options
        .open(mapping_lock_path(paths))
        .context("open Tailscale mapping lock")?;
    lock_file
        .lock_exclusive()
        .context("lock Tailscale mappings")?;

    let result = operation();
    let unlock_result = lock_file.unlock().context("unlock Tailscale mappings");
    match (result, unlock_result) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
    }
}

fn load_mapping_file(paths: &StatePaths) -> Result<MappingFile> {
    let path = mapping_path(paths);
    if !path.exists() {
        return Ok(MappingFile {
            version: MAPPING_VERSION,
            members: BTreeMap::new(),
        });
    }
    let source =
        std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let file: MappingFile =
        toml::from_str(&source).with_context(|| format!("parse {}", path.display()))?;
    if file.version != MAPPING_VERSION {
        bail!("unsupported Tailscale mapping version {}", file.version);
    }
    Ok(file)
}

fn save_mapping_file(paths: &StatePaths, file: &MappingFile) -> Result<()> {
    std::fs::create_dir_all(&paths.root)?;
    let source = toml::to_string_pretty(file).context("serialize Tailscale mappings")?;
    atomic_write(&mapping_path(paths), source.as_bytes(), 0o600)
}

/// Return the normalized MagicDNS name reported for the local Tailscale node.
///
/// `Ok(None)` means the client returned no self DNS name. An absent, stopped, or
/// logged-out client is an error so callers can distinguish it in diagnostics.
pub fn self_dns_name() -> Result<Option<String>> {
    let output = run_tailscale(&["status", "--json"])?;
    let status: Status =
        serde_json::from_slice(&output).context("decode `tailscale status --json` output")?;
    status
        .self_node
        .dns_name
        .as_deref()
        .map(normalize_fqdn)
        .transpose()
}

/// Resolve a full Tailscale DNS name through the local client.
///
/// Only addresses in Tailscale's documented IPv4 and IPv6 ranges are returned.
/// Any other address makes the whole result fail closed.
pub fn peer_ips(peer_fqdn: &str) -> Result<Vec<IpAddr>> {
    peer_ips_with_timeout(peer_fqdn, COMMAND_TIMEOUT)
}

pub(crate) fn peer_ips_with_timeout(peer_fqdn: &str, timeout: Duration) -> Result<Vec<IpAddr>> {
    let peer_fqdn = normalize_fqdn(peer_fqdn)?;
    let output = run_tailscale_with_timeout(&["ip", &peer_fqdn], timeout)?;
    parse_peer_ips(&output)
}

/// Normalize and validate a full ASCII DNS name used for peer correlation.
pub fn normalize_fqdn(value: &str) -> Result<String> {
    if value.is_empty() || value.trim() != value || !value.is_ascii() {
        bail!("Tailscale DNS name must be non-empty ASCII without surrounding whitespace");
    }
    let value = value.strip_suffix('.').unwrap_or(value);
    if value.is_empty() || value.len() > 253 || !value.contains('.') {
        bail!("Tailscale DNS name must be a full DNS name of at most 253 characters");
    }
    for label in value.split('.') {
        let bytes = label.as_bytes();
        if bytes.is_empty()
            || bytes.len() > 63
            || !bytes[0].is_ascii_alphanumeric()
            || !bytes[bytes.len() - 1].is_ascii_alphanumeric()
            || !bytes
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        {
            bail!("Tailscale DNS name contains an invalid DNS label");
        }
    }
    Ok(value.to_ascii_lowercase())
}

/// Whether an address belongs to Tailscale's documented address space.
pub fn is_tailscale_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let octets = address.octets();
            octets[0] == 100 && (64..=127).contains(&octets[1])
        }
        IpAddr::V6(address) => address.octets()[..6] == [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0],
    }
}

#[derive(Deserialize)]
struct Status {
    #[serde(rename = "Self", default)]
    self_node: SelfNode,
}

#[derive(Default, Deserialize)]
struct SelfNode {
    #[serde(rename = "DNSName", default)]
    dns_name: Option<String>,
}

fn parse_peer_ips(output: &[u8]) -> Result<Vec<IpAddr>> {
    let text = std::str::from_utf8(output).context("`tailscale ip` returned non-UTF-8 output")?;
    let mut addresses = Vec::new();
    for line in text.lines() {
        let value = line.trim();
        if value.is_empty() {
            continue;
        }
        let address: IpAddr = value
            .parse()
            .with_context(|| format!("`tailscale ip` returned an invalid address: {value}"))?;
        if !is_tailscale_ip(address) {
            bail!("`tailscale ip` returned an address outside Tailscale ranges: {address}");
        }
        if !addresses.contains(&address) {
            addresses.push(address);
        }
    }
    if addresses.is_empty() {
        bail!("`tailscale ip` returned no addresses");
    }
    Ok(addresses)
}

fn run_tailscale(arguments: &[&str]) -> Result<Vec<u8>> {
    run_tailscale_with_timeout(arguments, COMMAND_TIMEOUT)
}

fn run_tailscale_with_timeout(arguments: &[&str], timeout: Duration) -> Result<Vec<u8>> {
    let program = tailscale_program();
    let mut command = Command::new(&program);
    command
        .args(arguments)
        // The macOS app-bundled CLI requires this to select its non-GUI
        // backend. It is harmless for standalone and non-macOS clients.
        .env("TAILSCALE_BE_CLI", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    let mut child = command
        .spawn()
        .with_context(|| format!("start `{}` {}", program.display(), arguments.join(" ")))?;
    let stdout = child.stdout.take().context("capture Tailscale stdout")?;
    let stderr = child.stderr.take().context("capture Tailscale stderr")?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout));
    let stderr_reader = thread::spawn(move || read_bounded(stderr));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().context("wait for Tailscale command")? {
            break status;
        }
        if started.elapsed() >= timeout {
            terminate_process_group(&mut child);
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            bail!("`{TAILSCALE} {}` timed out", arguments.join(" "));
        }
        thread::sleep(Duration::from_millis(20));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| anyhow::anyhow!("Tailscale stdout reader panicked"))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| anyhow::anyhow!("Tailscale stderr reader panicked"))??;
    let output = Output {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
    };
    if stdout.truncated || stderr.truncated {
        bail!(
            "`{TAILSCALE} {}` exceeded the {OUTPUT_LIMIT}-byte output limit",
            arguments.join(" ")
        );
    }
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.trim();
        bail!(
            "`{TAILSCALE} {}` failed with {}{}",
            arguments.join(" "),
            output.status,
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        );
    }
    Ok(output.stdout)
}

fn tailscale_program() -> PathBuf {
    // An explicitly empty PATH is used by tests and by callers that want to
    // disable optional Tailscale discovery. Do not bypass that contract with
    // well-known absolute paths.
    if std::env::var_os("PATH").is_some_and(|path| path.is_empty()) {
        return PathBuf::from(TAILSCALE);
    }
    if let Ok(path) = which::which(TAILSCALE) {
        return path;
    }
    [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
        "/usr/bin/tailscale",
        "/bin/tailscale",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|path| path.is_file())
    .unwrap_or_else(|| PathBuf::from(TAILSCALE))
}

struct BoundedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

fn read_bounded(mut reader: impl Read) -> std::io::Result<BoundedOutput> {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let remaining = OUTPUT_LIMIT.saturating_sub(bytes.len());
        bytes.extend_from_slice(&buffer[..count.min(remaining)]);
        truncated |= count > remaining;
    }
    Ok(BoundedOutput { bytes, truncated })
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process_group(child: &mut Child) {
    let _ = Command::new("kill")
        .args(["-KILL", "--", &format!("-{}", child.id())])
        .status();
    let _ = child.kill();
}

#[cfg(not(unix))]
fn terminate_process_group(child: &mut Child) {
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;
    use std::sync::{Arc, Barrier};
    use std::thread;

    #[test]
    fn parses_self_dns_name_fixture() {
        let status: Status = serde_json::from_slice(
            br#"{"Version":"1.98.0","Self":{"DNSName":"Emerald.Example.TS.NET."},"Peer":{}}"#,
        )
        .unwrap();
        assert_eq!(
            normalize_fqdn(status.self_node.dns_name.as_deref().unwrap()).unwrap(),
            "emerald.example.ts.net"
        );
    }

    #[test]
    fn self_dns_name_may_be_absent() {
        let status: Status = serde_json::from_slice(br#"{"Self":{},"Peer":{}}"#).unwrap();
        assert_eq!(status.self_node.dns_name, None);
    }

    #[test]
    fn fqdn_validation_is_strict() {
        assert_eq!(
            normalize_fqdn("Node.Tailnet.TS.NET.").unwrap(),
            "node.tailnet.ts.net"
        );
        for invalid in [
            "node",
            " node.tail.ts.net",
            "node..ts.net",
            "-node.tail.ts.net",
            "node_.tail.ts.net",
            "node.tail.ts.net..",
        ] {
            assert!(normalize_fqdn(invalid).is_err(), "accepted {invalid:?}");
        }
    }

    #[test]
    fn validates_documented_tailscale_ranges() {
        assert!(is_tailscale_ip(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(is_tailscale_ip(IpAddr::V4(Ipv4Addr::new(
            100, 127, 255, 254
        ))));
        assert!(!is_tailscale_ip(IpAddr::V4(Ipv4Addr::new(100, 128, 0, 1))));
        assert!(is_tailscale_ip("fd7a:115c:a1e0::1".parse().unwrap()));
        assert!(!is_tailscale_ip("fd7a:115c:a1e1::1".parse().unwrap()));
    }

    #[test]
    fn parses_deduplicated_peer_addresses() {
        let addresses = parse_peer_ips(b"100.64.1.2\nfd7a:115c:a1e0::2\n100.64.1.2\n").unwrap();
        assert_eq!(
            addresses,
            [
                "100.64.1.2".parse::<IpAddr>().unwrap(),
                "fd7a:115c:a1e0::2".parse::<IpAddr>().unwrap()
            ]
        );
    }

    #[test]
    fn rejects_empty_invalid_and_non_tailscale_ip_output() {
        assert!(parse_peer_ips(b"").is_err());
        assert!(parse_peer_ips(b"not-an-ip\n").is_err());
        assert!(parse_peer_ips(b"192.168.1.2\n").is_err());
    }

    #[test]
    fn mappings_round_trip_and_normalize_names() {
        let temp = tempfile::tempdir().unwrap();
        let paths = StatePaths {
            root: temp.path().join(".fleet"),
        };
        let member = Uuid::new_v4();
        save_mapping(&paths, member, "Emerald.Example.TS.NET.").unwrap();
        assert_eq!(
            mapped_peer(&paths, member).unwrap().as_deref(),
            Some("emerald.example.ts.net")
        );
        remove_mapping(&paths, member).unwrap();
        assert!(mapped_peer(&paths, member).unwrap().is_none());
    }

    #[test]
    fn concurrent_mapping_updates_preserve_every_member() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Arc::new(StatePaths {
            root: temp.path().join(".fleet"),
        });
        let barrier = Arc::new(Barrier::new(8));
        let members: Vec<_> = (0..8).map(|_| Uuid::new_v4()).collect();
        let handles = members
            .iter()
            .enumerate()
            .map(|(index, member)| {
                let paths = paths.clone();
                let barrier = barrier.clone();
                let member = *member;
                thread::spawn(move || {
                    barrier.wait();
                    save_mapping(&paths, member, &format!("member{index}.example.ts.net")).unwrap();
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap();
        }
        for member in members {
            assert!(mapped_peer(&paths, member).unwrap().is_some());
        }
    }
}
