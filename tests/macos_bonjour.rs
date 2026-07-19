#![cfg(target_os = "macos")]

use assert_cmd::cargo::cargo_bin;
use fleet::cli::Color;
use fleet::state::{LocalConfig, Machine, Role, STATE_VERSION, StatePaths};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use tempfile::TempDir;
use uuid::Uuid;

#[test]
#[ignore = "uses the host Bonjour service and local network"]
fn daemon_advertises_and_is_discovered_through_bonjour() {
    let home = TempDir::new().unwrap();
    let paths = StatePaths {
        root: home.path().join(".fleet"),
    };
    let id = Uuid::new_v4();
    let name = format!("fleet-macos-test-{}", std::process::id());
    paths
        .save(&LocalConfig {
            version: STATE_VERSION,
            role: Role::Captain,
            machine: Machine {
                id,
                name: name.clone(),
                color: Color::Blue,
                ssh_user: std::env::var("USER").unwrap(),
                os: "macos".into(),
                arch: std::env::consts::ARCH.into(),
                tools: vec![],
                public_identity: "ssh-ed25519 generated-at-runtime".into(),
                ssh_host_key: None,
            },
            captain: None,
        })
        .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let daemon = Command::new(cargo_bin("fleet"))
        .args(["daemon", "--listen", &format!("0.0.0.0:{port}")])
        .env("FLEET_HOME", &paths.root)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut identity = None;
    for _ in 0..30 {
        if let Ok(found) = fleet::discovery::fetch_identity(&format!("127.0.0.1:{port}")) {
            identity = Some(found);
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(identity.unwrap().id, id);

    let captains = fleet::discovery::discover(None).unwrap();
    assert!(
        captains.iter().any(|connection| {
            connection.captain().id == id && connection.captain().name == name
        })
    );

    let status = Command::new("kill")
        .args(["-TERM", &daemon.id().to_string()])
        .status()
        .unwrap();
    assert!(status.success());
    let output = daemon.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "daemon exited with {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
}
