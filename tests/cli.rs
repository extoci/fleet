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

#[cfg(unix)]
#[test]
fn remote_command_exit_status_is_preserved() {
    use std::os::unix::fs::PermissionsExt;

    let home = temporary_home("remote-exit");
    let ssh_dir = home.join(".ssh");
    let bin_dir = home.join("bin");
    fs::create_dir_all(&ssh_dir).unwrap();
    fs::create_dir_all(&bin_dir).unwrap();
    fs::write(ssh_dir.join("id_ed25519_fleet"), "test-only").unwrap();
    let fake_ssh = bin_dir.join("ssh");
    fs::write(&fake_ssh, "#!/bin/sh\nexit 42\n").unwrap();
    fs::set_permissions(&fake_ssh, fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!(
        "{}:{}",
        bin_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let output = fleet()
        .env("HOME", &home)
        .env("PATH", path)
        .args(["connect", "example.com", "--", "true"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(42));
    fs::remove_dir_all(home).unwrap();
}
