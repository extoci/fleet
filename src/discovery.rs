use crate::state::CaptainRef;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const SERVICE_TYPE: &str = "_fleet._tcp";
pub const DEFAULT_PORT: u16 = 42170;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptainAdvertisement {
    pub protocol: u32,
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    pub ssh_public_key: String,
}

impl CaptainAdvertisement {
    pub fn captain_ref(&self) -> CaptainRef {
        CaptainRef {
            id: self.id,
            name: self.name.clone(),
            host: self.host.clone(),
            fingerprint: self.fingerprint.clone(),
            ssh_public_key: self.ssh_public_key.clone(),
        }
    }
}

pub fn discover(explicit: Option<&str>) -> Result<Vec<CaptainAdvertisement>> {
    if let Some(endpoint) = explicit {
        return Ok(vec![fetch_identity(endpoint)?]);
    }
    discover_with(
        || {
            if cfg!(target_os = "macos") {
                browse_macos()
            } else if cfg!(target_os = "linux") {
                browse_linux()
            } else {
                bail!("Fleet discovery supports macOS and Linux only");
            }
        },
        fetch_identity,
        6,
        Duration::from_millis(500),
    )
}

fn discover_with<B, F>(
    mut browse: B,
    mut fetch: F,
    attempts: usize,
    retry_delay: Duration,
) -> Result<Vec<CaptainAdvertisement>>
where
    B: FnMut() -> Result<Vec<String>>,
    F: FnMut(&str) -> Result<CaptainAdvertisement>,
{
    let mut failures = Vec::new();
    for attempt in 0..attempts {
        let mut captains = Vec::new();
        for endpoint in browse()? {
            match fetch(&endpoint) {
                Ok(captain)
                    if !captains
                        .iter()
                        .any(|existing: &CaptainAdvertisement| existing.id == captain.id) =>
                {
                    captains.push(captain)
                }
                Ok(_) => {}
                Err(error) => failures.push(format!("{endpoint}: {error:#}")),
            }
        }
        if !captains.is_empty() {
            return Ok(captains);
        }
        if attempt + 1 < attempts {
            thread::sleep(retry_delay);
        }
    }
    if failures.is_empty() {
        Ok(Vec::new())
    } else {
        bail!(
            "Fleet advertisements were found, but none responded correctly: {}",
            failures.join("; ")
        )
    }
}

pub fn fetch_identity(endpoint: &str) -> Result<CaptainAdvertisement> {
    let endpoint = endpoint.trim_end_matches('/');
    let url = if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
        format!("{endpoint}/v1/identity")
    } else {
        format!("http://{endpoint}/v1/identity")
    };
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()?
        .get(&url)
        .send()
        .with_context(|| format!("contact captain at {endpoint}"))?
        .error_for_status()
        .context("captain rejected identity request")?;
    let captain: CaptainAdvertisement = response.json().context("decode captain identity")?;
    validate_advertisement(&captain)?;
    Ok(captain)
}

fn validate_advertisement(captain: &CaptainAdvertisement) -> Result<()> {
    if captain.protocol != 1 {
        bail!(
            "captain uses unsupported Fleet protocol {}",
            captain.protocol
        );
    }
    crate::state::validate_machine_name(&captain.name)
        .context("captain advertised an invalid machine name")?;
    if captain.host != format!("{}.local", captain.name) {
        bail!("captain hostname does not match its machine name");
    }
    if captain.port == 0 {
        bail!("captain advertised an invalid service port");
    }
    let expected = crate::identity::fingerprint_public_key(&captain.ssh_public_key)
        .context("captain advertised an invalid identity key")?;
    if captain.fingerprint != expected {
        bail!("captain fingerprint does not match its identity key");
    }
    Ok(())
}

fn browse_linux() -> Result<Vec<String>> {
    let stdout = capture_until_exit(
        Command::new("avahi-browse").args(["--resolve", "--terminate", "--parsable", SERVICE_TYPE]),
        Duration::from_secs(4),
    )
    .context("run avahi-browse; install avahi-utils and confirm Avahi is running")?;
    let mut endpoints = Vec::new();
    for line in stdout.lines().filter(|line| line.starts_with('=')) {
        let fields: Vec<_> = line.split(';').collect();
        if fields.len() > 8 {
            let host = fields[6].trim_end_matches('.');
            let port = fields[8];
            endpoints.push(format!("{host}:{port}"));
        }
    }
    endpoints.sort();
    endpoints.dedup();
    Ok(endpoints)
}

