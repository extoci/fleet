//! Read-only access to the local Tailscale client.

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::io::Read;
use std::net::IpAddr;
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const TAILSCALE: &str = "tailscale";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
const OUTPUT_LIMIT: usize = 1024 * 1024;

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
    let peer_fqdn = normalize_fqdn(peer_fqdn)?;
    let output = run_tailscale(&["ip", &peer_fqdn])?;
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
    let mut command = Command::new(TAILSCALE);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    let mut child = command
        .spawn()
        .with_context(|| format!("start `{TAILSCALE} {}`", arguments.join(" ")))?;
    let stdout = child.stdout.take().context("capture Tailscale stdout")?;
    let stderr = child.stderr.take().context("capture Tailscale stderr")?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout));
    let stderr_reader = thread::spawn(move || read_bounded(stderr));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().context("wait for Tailscale command")? {
            break status;
        }
        if started.elapsed() >= COMMAND_TIMEOUT {
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
}
