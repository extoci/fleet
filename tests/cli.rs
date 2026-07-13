use std::{fs, process::Command};

fn fleet() -> Command {
    Command::new(env!("CARGO_BIN_EXE_fleet"))
}

fn temporary_home(label: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("fleet-test-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn no_arguments_is_useful_and_successful() {
    let output = fleet().output().unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("Your machines, one command away."));
}

#[test]
fn status_json_is_stable_for_an_uninitialized_machine() {
    let home = temporary_home("status");
    let output = fleet()
        .env("HOME", &home)
        .args(["status", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let status: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(status["initialized"], false);
    assert_eq!(status["ssh_key_ready"], false);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn invalid_names_fail_before_touching_the_system() {
    let home = temporary_home("invalid-name");
    let output = fleet()
        .env("HOME", &home)
        .args(["init", "--name", "not a dns name"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("name must be"));
    assert!(!home.join(".config/fleet/config.toml").exists());
    fs::remove_dir_all(home).unwrap();
}
