use fleet::cli::Color;
use fleet::skill;
use fleet::state::{LocalConfig, Machine, Role, STATE_VERSION, StatePaths};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use uuid::Uuid;

#[test]
#[ignore = "requires Avahi and a local SSH server on the test host"]
fn open_ssh_completes_the_fleet_proxy_banner_exchange() {
    let temp = tempfile::tempdir().unwrap();
    let paths = StatePaths {
        root: temp.path().join(".fleet"),
    };
    let captain = Machine {
        id: Uuid::new_v4(),
        name: "proxy-captain".into(),
        color: Color::Violet,
        ssh_user: "exotic".into(),
        os: "linux".into(),
        arch: "x86_64".into(),
        tools: vec![],
        public_identity: "ssh-ed25519 AAAA".into(),
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
    let member = Machine {
        id: Uuid::new_v4(),
        name: format!("proxy-e2e-{}", Uuid::new_v4().simple()),
        color: Color::Emerald,
        ssh_user: "exotic".into(),
        os: "linux".into(),
        arch: "x86_64".into(),
        tools: vec![],
        public_identity: "ssh-ed25519 AAAA".into(),
        ssh_host_key: None,
    };
    skill::save_member(&paths, &member).unwrap();

    let host = member.host();
    let mut publisher = Command::new("avahi-publish")
        .args(["-a", "-R", &host, "192.168.1.69"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start avahi-publish");
    thread::sleep(Duration::from_millis(500));

    let fleet = env!("CARGO_BIN_EXE_fleet");
    let proxy = format!(
        "'{}' transport connect --member {} --via lan",
        fleet, member.id
    );
    let output = Command::new("timeout")
        .args([
            "--kill-after=1",
            "6",
            "ssh",
            "-F",
            "/dev/null",
            "-vvv",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=3",
            "-o",
            "ConnectionAttempts=1",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "PubkeyAuthentication=no",
            "-o",
            "PasswordAuthentication=no",
            "-o",
            "KbdInteractiveAuthentication=no",
            "-o",
            &format!("ProxyCommand={proxy}"),
            &format!("exotic@{host}"),
        ])
        .env("FLEET_HOME", &paths.root)
        .output()
        .unwrap();
    let _ = publisher.kill();
    let _ = publisher.wait();

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_ne!(
        output.status.code(),
        Some(124),
        "OpenSSH remained alive after the banner exchange:\n{stderr}"
    );
    assert!(
        stderr.contains("Remote protocol version"),
        "OpenSSH did not receive the member banner:\n{stderr}"
    );
    assert!(
        !stderr.contains("timed out during banner exchange"),
        "OpenSSH timed out during the Fleet proxy exchange:\n{stderr}"
    );
}
