use std::{env, fs, process::Command};

use anyhow::{Context, Result, bail};

use crate::config;

pub fn install() -> Result<()> {
    let executable = env::current_exe().context("locate fleet executable")?;
    if cfg!(target_os = "macos") {
        let dir = config::home()?.join("Library/LaunchAgents");
        fs::create_dir_all(&dir)?;
        let path = dir.join("dev.fleet.discovery.plist");
        let logs = config::dir()?;
        fs::create_dir_all(&logs)?;
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.fleet.discovery</string>
<key>ProgramArguments</key><array><string>{}</string><string>serve</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>{}/service.log</string>
<key>StandardErrorPath</key><string>{}/service.log</string>
</dict></plist>"#,
            xml(&executable.display().to_string()),
            xml(&logs.display().to_string()),
            xml(&logs.display().to_string())
        );
        fs::write(&path, plist)?;
        let domain = format!("gui/{}", unsafe { libc_getuid() });
        let _ = Command::new("launchctl")
            .args(["bootout", &domain])
            .arg(&path)
            .status();
        checked(
            Command::new("launchctl")
                .args(["bootstrap", &domain])
                .arg(&path),
            "launchctl bootstrap",
        )?;
    } else if cfg!(target_os = "linux") {
        if Command::new("systemctl")
            .args(["--user", "show-environment"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| !status.success())
            .unwrap_or(true)
        {
            bail!(
                "a systemd user session is not available; run `fleet init --no-service` and start `fleet serve` manually"
            )
        }
        enable_linger()?;
        let dir = config::home()?.join(".config/systemd/user");
        fs::create_dir_all(&dir)?;
        fs::write(
            dir.join("fleet.service"),
            format!(
                "[Unit]\nDescription=Fleet mDNS discovery\n\n[Service]\nExecStart={} serve\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n",
                systemd_arg(&executable.display().to_string())
            ),
        )?;
        checked(
            Command::new("systemctl").args(["--user", "daemon-reload"]),
            "systemctl daemon-reload",
        )?;
        checked(
            Command::new("systemctl").args(["--user", "enable", "--now", "fleet.service"]),
            "systemctl enable",
        )?;
        checked(
            Command::new("systemctl").args(["--user", "restart", "fleet.service"]),
            "systemctl restart",
        )?;
    } else {
        bail!("background service installation supports macOS and Linux")
    }
    wait_until_running()?;
    println!("Fleet discovery service installed.");
    Ok(())
}

fn enable_linger() -> Result<()> {
    let user = env::var("USER")
        .ok()
        .filter(|user| !user.is_empty())
        .or_else(|| {
            Command::new("id")
                .arg("-un")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        })
        .context("could not determine the current user")?;
    let is_root = Command::new("id")
        .arg("-u")
        .output()
        .map(|output| output.stdout == b"0\n")
        .unwrap_or(false);
    let mut command = if is_root {
        Command::new("loginctl")
    } else {
        let mut command = Command::new("sudo");
        command.arg("loginctl");
        command
    };
    let output = command
        .args(["enable-linger", &user])
        .output()
        .context("enable Fleet at boot")?;
    if !output.status.success() {
        bail!(
            "enable Fleet at boot failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }
    Ok(())
}

pub fn uninstall() -> Result<()> {
    if cfg!(target_os = "macos") {
        let path = config::home()?.join("Library/LaunchAgents/dev.fleet.discovery.plist");
        let domain = format!("gui/{}", unsafe { libc_getuid() });
        let _ = Command::new("launchctl")
            .args(["bootout", &domain])
            .arg(&path)
            .status();
        fs::remove_file(path).ok();
    } else if cfg!(target_os = "linux") {
        let _ = Command::new("systemctl")
            .args(["--user", "disable", "--now", "fleet.service"])
            .status();
        fs::remove_file(config::home()?.join(".config/systemd/user/fleet.service")).ok();
        let _ = Command::new("systemctl")
            .args(["--user", "daemon-reload"])
            .status();
    }
    println!("Fleet discovery service removed.");
    Ok(())
}

pub fn is_running() -> bool {
    if cfg!(target_os = "macos") {
        let target = format!("gui/{}/dev.fleet.discovery", unsafe { libc_getuid() });
        Command::new("launchctl")
            .args(["print", &target])
            .output()
            .map(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains("state = running")
            })
            .unwrap_or(false)
    } else if cfg!(target_os = "linux") {
        Command::new("systemctl")
            .args(["--user", "is-active", "--quiet", "fleet.service"])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    } else {
        false
    }
}

pub fn restart() -> Result<()> {
    if !is_running() {
        return install();
    }
    if cfg!(target_os = "macos") {
        let target = format!("gui/{}/dev.fleet.discovery", unsafe { libc_getuid() });
        checked(
            Command::new("launchctl").args(["kickstart", "-k", &target]),
            "restart Fleet",
        )?;
    } else if cfg!(target_os = "linux") {
        checked(
            Command::new("systemctl").args(["--user", "restart", "fleet.service"]),
            "restart Fleet",
        )?;
    } else {
        bail!("background service supports macOS and Linux")
    }
    wait_until_running()
}

fn wait_until_running() -> Result<()> {
    let mut consecutive = 0;
    for _ in 0..30 {
        if is_running() {
            consecutive += 1;
            if consecutive == 3 {
                return Ok(());
            }
        } else {
            consecutive = 0;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let detail = if cfg!(target_os = "linux") {
        Command::new("journalctl")
            .args(["--user", "-u", "fleet.service", "-n", "12", "--no-pager"])
            .output()
            .ok()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .unwrap_or_default()
    } else {
        fs::read_to_string(config::dir()?.join("service.log"))
            .unwrap_or_default()
            .lines()
            .rev()
            .take(12)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n")
    };
    if detail.is_empty() {
        bail!("Fleet discovery service did not stay running")
    }
    bail!("Fleet discovery service did not stay running:\n{detail}")
}

fn systemd_arg(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    )
}

fn checked(command: &mut Command, label: &str) -> Result<()> {
    let status = command.status().with_context(|| label.to_string())?;
    if !status.success() {
        bail!("{label} failed")
    }
    Ok(())
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(unix)]
unsafe fn libc_getuid() -> u32 {
    unsafe {
        unsafe extern "C" {
            fn getuid() -> u32;
        }
        getuid()
    }
}
#[cfg(not(unix))]
unsafe fn libc_getuid() -> u32 {
    0
}

#[cfg(test)]
mod tests {
    use super::systemd_arg;

    #[test]
    fn systemd_paths_are_quoted_and_escape_specifiers() {
        assert_eq!(
            systemd_arg("/home/A User/100%/fleet"),
            "\"/home/A User/100%%/fleet\""
        );
    }
}
