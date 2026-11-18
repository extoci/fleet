use assert_cmd::Command;
use fleet::cli::Color;
use fleet::state::{LocalConfig, Machine, Role, STATE_VERSION, StatePaths};
use predicates::prelude::*;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
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
        .stdout(predicate::str::contains("usage"))
        .stdout(predicate::str::contains("network-hint").not())
        .stdout(predicate::str::contains("transfer").not())
        .stdout(predicate::str::contains("sync").not());
}

#[test]
fn network_hint_requires_json_and_fleet_state() {
    let home = TempDir::new().unwrap();
    test_command(&home)
        .arg("network-hint")
        .assert()
        .failure()
        .stderr(predicate::str::contains("--json"));
    test_command(&home)
        .args(["network-hint", "--json"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("not in a fleet"));
}

#[test]
fn network_hint_emits_a_stable_empty_schema_without_tailscale() {
    let home = TempDir::new().unwrap();
    let config = captain_config();
    let machine_id = config.machine.id;
    let paths = StatePaths {
        root: home.path().join(".fleet"),
    };
    paths.save(&config).unwrap();
    test_command(&home)
        .env("PATH", "")
        .args(["network-hint", "--json"])
        .assert()
        .success()
        .stdout(predicate::eq(format!(
            "{{\"version\":1,\"machineId\":\"{machine_id}\",\"tailscale\":null}}\n"
        )));
}

#[test]
fn tmux_metrics_emits_a_compact_status_segment() {
    let home = TempDir::new().unwrap();
    test_command(&home)
        .arg("tmux-metrics")
        .assert()
        .success()
        .stdout(predicate::str::starts_with(" · CPU "))
        .stdout(predicate::str::contains(" · MEM "))
        .stdout(predicate::str::ends_with("%"));
}

#[test]
fn ordinary_commands_reconcile_stale_tmux_setup() {
    let home = TempDir::new().unwrap();
    let paths = StatePaths {
        root: home.path().join(".fleet"),
    };
    paths.save(&captain_config()).unwrap();

    test_command(&home).arg("status").assert().success();

    let rendered = std::fs::read_to_string(paths.shell_dir().join("tmux.conf")).unwrap();
    let helper = std::fs::read_to_string(paths.shell_dir().join("tmux-metrics")).unwrap();
    assert!(rendered.contains("status-interval 5"));
    assert!(rendered.contains("tmux-metrics"));
    assert!(helper.contains("tmux-metrics"));
}

#[cfg(unix)]
#[test]
fn ordinary_commands_reload_an_active_tmux_server_when_files_are_unchanged() {
    let home = TempDir::new().unwrap();
    let paths = StatePaths {
        root: home.path().join(".fleet"),
    };
    paths.save(&captain_config()).unwrap();

    let bin = home.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let log = home.path().join("tmux.log");
    let fake_tmux = bin.join("tmux");
    fs::write(
        &fake_tmux,
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$TMUX_LOG\"\ncase \"$1\" in\n  list-sessions) exit 0 ;;\n  source-file) exit 0 ;;\nesac\nexit 1\n",
    )
    .unwrap();
    fs::set_permissions(&fake_tmux, fs::Permissions::from_mode(0o755)).unwrap();

    let run_status = || {
        test_command(&home)
            .env("PATH", &bin)
            .env("TMUX_LOG", &log)
            .arg("status")
            .assert()
            .success();
    };

    run_status();
    fs::write(&log, "").unwrap();
    run_status();

    let calls = fs::read_to_string(log).unwrap();
    assert!(
        calls
            .lines()
            .any(|call| call.starts_with("source-file ") && call.ends_with("tmux.conf")),
        "Fleet did not reload the active tmux server:\n{calls}"
    );
}

#[test]
fn update_handoff_skips_managed_migrations_on_downgrade() {
    let home = TempDir::new().unwrap();
    let paths = StatePaths {
        root: home.path().join(".fleet"),
    };
    paths.save(&captain_config()).unwrap();

    test_command(&home)
        .args(["__complete-update", "--from", "999.0.0"])
        .assert()
        .success();
    assert!(!paths.shell_dir().exists());
}

#[test]
fn usage_rejects_an_unknown_machine_before_starting_ssh() {
    let home = TempDir::new().unwrap();
    let paths = StatePaths {
        root: home.path().join(".fleet"),
    };
    paths.save(&captain_config()).unwrap();
    test_command(&home)
        .args(["usage", "missing.local"])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "no machine named missing is registered",
        ));
}

#[test]
fn usage_accepts_zero_or_multiple_machine_names() {
    let home = TempDir::new().unwrap();
    test_command(&home)
        .args(["usage", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("[MACHINES]..."))
        .stdout(predicate::str::contains("--all"));
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
    assert_preview_did_not_reconcile(&home, &paths);
}

fn assert_preview_did_not_reconcile(home: &TempDir, paths: &StatePaths) {
    assert!(
        !paths.shell_dir().exists(),
        "preview created Fleet shell files"
    );
    assert!(
        !home.path().join(".tmux.conf").exists(),
        "preview created the user's tmux config"
    );
    assert!(!paths.logs_dir().exists(), "preview created Fleet logs");
}

#[test]
fn status_fails_cleanly_when_uninitialized() {
    let home = TempDir::new().unwrap();
    test_command(&home)
        .arg("status")
        .assert()
        .failure()
        .stderr(predicate::str::contains("not in a fleet"));
    let log = fs::read_to_string(home.path().join(".fleet/logs/fleet.log")).unwrap();
    assert!(log.contains("[command] this machine is not in a fleet"));
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
    assert!(!home.path().join(".fleet").exists());
}

#[test]
fn init_dry_run_failure_does_not_write_logs() {
    let home = TempDir::new().unwrap();
    test_command(&home)
        .args([
            "init",
            "--name",
            "INVALID",
            "--color",
            "violet",
            "--yes",
            "--dry-run",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("machine name must begin and end"));
    assert!(
        !home.path().join(".fleet").exists(),
        "preview created Fleet state"
    );
}

#[test]
fn join_dry_run_discovery_failure_does_not_write_logs() {
    let home = TempDir::new().unwrap();
    let preview = test_command(&home)
        .args(["join", "--captain", "http://[invalid", "--yes", "--dry-run"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("could not verify it"));
    assert!(
        !home.path().join(".fleet").exists(),
        "preview created Fleet state"
    );
    preview.stderr(predicate::str::contains("Run `fleet logs`").not());
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
    assert_preview_did_not_reconcile(&home, &paths);
}

#[test]
fn remove_dry_run_does_not_reconcile_tmux() {
    let home = TempDir::new().unwrap();
    let paths = StatePaths {
        root: home.path().join(".fleet"),
    };
    paths.save(&captain_config()).unwrap();
    let mut member = captain_config().machine;
    member.name = "emerald".into();
    fleet::skill::save_member(&paths, &member).unwrap();

    test_command(&home)
        .args(["remove", "emerald", "--yes", "--dry-run"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Would remove emerald.local"));
    assert_preview_did_not_reconcile(&home, &paths);
    assert_eq!(fleet::skill::load_members(&paths).unwrap(), vec![member]);
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