fn capture_until_exit(command: &mut Command, duration: Duration) -> Result<String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("start timed command")?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            let mut bytes = Vec::new();
            if let Some(mut stdout) = child.stdout.take() {
                stdout.read_to_end(&mut bytes)?;
            }
            if !status.success() {
                bail!("command exited with {status}");
            }
            return Ok(String::from_utf8_lossy(&bytes).into_owned());
        }
        if started.elapsed() >= duration {
            let _ = child.kill();
            let _ = child.wait();
            bail!("command timed out after {} seconds", duration.as_secs());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn browse_macos() -> Result<Vec<String>> {
    let output = capture_for(
        Command::new("dns-sd").args(["-B", SERVICE_TYPE, "local"]),
        Duration::from_secs(2),
    )?;
    let mut instances = Vec::new();
    for line in output.lines() {
        if !line.contains(SERVICE_TYPE) || !line.contains(" Add ") {
            continue;
        }
        if let Some(index) = line.find(SERVICE_TYPE) {
            let instance = line[index + SERVICE_TYPE.len()..]
                .trim_start_matches('.')
                .trim();
            if !instance.is_empty() {
                instances.push(instance.to_owned());
            }
        }
    }
    let mut endpoints = Vec::new();
    for instance in instances {
        let output = capture_for(
            Command::new("dns-sd").args(["-L", &instance, SERVICE_TYPE, "local"]),
            Duration::from_secs(2),
        )?;
        for line in output.lines() {
            if let Some(marker) = line.find(" can be reached at ") {
                let target = line[marker + " can be reached at ".len()..]
                    .split_whitespace()
                    .next()
                    .unwrap_or_default();
                if let Some((host, port)) = target.rsplit_once(':') {
                    endpoints.push(format!("{}:{}", host.trim_end_matches('.'), port));
                }
            }
        }
    }
    endpoints.sort();
    endpoints.dedup();
    Ok(endpoints)
}

fn capture_for(command: &mut Command, duration: Duration) -> Result<String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("start DNS-SD command")?;
    let started = Instant::now();
    while started.elapsed() < duration {
        if child.try_wait()?.is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let mut bytes = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        stdout.read_to_end(&mut bytes)?;
    }
    let _ = child.wait();
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertisement_becomes_captain_reference() {
        let id = Uuid::new_v4();
        let ad = CaptainAdvertisement {
            protocol: 1,
            id,
            name: "obsidian".into(),
            host: "obsidian.local".into(),
            port: DEFAULT_PORT,
            fingerprint: "SHA256:test".into(),
            ssh_public_key: "ssh-ed25519 AAAA".into(),
        };
        assert_eq!(ad.captain_ref().id, id);
    }

    #[test]
    fn advertisement_identity_is_self_consistent() {
        let key =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElmqI4v+7cZFSmB7soOSl3vymQTl8v7/15ZnHH2DA4d";
        let mut ad = CaptainAdvertisement {
            protocol: 1,
            id: Uuid::new_v4(),
            name: "obsidian".into(),
            host: "obsidian.local".into(),
            port: DEFAULT_PORT,
            fingerprint: crate::identity::fingerprint_public_key(key).unwrap(),
            ssh_public_key: key.into(),
        };
        assert!(validate_advertisement(&ad).is_ok());
        ad.fingerprint = "SHA256:attacker".into();
        assert!(validate_advertisement(&ad).is_err());
        ad.fingerprint = crate::identity::fingerprint_public_key(key).unwrap();
        ad.host = "ruby.local".into();
        assert!(validate_advertisement(&ad).is_err());
    }

    #[test]
    fn discovery_retries_after_a_stale_service_until_a_captain_is_valid() {
        let key =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElmqI4v+7cZFSmB7soOSl3vymQTl8v7/15ZnHH2DA4d";
        let captain = CaptainAdvertisement {
            protocol: 1,
            id: Uuid::new_v4(),
            name: "emerald".into(),
            host: "emerald.local".into(),
            port: DEFAULT_PORT,
            fingerprint: crate::identity::fingerprint_public_key(key).unwrap(),
            ssh_public_key: key.into(),
        };
        let mut browses = 0;
        let found = discover_with(
            || {
                browses += 1;
                Ok(if browses == 1 {
                    vec!["emerald.local:47651".into()]
                } else {
                    vec!["emerald.local:42170".into()]
                })
            },
            |endpoint| {
                if endpoint.ends_with(":47651") {
                    bail!("stale service");
                }
                Ok(captain.clone())
            },
            2,
            Duration::ZERO,
        )
        .unwrap();

        assert_eq!(browses, 2);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].port, DEFAULT_PORT);
    }
}
