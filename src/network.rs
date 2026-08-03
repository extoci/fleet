use crate::tailscale;
use anyhow::{Context, Result};
use if_addrs::{IfAddr, Interface};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4};

/// Normalize an IPv4-mapped IPv6 address before applying network policy.
pub(crate) fn normalize_ipv4_mapped(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(address) => address
            .to_ipv4()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(address)),
        address => address,
    }
}

/// Return whether an address is a possible directly connected LAN peer.
///
/// This deliberately does not treat a valid private address as sufficient:
/// the address must also share a subnet with an eligible, operational local
/// interface. That keeps routed networks, VPNs, and Tailscale outside the
/// ordinary LAN path.
pub(crate) fn is_directly_connected_lan_peer(peer: SocketAddr) -> Result<bool> {
    let interfaces = if_addrs::get_if_addrs().context("inspect local network interfaces")?;
    Ok(is_directly_connected_lan_peer_with_interfaces(
        peer,
        &interfaces,
    ))
}

/// Keep only resolved addresses that can be reached directly through an
/// eligible local interface. IPv4-mapped addresses are converted to native
/// IPv4 socket addresses; all other socket metadata, including IPv6 scope
/// IDs, is preserved for the eventual dial.
pub(crate) fn filter_direct_lan_addresses(addresses: Vec<SocketAddr>) -> Result<Vec<SocketAddr>> {
    let interfaces = if_addrs::get_if_addrs().context("inspect local network interfaces")?;
    Ok(filter_direct_lan_addresses_with_interfaces(
        addresses,
        &interfaces,
    ))
}

fn is_directly_connected_lan_peer_with_interfaces(
    peer: SocketAddr,
    interfaces: &[Interface],
) -> bool {
    let peer = normalize_socket_addr(peer);
    let peer_ip = peer.ip();
    is_valid_direct_peer(peer_ip)
        && interfaces
            .iter()
            .any(|interface| eligible_interface(interface) && interface_is_on_link(interface, peer))
}

fn filter_direct_lan_addresses_with_interfaces(
    addresses: Vec<SocketAddr>,
    interfaces: &[Interface],
) -> Vec<SocketAddr> {
    addresses
        .into_iter()
        .map(normalize_socket_addr)
        .filter(|address| is_directly_connected_lan_peer_with_interfaces(*address, interfaces))
        .collect()
}

fn normalize_socket_addr(address: SocketAddr) -> SocketAddr {
    match address {
        SocketAddr::V6(address) => address
            .ip()
            .to_ipv4()
            .map(|ipv4| SocketAddr::V4(SocketAddrV4::new(ipv4, address.port())))
            .unwrap_or(SocketAddr::V6(address)),
        address => address,
    }
}

pub(crate) fn ssh_host_from_socket_addr(address: SocketAddr) -> String {
    match normalize_socket_addr(address) {
        SocketAddr::V4(address) => address.ip().to_string(),
        SocketAddr::V6(address) if address.scope_id() != 0 => {
            format!("{}%{}", address.ip(), address.scope_id())
        }
        SocketAddr::V6(address) => address.ip().to_string(),
    }
}

fn is_valid_direct_peer(peer: IpAddr) -> bool {
    let peer = normalize_ipv4_mapped(peer);
    !peer.is_unspecified()
        && !peer.is_loopback()
        && !peer.is_multicast()
        && !tailscale::is_tailscale_ip(peer)
}

fn eligible_interface(interface: &Interface) -> bool {
    if !interface.is_oper_up()
        || interface.is_loopback()
        || interface.is_p2p()
        || tailscale::is_tailscale_ip(normalize_ipv4_mapped(interface.ip()))
    {
        return false;
    }
    let name = interface.name.to_ascii_lowercase();
    [
        "lo",
        "lo0",
        "awdl",
        "llw",
        "bridge",
        "docker",
        "br-",
        "virbr",
        "veth",
        "tailscale",
        "utun",
        "tun",
        "tap",
        "wg",
        "zt",
    ]
    .iter()
    .all(|prefix| name != *prefix && !name.starts_with(prefix))
}

fn interface_is_on_link(interface: &Interface, peer: SocketAddr) -> bool {
    match (&interface.addr, peer) {
        (IfAddr::V4(local), SocketAddr::V4(peer)) => {
            same_ipv4_subnet(local.ip, *peer.ip(), local.netmask)
        }
        (IfAddr::V6(local), SocketAddr::V6(peer)) => {
            if is_ipv6_link_local(*peer.ip())
                && (peer.scope_id() == 0 || interface.index != Some(peer.scope_id()))
            {
                return false;
            }
            same_ipv6_subnet(local.ip, *peer.ip(), local.netmask)
        }
        _ => false,
    }
}

fn same_ipv4_subnet(local: Ipv4Addr, peer: Ipv4Addr, netmask: Ipv4Addr) -> bool {
    u32::from(local) & u32::from(netmask) == u32::from(peer) & u32::from(netmask)
}

fn same_ipv6_subnet(local: Ipv6Addr, peer: Ipv6Addr, netmask: Ipv6Addr) -> bool {
    u128::from(local) & u128::from(netmask) == u128::from(peer) & u128::from(netmask)
}

