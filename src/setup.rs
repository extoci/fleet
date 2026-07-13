use std::process::Command;

use anyhow::{Context, Result, bail};

use crate::{
    config::{self, Config},
    service, ssh,
    ui::{DeviceColor, Ui},
};

pub fn init(
    name: Option<String>,
    color: Option<DeviceColor>,
    install_service: bool,
    ui: Ui,
) -> Result<()> {
    let previous = config::load_optional()?;
    let hostname = hostname::get()
        .context("read hostname")?
        .to_string_lossy()
        .into_owned();
    let name = name
        .or_else(|| previous.as_ref().map(|config| config.name.clone()))
        .unwrap_or_else(|| hostname.trim_end_matches(".local").to_lowercase());
    config::validate_name(&name)?;
    let color = color
        .or_else(|| previous.as_ref().map(|config| config.color))
        .unwrap_or_else(|| DeviceColor::from_name(&name));
    let config = Config {
        name: name.clone(),
        user: previous
            .as_ref()
            .map(|config| config.user.clone())
            .unwrap_or_else(config::default_user),
        ssh_port: previous
            .as_ref()
            .map(|config| config.ssh_port)
            .unwrap_or(22),
        pair_port: previous
            .as_ref()
            .map(|config| config.pair_port)
            .unwrap_or_else(config::default_pair_port),
        color,
    };
    config::save(&config)?;
    ensure_ssh_server()?;
    ssh::ensure_key()?;
    if install_service {
        service::install()?;
    }
    println!();
    ui.success(format!("{} {name} is ready", ui.diamond(color)));
    ui.muted("  Connect from another device with: fleet connect ".to_string() + &name);
    Ok(())
}

fn ensure_ssh_server() -> Result<()> {
    if cfg!(target_os = "macos") {
        checked(
            elevated("systemsetup", &["-setremotelogin", "on"]),
            "enable Remote Login",
        )?;
        return Ok(());
    }
    if !cfg!(target_os = "linux") {
        bail!("automatic SSH setup supports macOS and Linux")
    }
    if !available("sshd") {
        if available("apt-get") {
            checked(elevated("apt-get", &["update"]), "update apt packages")?;
            checked(
                elevated("apt-get", &["install", "-y", "openssh-server"]),
                "install OpenSSH server",
            )?;
        } else if available("dnf") {
            checked(
                elevated("dnf", &["install", "-y", "openssh-server"]),
                "install OpenSSH server",
            )?;
        } else if available("pacman") {
            checked(
                elevated("pacman", &["-S", "--needed", "--noconfirm", "openssh"]),
                "install OpenSSH server",
            )?;
        } else {
            bail!("install an OpenSSH server and run `fleet init` again")
        }
    }
    let ssh = elevated("systemctl", &["enable", "--now", "ssh"])
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !ssh {
        checked(
            elevated("systemctl", &["enable", "--now", "sshd"]),
            "start the SSH server",
        )?;
    }
    println!("SSH server is ready.");
    Ok(())
}

fn available(program: &str) -> bool {
    Command::new("sh")
        .args(["-c", "command -v \"$1\" >/dev/null 2>&1", "fleet", program])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn elevated(program: &str, args: &[&str]) -> Command {
    let is_root = Command::new("id")
        .arg("-u")
        .output()
        .map(|out| out.stdout == b"0\n")
        .unwrap_or(false);
    let mut command = if is_root {
        Command::new(program)
    } else {
        let mut command = Command::new("sudo");
        command.arg(program);
        command
    };
    command.args(args);
    command
}

fn checked(mut command: Command, label: &str) -> Result<()> {
    let status = command.status().with_context(|| label.to_string())?;
    if !status.success() {
        bail!("{label} failed")
    }
    Ok(())
}
