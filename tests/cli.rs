use assert_cmd::Command;
use fleet::cli::Color;
use fleet::state::{LocalConfig, Machine, Role, STATE_VERSION, StatePaths};
use predicates::prelude::*;
use tempfile::TempDir;
use uuid::Uuid;

fn test_command(home: &TempDir) -> Command {
    let mut command = Command::cargo_bin("fleet").unwrap();
    command
        .env("FLEET_HOME", home.path().join(".fleet"))
        .env("FLEET_AGENTS_HOME", home.path().join(".agents"))
        .env("HOME", home.path())
        .env("USER", "fleet-test")
        .env("SHELL", "/bin/zsh");
    command
}

fn captain_config() -> LocalConfig {
    LocalConfig {
        version: STATE_VERSION,
        role: Role::Captain,
        machine: Machine {
            id: Uuid::new_v4(),
            name: "obsidian".into(),
            color: Color::Violet,
            ssh_user: "fleet-test".into(),
            os: "macos".into(),
            arch: "aarch64".into(),
            tools: vec![],
            public_identity: "ssh-ed25519 AAAATEST".into(),
            ssh_host_key: None,
        },
        captain: None,
    }
}

#[test]
fn help_exposes_only_the_v0_lifecycle() {
    let home = TempDir::new().unwrap();
    test_command(&home)
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("init"))
        .stdout(predicate::str::contains("join"))
        .stdout(predicate::str::contains("status"))
        .stdout(predicate::str::contains("leave"))
        .stdout(predicate::str::contains("transfer").not())
        .stdout(predicate::str::contains("sync").not());
}

#[test]
fn status_fails_cleanly_when_uninitialized() {
    let home = TempDir::new().unwrap();
    test_command(&home)
        .arg("status")
        .assert()
        .failure()
        .stderr(predicate::str::contains("not in a fleet"));
}

#[test]
fn status_reads_local_captain_state_without_networking() {
    let home = TempDir::new().unwrap();
    let paths = StatePaths {
        root: home.path().join(".fleet"),
    };
    paths.save(&captain_config()).unwrap();
    test_command(&home)
        .arg("status")
        .assert()
        .success()
        .stdout(predicate::str::contains("CAPTAIN"))
        .stdout(predicate::str::contains("obsidian.local"))
        .stdout(predicate::str::contains("No members"));
}

#[test]
fn init_dry_run_never_creates_state() {
    let home = TempDir::new().unwrap();
    test_command(&home)
        .args([
            "init",
            "--name",
            "fleet-test-captain",
            "--color",
            "violet",
            "--yes",
            "--dry-run",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("Would create a Fleet identity"));
    assert!(!home.path().join(".fleet/config.toml").exists());
}

#[test]
fn init_can_resume_an_existing_captain_idempotently() {
    let home = TempDir::new().unwrap();
    let paths = StatePaths {
        root: home.path().join(".fleet"),
    };
    paths.save(&captain_config()).unwrap();
    test_command(&home)
        .args(["init", "--yes", "--dry-run"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Resuming captain setup"))
        .stdout(predicate::str::contains("Would verify identity"));
}

#[test]
fn captain_cannot_leave_with_members() {
    let home = TempDir::new().unwrap();
    let paths = StatePaths {
        root: home.path().join(".fleet"),
    };
    paths.save(&captain_config()).unwrap();
    let mut member = captain_config().machine;
    member.id = Uuid::new_v4();
    member.name = "emerald".into();
    fleet::skill::save_member(&paths, &member).unwrap();
    test_command(&home)
        .args(["leave", "--yes", "--dry-run"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("members must leave"));
}