fn is_ipv6_link_local(address: Ipv6Addr) -> bool {
    let octets = address.octets();
    octets[0] == 0xfe && octets[1] & 0xc0 == 0x80
}

#[cfg(test)]
mod tests {
    use super::*;
    use if_addrs::{IfOperStatus, Ifv4Addr, Ifv6Addr};
    use std::net::{Ipv4Addr, Ipv6Addr, SocketAddrV6};

    fn ipv4_interface(name: &str, ip: &str, netmask: &str, index: u32) -> Interface {
        Interface {
            name: name.into(),
            addr: IfAddr::V4(Ifv4Addr {
                ip: ip.parse().unwrap(),
                netmask: netmask.parse().unwrap(),
                prefixlen: 24,
                broadcast: None,
            }),
            index: Some(index),
            oper_status: IfOperStatus::Up,
            is_p2p: false,
            #[cfg(windows)]
            adapter_name: String::new(),
        }
    }

    fn ipv6_interface(name: &str, ip: &str, netmask: &str, index: u32) -> Interface {
        Interface {
            name: name.into(),
            addr: IfAddr::V6(Ifv6Addr {
                ip: ip.parse().unwrap(),
                netmask: netmask.parse().unwrap(),
                prefixlen: 64,
                broadcast: None,
            }),
            index: Some(index),
            oper_status: IfOperStatus::Up,
            is_p2p: false,
            #[cfg(windows)]
            adapter_name: String::new(),
        }
    }

    #[test]
    fn mapped_ipv4_is_normalized_before_policy_and_dialing() {
        let interfaces = vec![ipv4_interface("en0", "192.168.1.10", "255.255.255.0", 4)];
        let mapped = "[::ffff:192.168.1.20]:22".parse().unwrap();
        let filtered = filter_direct_lan_addresses_with_interfaces(vec![mapped], &interfaces);

        assert_eq!(filtered, vec!["192.168.1.20:22".parse().unwrap()]);
    }

    #[test]
    fn routed_virtual_and_special_addresses_are_rejected() {
        let interfaces = vec![
            ipv4_interface("en0", "192.168.1.10", "255.255.255.0", 4),
            ipv4_interface("tailscale0", "100.64.0.2", "255.192.0.0", 8),
        ];
        let candidates = vec![
            "192.168.1.20:22".parse().unwrap(),
            "192.168.2.20:22".parse().unwrap(),
            "100.64.0.3:22".parse().unwrap(),
            "127.0.0.1:22".parse().unwrap(),
            "224.0.0.1:22".parse().unwrap(),
        ];

        assert_eq!(
            filter_direct_lan_addresses_with_interfaces(candidates, &interfaces),
            vec!["192.168.1.20:22".parse().unwrap()]
        );
    }

    #[test]
    fn link_local_ipv6_requires_the_resolver_scope_to_match_the_interface() {
        let interfaces = vec![ipv6_interface(
            "en0",
            "fe80::10",
            "ffff:ffff:ffff:ffff::",
            7,
        )];
        let matching = SocketAddr::V6(SocketAddrV6::new("fe80::20".parse().unwrap(), 22, 0, 7));
        let wrong_interface =
            SocketAddr::V6(SocketAddrV6::new("fe80::20".parse().unwrap(), 22, 0, 8));
        let missing_scope =
            SocketAddr::V6(SocketAddrV6::new("fe80::20".parse().unwrap(), 22, 0, 0));

        assert!(is_directly_connected_lan_peer_with_interfaces(
            matching,
            &interfaces
        ));
        assert!(!is_directly_connected_lan_peer_with_interfaces(
            wrong_interface,
            &interfaces
        ));
        assert!(!is_directly_connected_lan_peer_with_interfaces(
            missing_scope,
            &interfaces
        ));
    }

    #[test]
    fn tunnel_interface_is_not_an_eligible_lan_path() {
        let interfaces = vec![ipv4_interface("tun0", "192.168.1.10", "255.255.255.0", 9)];
        assert!(!is_directly_connected_lan_peer_with_interfaces(
            "192.168.1.20:22".parse().unwrap(),
            &interfaces
        ));
    }

    #[test]
    fn subnet_masks_are_applied_to_both_ip_families() {
        assert!(same_ipv4_subnet(
            Ipv4Addr::new(192, 168, 1, 10),
            Ipv4Addr::new(192, 168, 1, 20),
            Ipv4Addr::new(255, 255, 255, 0)
        ));
        assert!(!same_ipv4_subnet(
            Ipv4Addr::new(192, 168, 1, 10),
            Ipv4Addr::new(192, 168, 2, 20),
            Ipv4Addr::new(255, 255, 255, 0)
        ));
        assert!(same_ipv6_subnet(
            Ipv6Addr::from(0xfd00u128 << 64 | 0x10),
            Ipv6Addr::from(0xfd00u128 << 64 | 0x20),
            Ipv6Addr::from(u128::MAX << 64)
        ));
        assert!(!same_ipv6_subnet(
            Ipv6Addr::from(0xfd00u128 << 64 | 0x10),
            Ipv6Addr::from(0xfd01u128 << 64 | 0x20),
            Ipv6Addr::from(u128::MAX << 64)
        ));
    }
}
