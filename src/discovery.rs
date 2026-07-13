use std::{
    collections::BTreeMap,
    net::IpAddr,
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};

use crate::{config, ssh};

const SERVICE_TYPE: &str = "_fleet._tcp.local.";

#[derive(Debug, Clone)]
pub struct Peer {
    pub name: String,
    pub hostname: String,
    pub user: String,
    pub port: u16,
    pub pair_port: u16,
    pub addresses: Vec<IpAddr>,
}

pub fn serve() -> Result<()> {
    let config = config::load()?;
    let daemon = ServiceDaemon::new().context("start mDNS daemon")?;
    let hostname = format!("{}.local.", config.name);
    let ssh_port = config.ssh_port.to_string();
    let properties = [
        ("user", config.user.as_str()),
        ("ssh_port", ssh_port.as_str()),
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
                let user = info
                    .get_property_val_str("user")
                    .unwrap_or("user")
                    .to_string();
                peers.insert(
                    info.get_fullname().to_string(),
                    Peer {
                        name: info
                            .get_fullname()
                            .split('.')
                            .next()
                            .unwrap_or("unknown")
                            .to_string(),
                        hostname: info.get_hostname().trim_end_matches('.').to_string(),
                        user,
                        port: info
                            .get_property_val_str("ssh_port")
                            .and_then(|value| value.parse().ok())
                            .unwrap_or(22),
                        pair_port: info.get_port(),
                        addresses: info.get_addresses().iter().copied().collect(),
                    },
                );
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
    Ok(discover(timeout)?.into_iter().find(|peer| {
        peer.name.eq_ignore_ascii_case(wanted) || peer.hostname.eq_ignore_ascii_case(name)
    }))
}

pub fn print(peers: &[Peer], plain: bool) {
    if peers.is_empty() {
        println!("No Fleet machines found.");
        return;
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
        return;
    }
    println!("{:<20} {:<28} {:<16} ADDRESS", "NAME", "HOST", "SSH USER");
    for peer in peers {
        println!(
            "{:<20} {:<28} {:<16} {}",
            peer.name,
            peer.hostname,
            peer.user,
            addresses(peer)
        );
    }
}

fn addresses(peer: &Peer) -> String {
    peer.addresses
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}
