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
    user: Option<String>,
    color: Option<DeviceColor>,
    config_path: PathBuf,
    ssh_key_path: PathBuf,
    ssh_key_ready: bool,
    ssh_server_running: bool,
    discovery_service_running: bool,
    hosted_services: Vec<HostedServiceStatus>,
}

pub fn show(json: bool, ui: Ui) -> Result<()> {
    let config = config::load_optional()?;
    let key = ssh::private_key()?;
    let status = Status {
        version: env!("CARGO_PKG_VERSION"),
        initialized: config.is_some(),
        name: config.as_ref().map(|config| config.name.clone()),
        user: config.as_ref().map(|config| config.user.clone()),
        color: config.as_ref().map(|config| config.color),
        config_path: config::path()?,
        ssh_key_ready: key.exists() && key.with_extension("pub").exists(),
        ssh_key_path: key,
        ssh_server_running: ssh_server_running(),
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
    check(ui, status.ssh_key_ready, "Dedicated SSH key");
    check(ui, status.discovery_service_running, "Discovery service");
    if !status.hosted_services.is_empty() {
        println!();
        for service in &status.hosted_services {
            check(
                ui,
                service.online,
                &format!("{} · {}", service.name, service.fleet_url),
            );
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
