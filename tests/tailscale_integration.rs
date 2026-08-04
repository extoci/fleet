//! Opt-in integration coverage for a real Fleet TCP route over Tailscale.
//!
//! Run this on an enrolled machine while a second enrolled machine is online
//! and accepting SSH on its ordinary port 22:
//!
//! FLEET_TAILSCALE_TEST_PEER=member.example.ts.net \
//!     cargo test --test tailscale_integration -- --ignored --nocapture

use fleet::cli::{Color, TransportRoute};
use fleet::skill;
use fleet::ssh_client;
use fleet::state::{LocalConfig, Machine, Role, STATE_VERSION, StatePaths};
use fleet::tailscale;
use tempfile::tempdir;
use uuid::Uuid;

#[test]
#[ignore = "requires two enrolled Tailscale machines with SSH reachable on port 22"]
fn auto_route_reaches_a_real_second_machine_over_tailscale() {
    let peer = std::env::var("FLEET_TAILSCALE_TEST_PEER")
        .expect("set FLEET_TAILSCALE_TEST_PEER to the second machine's full MagicDNS name");
    let temporary = tempdir().unwrap();
    let paths = StatePaths {
        root: temporary.path().join(".fleet"),
    };
    let captain = Machine {
        id: Uuid::new_v4(),
        name: "integration-captain".into(),
        color: Color::Violet,
        ssh_user: "fleet-test".into(),
        os: "linux".into(),
        arch: "x86_64".into(),
        tools: vec![],
        public_identity: "ssh-ed25519 AAAATEST".into(),
        ssh_host_key: None,
    };
    paths
        .save(&LocalConfig {
            version: STATE_VERSION,
            role: Role::Captain,
            machine: captain,
            captain: None,
        })
        .unwrap();
    let member_id = Uuid::new_v4();
    skill::save_member(
        &paths,
        &Machine {
            id: member_id,
            name: "integration-member".into(),
            color: Color::Cyan,
            ssh_user: "fleet-test".into(),
            os: "linux".into(),
            arch: "x86_64".into(),
            tools: vec![],
            public_identity: "ssh-ed25519 AAAAMEMBER".into(),
            ssh_host_key: None,
        },
    )
    .unwrap();
    tailscale::save_mapping(&paths, member_id, &peer).unwrap();

    ssh_client::probe_transport(&paths, member_id, TransportRoute::Auto)
        .expect("Fleet could not reach the second machine through its Tailscale peer");
}
