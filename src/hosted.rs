use std::{
    io,
    net::{TcpListener, TcpStream, ToSocketAddrs},
    thread,
    time::Duration,
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::{config, discovery, service, ui::Ui};

const FIRST_PUBLIC_PORT: u16 = 41_000;
const LAST_PUBLIC_PORT: u16 = 41_999;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostedService {
    pub name: String,
    pub scheme: String,
    pub target_host: String,
    pub target_port: u16,
    pub public_port: u16,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredService {
    pub name: String,
    pub url: String,
}

pub fn expose(name: &str, url: Option<&str>, public_port: Option<u16>, ui: Ui) -> Result<()> {
    validate_name(name)?;
    let source = match url {
        Some(url) => url.to_string(),
        None if matches!(
            name.to_ascii_lowercase().as_str(),
            "t3" | "t3-code" | "t3code"
        ) =>
        {
            "http://127.0.0.1:4001".into()
        }
        None => bail!("a local URL is required; try `fleet expose {name} http://127.0.0.1:3000`"),
    };
    let (scheme, target_host, target_port, path) = parse_url(&source)?;
    let mut config = config::load()?;
    let previous = config.clone();
    let existing_port = config
        .services
        .iter()
        .find(|service| service.name == name)
        .map(|service| service.public_port);
    config.services.retain(|service| service.name != name);
    let public_port = public_port
        .or(existing_port)
        .unwrap_or(available_port(&config.services)?);
    if public_port == config.ssh_port
        || public_port == config.pair_port
        || config
            .services
            .iter()
            .any(|service| service.public_port == public_port)
    {
        bail!("port {public_port} is already used by this Fleet device")
    }
    let hosted = HostedService {
        name: name.to_string(),
        scheme,
        target_host,
        target_port,
        public_port,
        path,
    };
    let online = target_online(&hosted);
    config.services.push(hosted.clone());
    config.services.sort_by(|a, b| a.name.cmp(&b.name));
    save_and_restart(&config, &previous)?;

    ui.success(format!(
        "Exposing {name} · {}",
        public_url(&config.name, &hosted)
    ));
    if !online {
        ui.muted(format!(
            "  Waiting for {}:{} to start",
            hosted.target_host, hosted.target_port
        ));
    }
    Ok(())
}

pub fn unexpose(name: &str, ui: Ui) -> Result<()> {
    let mut config = config::load()?;
    let previous = config.clone();
    let before = config.services.len();
    config.services.retain(|service| service.name != name);
    if config.services.len() == before {
        bail!("{name} is not exposed")
    }
    save_and_restart(&config, &previous)?;
    ui.success(format!("Stopped exposing {name}"));
    Ok(())
}

pub fn open(selector: &str, ui: Ui) -> Result<()> {
    let (device, service_name) = selector
        .split_once('/')
        .map_or((None, selector), |(device, service)| {
            (Some(device), service)
        });
    let matches = if let Some(device) = device {
        discovery::resolve(device, Duration::from_secs(2))?
            .into_iter()
            .flat_map(|peer| peer.services)
            .filter(|service| service.name == service_name)
            .collect::<Vec<_>>()
    } else {
        discovery::discover(Duration::from_secs(2))?
            .into_iter()
            .flat_map(|peer| peer.services)
            .filter(|service| service.name == service_name)
            .collect::<Vec<_>>()
    };
    let service = match matches.as_slice() {
        [] => bail!("service `{selector}` was not found; run `fleet ls`"),
        [service] => service,
        _ => bail!(
            "more than one device hosts `{service_name}`; use `fleet open <device>/{service_name}`"
        ),
    };
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "linux") {
        "xdg-open"
    } else {
        bail!("opening services supports macOS and Linux")
    };
    ui.muted(format!("Opening {} · {}", service.name, service.url));
    let status = std::process::Command::new(program)
        .arg(&service.url)
        .status()
        .with_context(|| format!("open {}", service.url))?;
    if !status.success() {
        bail!("could not open {}", service.url)
    }
    Ok(())
}

pub fn start_proxies(services: &[HostedService]) -> Result<()> {
    for hosted in services.iter().cloned() {
        let listener = TcpListener::bind(("0.0.0.0", hosted.public_port))
            .with_context(|| format!("expose {} on port {}", hosted.name, hosted.public_port))?;
        thread::spawn(move || {
            for connection in listener.incoming() {
                match connection {
                    Ok(client) => {
                        let hosted = hosted.clone();
                        thread::spawn(move || {
                            if let Err(error) = proxy(client, &hosted) {
                                eprintln!("{} proxy: {error:#}", hosted.name);
                            }
                        });
                    }
                    Err(error) => eprintln!("{} proxy listener: {error}", hosted.name),
                }
            }
        });
    }
    Ok(())
}

pub fn encode(service: &HostedService) -> String {
    format!(
        "{}|{}|{}|{}",
        service.name, service.scheme, service.public_port, service.path
    )
}

pub fn decode(value: &str, address: &str) -> Option<DiscoveredService> {
    let mut fields = value.splitn(4, '|');
    let name = fields.next()?.to_string();
    let scheme = fields.next()?;
    let port = fields.next()?.parse::<u16>().ok()?;
    let path = fields.next()?;
    let host = if address.contains(':') {
        format!("[{address}]")
    } else {
        address.to_string()
    };
    Some(DiscoveredService {
        name,
        url: format!("{scheme}://{host}:{port}{path}"),
    })
}

fn proxy(mut client: TcpStream, service: &HostedService) -> Result<()> {
    let mut target = TcpStream::connect((service.target_host.as_str(), service.target_port))
        .with_context(|| format!("connect to {}:{}", service.target_host, service.target_port))?;
    let mut client_read = client.try_clone()?;
    let mut target_write = target.try_clone()?;
    let upstream = thread::spawn(move || io::copy(&mut client_read, &mut target_write));
    io::copy(&mut target, &mut client)?;
    upstream
        .join()
        .map_err(|_| anyhow::anyhow!("proxy worker panicked"))??;
    Ok(())
}

fn parse_url(url: &str) -> Result<(String, String, u16, String)> {
    let (scheme, rest) = url
        .split_once("://")
        .context("URL must include http:// or https://")?;
    if !matches!(scheme, "http" | "https") {
        bail!("only http and https services are supported")
    }
    let (authority, path) = rest
        .split_once('/')
        .map_or((rest, "/".to_string()), |(host, path)| {
            (host, format!("/{path}"))
        });
    if authority.is_empty() || path.contains('|') {
        bail!("invalid service URL")
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() => {
            (host.to_string(), port.parse().context("invalid URL port")?)
        }
        _ => (
            authority.to_string(),
            if scheme == "https" { 443 } else { 80 },
        ),
    };
    Ok((scheme.to_string(), host, port, path))
}

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 32
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("service names use 1–32 letters, numbers, dashes, or underscores")
    }
    Ok(())
}

