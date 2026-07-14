use std::{path::PathBuf, process::Command};

use anyhow::Result;
use serde::Serialize;

use crate::{
    config,
    hosted::{self, HostedServiceStatus},
    service, ssh,
    ui::{DeviceColor, Ui},
};

#[derive(Serialize)]
struct Status {
    version: &'static str,
    initialized: bool,
    name: Option<String>,
    device_id: Option<String>,
    user: Option<String>,
    color: Option<DeviceColor>,
    config_path: PathBuf,
    ssh_key_path: PathBuf,
    ssh_key_ready: bool,
    ssh_key_fingerprint: Option<String>,
    authorized_devices: usize,
    ssh_server_running: bool,
    tmux_installed: bool,
    shell_theme_ready: bool,
    discovery_service_running: bool,
    hosted_services: Vec<HostedServiceStatus>,
}

pub fn show(json: bool, ui: Ui) -> Result<()> {
    let config = config::load_optional()?;
    let key = ssh::private_key()?;
    let ssh_key_ready = key.exists() && key.with_extension("pub").exists();
    let status = Status {
        version: env!("CARGO_PKG_VERSION"),
        initialized: config.is_some(),
        name: config.as_ref().map(|config| config.name.clone()),
        device_id: config.as_ref().map(|config| config.device_id.clone()),
        user: config.as_ref().map(|config| config.user.clone()),
        color: config.as_ref().map(|config| config.color),
        config_path: config::path()?,
        ssh_key_ready,
        ssh_key_fingerprint: ssh_key_ready.then(ssh::public_fingerprint).transpose()?,
        authorized_devices: ssh::access_records()?.len(),
        ssh_key_path: key,
        ssh_server_running: ssh_server_running(),
        tmux_installed: command_available("tmux"),
        shell_theme_ready: config::dir()?.join("shell.bash").exists()
            && config::dir()?.join("shell.zsh").exists(),
        discovery_service_running: service::is_running(),
        hosted_services: config.as_ref().map_or_else(Vec::new, |config| {
            hosted::statuses(&config.name, &config.services)
        }),
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&status)?);
        return Ok(());
    }

    let color = status.color.unwrap_or_default();
    println!("{}  Fleet status\n", ui.diamond(color));
    if let Some(name) = &status.name {
        check(ui, true, &format!("{name} · {}", color.label()));
    } else {
        check(ui, false, "Not initialized · run `fleet init`");
    }
    check(ui, status.ssh_server_running, "SSH server");
    check(ui, status.tmux_installed, "tmux session resume");
    check(ui, status.shell_theme_ready, "Fleet shell theme");
    check(ui, status.ssh_key_ready, "Dedicated SSH key");
    if status.authorized_devices > 0 {
        ui.muted(format!(
            "  {} device{} granted passwordless access",
            status.authorized_devices,
            if status.authorized_devices == 1 {
                ""
            } else {
                "s"
            }
        ));
    }
    check(ui, status.discovery_service_running, "Discovery service");
    if !status.hosted_services.is_empty() {
        println!();
        for service in &status.hosted_services {
            let label = if service.public {
                format!("{} · {}", service.name, service.fleet_url)
            } else {
                format!(
                    "{} · disabled; re-enable with `fleet expose {} {} --public`",
                    service.name, service.name, service.local_url
                )
            };
            check(ui, service.online, &label);
        }
    }
    Ok(())
}

fn check(ui: Ui, ready: bool, label: &str) {
    if ready {
        ui.success(label);
    } else {
        ui.muted(format!("○ {label}"));
    }
}

fn ssh_server_running() -> bool {
    if cfg!(target_os = "macos") {
        Command::new("launchctl")
            .args(["print", "system/com.openssh.sshd"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    } else {
        ["ssh", "sshd"].iter().any(|service| {
            Command::new("systemctl")
                .args(["is-active", "--quiet", service])
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        })
    }
}

fn command_available(program: &str) -> bool {
    Command::new("sh")
        .args(["-c", "command -v \"$1\" >/dev/null 2>&1", "fleet", program])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}
