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
        .stdout(predicate::str::contains("restart"))
        .stdout(predicate::str::contains("update"))
        .stdout(predicate::str::contains("update-all"))
        .stdout(predicate::str::contains("transfer").not())
        .stdout(predicate::str::contains("sync").not());
}

#[test]
fn updateall_alias_is_captain_only() {
    let home = TempDir::new().unwrap();
    let mut config = captain_config();
    config.role = Role::Member;
    config.captain = Some(fleet::state::CaptainRef {
        id: Uuid::new_v4(),
        name: "captain".into(),
        host: "captain.local".into(),
        fingerprint: "SHA256:test".into(),
        ssh_public_key: "ssh-ed25519 AAAATEST".into(),
    });
    let paths = StatePaths {
        root: home.path().join(".fleet"),
    };
    paths.save(&config).unwrap();
    test_command(&home)
        .arg("updateall")
        .assert()
        .failure()
        .stderr(predicate::str::contains("only the captain"));
}

#[test]
fn lowercase_v_prints_the_version() {
    let home = TempDir::new().unwrap();
    test_command(&home)
        .arg("-v")
        .assert()
        .success()
        .stdout(predicate::str::contains(format!(
            "fleet {}",
            env!("CARGO_PKG_VERSION")
        )));
}

#[test]
fn uppercase_v_still_prints_the_version() {
    let home = TempDir::new().unwrap();
    test_command(&home)
        .arg("-V")
        .assert()
        .success()
        .stdout(predicate::str::contains(format!(
            "fleet {}",
            env!("CARGO_PKG_VERSION")
        )));
}

#[test]
fn restart_dry_run_targets_the_captain_service() {
    #[cfg(target_os = "macos")]
    let service_name = "dev.fleet.captain";
    #[cfg(target_os = "linux")]
    let service_name = "fleet-captain.service";

    let home = TempDir::new().unwrap();
    let paths = StatePaths {
        root: home.path().join(".fleet"),
    };
    paths.save(&captain_config()).unwrap();
    test_command(&home)
        .args(["restart", "--dry-run"])
        .assert()
        .success()
        .stdout(predicate::str::contains(service_name));
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
fn ls_is_an_alias_for_status() {
    let home = TempDir::new().unwrap();
    let paths = StatePaths {
        root: home.path().join(".fleet"),
    };
    paths.save(&captain_config()).unwrap();
    test_command(&home)
        .arg("ls")
        .assert()
        .success()
        .stdout(predicate::str::contains("obsidian.local"));
}

#[test]
fn human_status_hides_color_and_architecture_metadata() {
    let home = TempDir::new().unwrap();
    let paths = StatePaths {
        root: home.path().join(".fleet"),
    };
    paths.save(&captain_config()).unwrap();
    test_command(&home)
        .arg("status")
        .assert()
        .success()
        .stdout(predicate::str::contains("macOS"))
        .stdout(predicate::str::contains("violet").not())
        .stdout(predicate::str::contains("aarch64").not());
}

#[test]
fn json_status_keeps_detailed_machine_metadata() {
    let home = TempDir::new().unwrap();
    let paths = StatePaths {
        root: home.path().join(".fleet"),
    };
    paths.save(&captain_config()).unwrap();
    test_command(&home)
        .args(["status", "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"color\": \"violet\""))
        .stdout(predicate::str::contains("\"arch\": \"aarch64\""));
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

#[test]
fn captain_can_force_leave_with_stale_members_in_dry_run() {
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
        .args(["leave", "--yes", "--force", "--dry-run"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Would remove Fleet membership"));
}

#[test]
fn captain_can_remove_member_by_name() {
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
        .args(["remove", "emerald.local", "--yes"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Removed emerald.local"));
    assert!(fleet::skill::load_members(&paths).unwrap().is_empty());
}

#[test]
fn logs_has_a_friendly_empty_state() {
    let home = TempDir::new().unwrap();
    test_command(&home)
        .arg("logs")
        .assert()
        .success()
        .stdout(predicate::str::contains("No Fleet diagnostic logs"));
}
