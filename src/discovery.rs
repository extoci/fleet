use std::{
    collections::BTreeMap,
    net::IpAddr,
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;

use crate::{
    config, ssh,
    ui::{DeviceColor, Ui},
};

const SERVICE_TYPE: &str = "_fleet._tcp.local.";

#[derive(Debug, Clone, Serialize)]
pub struct Peer {
    pub name: String,
    pub hostname: String,
    pub user: String,
    pub port: u16,
    pub pair_port: u16,
    pub addresses: Vec<IpAddr>,
    pub color: DeviceColor,
    pub version: String,
}

impl Peer {
    pub fn connection_address(&self) -> Option<IpAddr> {
        self.addresses
            .iter()
            .find(|address| matches!(address, IpAddr::V4(_)))
            .or_else(|| {
                self.addresses.iter().find(|address| match address {
                    IpAddr::V6(address) => {
                        !address.is_unicast_link_local() && !address.is_loopback()
                    }
                    IpAddr::V4(_) => false,
                })
            })
            .copied()
    }
}

pub fn serve() -> Result<()> {
    let config = config::load()?;
    let daemon = ServiceDaemon::new().context("start mDNS daemon")?;
    let hostname = format!("{}.local.", config.name);
    let ssh_port = config.ssh_port.to_string();
    let color = config.color.label();
    let properties = [
        ("user", config.user.as_str()),
        ("ssh_port", ssh_port.as_str()),
        ("color", color),
        ("version", env!("CARGO_PKG_VERSION")),
    ];
    let service = ServiceInfo::new(
        SERVICE_TYPE,
        &config.name,
        &hostname,
        "",
        config.pair_port,
        &properties[..],
    )
    .context("create mDNS announcement")?
    .enable_addr_auto();
    daemon
        .register(service)
        .context("register mDNS announcement")?;
    ssh::start_pair_listener(config.pair_port)?;
    println!(
        "Advertising {} as ssh {}@{}:{}",
        config.name,
        config.user,
        hostname.trim_end_matches('.'),
        config.ssh_port
    );
    loop {
        thread::park_timeout(Duration::from_secs(3600));
    }
}

pub fn discover(timeout: Duration) -> Result<Vec<Peer>> {
    let daemon = ServiceDaemon::new().context("start mDNS daemon")?;
    let receiver = daemon
        .browse(SERVICE_TYPE)
        .context("browse for Fleet peers")?;
    let deadline = Instant::now() + timeout;
    let mut peers = BTreeMap::new();
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        match receiver.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                peers.insert(info.get_fullname().to_string(), peer_from_info(&info));
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = daemon.stop_browse(SERVICE_TYPE);
    let _ = daemon.shutdown();
    Ok(peers.into_values().collect())
}

pub fn resolve(name: &str, timeout: Duration) -> Result<Option<Peer>> {
    let wanted = name
        .trim_end_matches(".local")
        .split('.')
        .next()
        .unwrap_or(name);
    let daemon = ServiceDaemon::new().context("start mDNS daemon")?;
    let receiver = daemon
        .browse(SERVICE_TYPE)
        .context("browse for Fleet peers")?;
    let deadline = Instant::now() + timeout;
    let mut found = None;
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        match receiver.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                let peer = peer_from_info(&info);
                if (peer.name.eq_ignore_ascii_case(wanted)
                    || peer.hostname.eq_ignore_ascii_case(name))
                    && peer.connection_address().is_some()
                {
                    found = Some(peer);
                    break;
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = daemon.stop_browse(SERVICE_TYPE);
    let _ = daemon.shutdown();
    Ok(found)
}

pub fn print(peers: &[Peer], plain: bool, json: bool, ui: Ui) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(peers)?);
        return Ok(());
    }
    if peers.is_empty() {
        ui.muted("No Fleet devices found on this network.");
        return Ok(());
    }
    if plain {
        for peer in peers {
            println!(
                "{}\t{}\t{}\t{}\t{}",
                peer.name,
                peer.hostname,
                peer.user,
                peer.port,
                addresses(peer)
            );
        }
        return Ok(());
    }
    println!("{}  Fleet\n", ui.diamond(DeviceColor::Emerald));
    for peer in peers {
        let ssh_target = format!("{}@{}", peer.user, preferred_address(peer));
        println!(
            "  {}  {:<18} {:<30} v{}",
            ui.diamond(peer.color),
            peer.name,
            ssh_target,
            peer.version
        );
    }
    println!();
    ui.muted(format!(
        "  {} {} found · fleet connect <name>",
        peers.len(),
        if peers.len() == 1 {
            "device"
        } else {
            "devices"
        }
    ));
    Ok(())
}

fn addresses(peer: &Peer) -> String {
    peer.addresses
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

fn preferred_address(peer: &Peer) -> String {
    peer.connection_address()
        .map(|address| address.to_string())
        .unwrap_or_else(|| peer.hostname.clone())
}

fn parse_color(value: Option<&str>) -> DeviceColor {
    match value {
        Some("cyan") => DeviceColor::Cyan,
        Some("blue") => DeviceColor::Blue,
        Some("violet") => DeviceColor::Violet,
        Some("amber") => DeviceColor::Amber,
        Some("rose") => DeviceColor::Rose,
        _ => DeviceColor::Emerald,
    }
}

fn peer_from_info(info: &ServiceInfo) -> Peer {
    let mut addresses = info.get_addresses().iter().copied().collect::<Vec<_>>();
    addresses.sort_by_key(|address| match address {
        IpAddr::V4(address) => (0, address.to_string()),
        IpAddr::V6(address) if !address.is_unicast_link_local() => (1, address.to_string()),
        IpAddr::V6(address) => (2, address.to_string()),
    });
    Peer {
        name: info
            .get_fullname()
            .split('.')
            .next()
            .unwrap_or("unknown")
            .to_string(),
        hostname: info.get_hostname().trim_end_matches('.').to_string(),
        user: info
            .get_property_val_str("user")
            .unwrap_or("user")
            .to_string(),
        port: info
            .get_property_val_str("ssh_port")
            .and_then(|value| value.parse().ok())
            .unwrap_or(22),
        pair_port: info.get_port(),
        addresses,
        color: parse_color(info.get_property_val_str("color")),
        version: info
            .get_property_val_str("version")
            .unwrap_or("unknown")
            .to_string(),
    }
}