fn available_port(services: &[HostedService]) -> Result<u16> {
    for port in FIRST_PUBLIC_PORT..=LAST_PUBLIC_PORT {
        if services.iter().any(|service| service.public_port == port) {
            continue;
        }
        if TcpListener::bind(("0.0.0.0", port)).is_ok() {
            return Ok(port);
        }
    }
    bail!("no Fleet service ports are available")
}

fn target_online(service: &HostedService) -> bool {
    (service.target_host.as_str(), service.target_port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next())
        .and_then(|address| TcpStream::connect_timeout(&address, Duration::from_millis(150)).ok())
        .is_some()
}

fn save_and_restart(next: &config::Config, previous: &config::Config) -> Result<()> {
    config::save(next)?;
    if let Err(error) = service::restart() {
        config::save(previous).context("restore service configuration")?;
        let _ = service::restart();
        return Err(error).context("apply hosted service configuration");
    }
    Ok(())
}

fn public_url(device: &str, service: &HostedService) -> String {
    format!(
        "{}://{}.local:{}{}",
        service.scheme, device, service.public_port, service.path
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_local_urls() {
        assert_eq!(
            parse_url("http://127.0.0.1:4001/api").unwrap(),
            ("http".into(), "127.0.0.1".into(), 4001, "/api".into())
        );
        assert_eq!(parse_url("https://localhost").unwrap().2, 443);
        assert!(parse_url("ftp://localhost:21").is_err());
    }

    #[test]
    fn service_records_round_trip() {
        let service = HostedService {
            name: "t3".into(),
            scheme: "http".into(),
            target_host: "127.0.0.1".into(),
            target_port: 4001,
            public_port: 41000,
            path: "/".into(),
        };
        let decoded = decode(&encode(&service), "192.0.2.2").unwrap();
        assert_eq!(decoded.name, "t3");
        assert_eq!(decoded.url, "http://192.0.2.2:41000/");
    }
}
