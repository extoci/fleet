use std::{
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use anyhow::{Context, Result, bail};

use crate::{
    config::{self, Config},
    discovery::{self, Peer},
    service, ssh,
    ui::{DeviceColor, Ui},
};

struct OnboardingChoices {
    name: String,
    color: DeviceColor,
    allowed_peers: Vec<Peer>,
}

pub fn init(
    name: Option<String>,
    color: Option<DeviceColor>,
    install_service: bool,
    ui: Ui,
) -> Result<()> {
    let previous = config::load_optional()?;
    let first_run = previous.is_none();
    let prompt_for_name = name.is_none();
    let prompt_for_color = color.is_none();
    let hostname = hostname::get()
        .context("read hostname")?
        .to_string_lossy()
        .into_owned();
    let suggested_name = name
        .or_else(|| previous.as_ref().map(|config| config.name.clone()))
        .unwrap_or_else(|| {
            hostname
                .trim_end_matches(".local")
                .split('.')
                .next()
                .unwrap_or("fleet-device")
                .to_lowercase()
        });
    if !prompt_for_name || !first_run || !io::stdin().is_terminal() {
        config::validate_name(&suggested_name)?;
    }
    let suggested_color = color
        .or_else(|| previous.as_ref().map(|config| config.color))
        .unwrap_or_else(|| DeviceColor::from_name(&suggested_name));

    let choices = if first_run && io::stdin().is_terminal() {
        let Some(choices) = onboarding_wizard(
            suggested_name,
            suggested_color,
            prompt_for_name,
            prompt_for_color,
            install_service,
            ui,
        )?
        else {
            ui.muted("Setup cancelled. Nothing was changed.");
            return Ok(());
        };
        choices
    } else {
        OnboardingChoices {
            name: suggested_name,
            color: suggested_color,
            allowed_peers: Vec::new(),
        }
    };
    let OnboardingChoices {
        name,
        color,
        allowed_peers,
    } = choices;

    let previous_config = previous.clone();
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
        services: previous
            .as_ref()
            .map(|config| config.services.clone())
            .unwrap_or_default(),
    };
    let discovery_service_was_running = service::is_running();
    config::save(&config)?;
    let mut service_install_attempted = false;
    let core_setup = (|| -> Result<()> {
        ensure_ssh_server()?;
        ssh::ensure_key()?;
        if install_service {
            service_install_attempted = true;
            service::install()?;
        }
        Ok(())
    })();
    if let Err(error) = core_setup {
        match previous_config {
            Some(previous) => config::save(&previous).context("restore previous Fleet settings")?,
            None => config::remove().context("remove incomplete Fleet settings")?,
        }
        if service_install_attempted {
            if discovery_service_was_running {
                let _ = service::restart();
            } else {
                let _ = service::uninstall();
            }
        }
        return Err(error);
    }
    for peer in allowed_peers {
        match ssh::allow_peer(&peer) {
            Ok(()) => ui.success(format!(
                "{} may connect without a password",
                peer.name
            )),
            Err(error) => ui.muted(format!(
                "Could not allow {} without a password: {error:#}\n  It can still try the {} account's normal SSH authentication.",
                peer.name, config.user
            )),
        }
    }
    println!();
    ui.ready(color, &name);
    ui.muted("  Connect from another device with: fleet connect ".to_string() + &name);
    if let Err(error) = offer_codex_login(ui) {
        ui.muted(format!("Codex setup did not finish: {error:#}"));
    }
    if let Err(error) = offer_t3_code(ui) {
        ui.muted(format!("T3 Code did not start: {error:#}"));
    }
    Ok(())
}

fn onboarding_wizard(
    suggested_name: String,
    suggested_color: DeviceColor,
    prompt_for_name: bool,
    prompt_for_color: bool,
    install_service: bool,
    ui: Ui,
) -> Result<Option<OnboardingChoices>> {
    println!();
    println!("{}  Fleet setup", ui.diamond(suggested_color));
    ui.muted("   One identity for SSH, services, and agents.");

    println!();
    println!("Device identity");
    let name = if prompt_for_name {
        loop {
            let Some(value) = prompt_with_default("  Name", &suggested_name)? else {
                return Ok(None);
            };
            match config::validate_name(&value) {
                Ok(()) => break value,
                Err(error) => println!("  {error}"),
            }
        }
    } else {
        println!("  Name  {suggested_name}");
        suggested_name
    };

    let default_color = if prompt_for_color {
        DeviceColor::from_name(&name)
    } else {
        suggested_color
    };
    let color = if prompt_for_color {
        println!();
        println!("Device color");
        ui.muted("  Shown anywhere this device appears in Fleet.");
        for (index, color) in DeviceColor::ALL.iter().enumerate() {
            let marker = if *color == default_color { "›" } else { " " };
            println!(
                "  {marker} {}  {}  {}",
                index + 1,
                ui.diamond(*color),
                color.label()
            );
        }
        loop {
            let Some(value) = prompt_with_default("  Color", default_color.label())? else {
                return Ok(None);
            };
            match parse_color(&value) {
                Some(color) => break color,
                None => println!("  Choose a number from 1–6 or a color name."),
            }
        }
    } else {
        println!(
            "  Color {}  {}",
            ui.diamond(default_color),
            default_color.label()
        );
        default_color
    };

    let peers = discover_for_onboarding(ui);
    let Some(allowed_peers) = choose_allowed_peers(&peers, ui)? else {
        return Ok(None);
    };

    println!();
    println!("Fleet will configure");
    println!("  • SSH access with a dedicated Fleet key");
    if allowed_peers.is_empty() {
        println!("  • Other Fleet devices use normal SSH authentication");
    } else {
        println!(
            "  • Passwordless access from {}",
            allowed_peers
                .iter()
                .map(|peer| peer.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    if install_service {
        println!("  • Local discovery as {name}.local");
        println!("  • A background service that starts automatically");
    } else {
        println!("  • No background discovery; this device will not appear automatically");
    }
    println!("  • Optional Codex installation and sign-in");
    println!("  • Optional T3 Code launch with `bunx t3@latest`");

    println!();
    Ok(
        confirm("Set up this device? [Y/n] ")?.then_some(OnboardingChoices {
            name,
            color,
            allowed_peers,
        }),
    )
}

fn discover_for_onboarding(ui: Ui) -> Vec<Peer> {
    println!();
    println!("Passwordless SSH access");
    ui.muted("  Looking for Fleet devices already on this network…");
    match discovery::discover(Duration::from_secs(2)) {
        Ok(peers) => peers,
        Err(error) => {
            ui.muted(format!(
                "  Discovery was unavailable: {error:#}\n  Other devices can still use this account's normal SSH authentication."
            ));
            Vec::new()
        }
    }
}

fn choose_allowed_peers(peers: &[Peer], ui: Ui) -> Result<Option<Vec<Peer>>> {
    if peers.is_empty() {
        ui.muted(
            "  No other Fleet devices found. They can connect later using normal SSH authentication.",
        );
        return Ok(Some(Vec::new()));
    }

    println!("  Choose which devices may connect to this machine without a password.");
    for (index, peer) in peers.iter().enumerate() {
        let target = peer
            .connection_address()
            .map(|address| format!("{}@{address}", peer.user))
            .unwrap_or_else(|| format!("{}@{}", peer.user, peer.hostname));
        println!(
            "  {}  {}  {:<18} {}",
            index + 1,
            ui.diamond(peer.color),
            peer.name,
            target
        );
    }
    ui.muted("  Enter numbers separated by commas, `all`, or `none`.");
    loop {
        let Some(answer) = prompt_with_default("  Devices", "none")? else {
            return Ok(None);
        };
        match parse_peer_selection(&answer, peers.len()) {
            Ok(indexes) => {
                return Ok(Some(
                    indexes
                        .into_iter()
                        .map(|index| peers[index].clone())
                        .collect(),
                ));
            }
            Err(error) => println!("  {error}"),
        }
    }
}

fn parse_peer_selection(value: &str, count: usize) -> Result<Vec<usize>> {
    let value = value.trim().to_ascii_lowercase();
    if value == "none" || value.is_empty() {
        return Ok(Vec::new());
    }
    if value == "all" {
        return Ok((0..count).collect());
    }
    let mut indexes = Vec::new();
    for field in value.split([',', ' ']).filter(|field| !field.is_empty()) {
        let number = field
            .parse::<usize>()
            .with_context(|| format!("`{field}` is not a device number"))?;
        let index = number
            .checked_sub(1)
            .filter(|index| *index < count)
            .with_context(|| format!("choose device numbers from 1–{count}"))?;
        if !indexes.contains(&index) {
            indexes.push(index);
        }
    }
    if indexes.is_empty() {
        bail!("choose device numbers, `all`, or `none`");
    }
    Ok(indexes)
}

fn prompt_with_default(label: &str, default: &str) -> Result<Option<String>> {
    print!("{label} [{default}]: ");
    io::stdout().flush().context("show setup prompt")?;
    let mut answer = String::new();
    if io::stdin()
        .read_line(&mut answer)
        .context("read setup choice")?
        == 0
    {
        return Ok(None);
    }
    let answer = answer.trim();
    Ok(Some(if answer.is_empty() {
        default.to_string()
    } else {
        answer.to_string()
    }))
}

fn parse_color(value: &str) -> Option<DeviceColor> {
    let value = value.trim().to_ascii_lowercase();
    if let Ok(index) = value.parse::<usize>() {
        return index
            .checked_sub(1)
            .and_then(|index| DeviceColor::ALL.get(index))
            .copied();
    }
    DeviceColor::ALL
        .into_iter()
        .find(|color| color.label() == value)
}

fn confirm(prompt: &str) -> Result<bool> {
    loop {
        print!("{prompt}");
        io::stdout().flush().context("show confirmation prompt")?;
        let mut answer = String::new();
        if io::stdin()
            .read_line(&mut answer)
            .context("read confirmation")?
            == 0
        {
            return Ok(false);
        }
        match confirmation(&answer) {
            Some(choice) => return Ok(choice),
            None => println!("Please answer yes or no."),
        }
    }
}

fn offer_codex_login(ui: Ui) -> Result<()> {
    if !io::stdin().is_terminal() {
        return Ok(());
    }

    println!();
    let codex = find_program("codex");
    let prompt = if codex.is_some() {
        "Sign in to Codex to use this device? [Y/n] "
    } else {
        "Install and sign in to Codex on this device? [Y/n] "
    };
    if confirm(prompt)? {
        let codex = match codex {
            Some(codex) => codex,
            None => install_codex(ui)?,
        };
        run_codex_login(&codex)
    } else {
        ui.muted("Skipped Codex sign-in. Run `codex login` whenever you're ready.");
        Ok(())
    }
}

fn offer_t3_code(ui: Ui) -> Result<()> {
    if !io::stdin().is_terminal() {
        return Ok(());
    }

    println!();
    ui.muted("T3 Code is a local web interface for Codex and other coding agents.");
    ui.muted(
        "It downloads the latest package, may install native build tools, opens a browser, uses the current directory as a project, and keeps running in this terminal.",
    );
    if !confirm("Start T3 Code now with `bunx t3@latest`? [Y/n] ")? {
        ui.muted("Skipped T3 Code. Start it whenever you're ready with `bunx t3@latest`.");
        return Ok(());
    }
    let bunx = find_program("bunx").context(
        "`bunx` is required; install Bun from https://bun.sh, or use T3 Code's official `npx t3@latest` command",
    )?;
    ensure_t3_build_tools(ui, &bunx)?;
    let temporary = config::dir()?.join("tmp");
    let _ = std::fs::remove_dir_all(&temporary);
    std::fs::create_dir_all(&temporary).context("create T3 Code temporary directory")?;
    ui.muted("Starting T3 Code. It will keep running here; press Ctrl-C to stop it.");
    let result = Command::new(bunx)
        .args(["t3@latest"])
        .env("TMPDIR", &temporary)
        .status();
    let _ = std::fs::remove_dir_all(temporary);
    let status = result.context("run `bunx t3@latest`")?;
    if !status.success() {
        bail!("`bunx t3@latest` exited with {status}")
    }
    Ok(())
}

fn ensure_t3_build_tools(ui: Ui, bunx: &Path) -> Result<()> {
    let build_tools_ready =
        available("make") && (available("c++") || available("g++")) && available("python3");
    if !build_tools_ready {
        ui.muted("T3 Code needs native build tools on this machine. Installing them now…");
        if cfg!(target_os = "linux") && available("apt-get") {
            checked(elevated("apt-get", &["update"]), "update apt packages")?;
            checked(
                elevated("apt-get", &["install", "-y", "build-essential", "python3"]),
                "install T3 Code build tools",
            )?;
        } else if cfg!(target_os = "linux") && available("dnf") {
            checked(
                elevated("dnf", &["install", "-y", "gcc-c++", "make", "python3"]),
                "install T3 Code build tools",
            )?;
        } else if cfg!(target_os = "linux") && available("pacman") {
            checked(
                elevated(
                    "pacman",
                    &["-S", "--needed", "--noconfirm", "base-devel", "python"],
                ),
                "install T3 Code build tools",
            )?;
        } else {
            bail!("install a C++ compiler, make, and Python 3, then run `bunx t3@latest`")
        }
    }

    if !available("python3") {
        bail!("Python 3 is required to build T3 Code's terminal dependency")
    }
    if !available("node-gyp") {
        let bun = find_program("bun")
            .or_else(|| {
                let sibling = bunx.with_file_name("bun");
                sibling.is_file().then_some(sibling)
            })
            .context("`bun` is required to install T3 Code's native build helper")?;
        ui.muted("Installing T3 Code's native build helper with `bun add --global node-gyp`…");
        let mut command = Command::new(bun);
        command.args(["add", "--global", "node-gyp"]);
        checked(command, "install node-gyp for T3 Code")?;
    }
    Ok(())
}

fn confirmation(answer: &str) -> Option<bool> {
    match answer.trim().to_ascii_lowercase().as_str() {
        "" | "y" | "yes" => Some(true),
        "n" | "no" => Some(false),
        _ => None,
    }
}

fn install_codex(ui: Ui) -> Result<PathBuf> {
    ensure_curl()?;
    ui.muted("Installing Codex CLI…");
    let mut installer = Command::new("sh");
    installer
        .arg("-c")
        .arg("curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh");
    checked(installer, "install Codex CLI")?;

    let executable = find_program("codex")
        .or_else(|| {
            config::home()
                .ok()
                .map(|home| home.join(".local/bin/codex"))
        })
        .or_else(|| {
            config::home()
                .ok()
                .map(|home| home.join(".codex/packages/standalone/current/codex"))
        })
        .filter(|path| path.is_file())
        .context("Codex was installed but its executable could not be found")?;
    ui.success("Codex CLI installed");
    Ok(executable)
}

fn ensure_curl() -> Result<()> {
    if available("curl") {
        return Ok(());
    }

    println!("curl is required for the Codex installer. Installing it…");
    if cfg!(target_os = "linux") && available("apt-get") {
        checked(elevated("apt-get", &["update"]), "update apt packages")?;
        checked(
            elevated("apt-get", &["install", "-y", "curl"]),
            "install curl",
        )?;
    } else if cfg!(target_os = "linux") && available("dnf") {
        checked(elevated("dnf", &["install", "-y", "curl"]), "install curl")?;
    } else if cfg!(target_os = "linux") && available("pacman") {
        checked(
            elevated("pacman", &["-S", "--needed", "--noconfirm", "curl"]),
            "install curl",
        )?;
    } else {
        bail!("automatic Codex installation requires curl")
    }

    if !available("curl") {
        bail!("curl is still unavailable after installation")
    }
    Ok(())
}

fn find_program(program: &str) -> Option<PathBuf> {
    let output = Command::new("sh")
        .args(["-c", "command -v \"$1\"", "fleet", program])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
}

fn run_codex_login(executable: &Path) -> Result<()> {
    match Command::new(executable).arg("login").status() {
        Ok(status) if status.success() => Ok(()),
        Ok(_) => bail!("`codex login` did not complete"),
        Err(error) => Err(error).context("start `codex login`"),
    }
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
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if !ssh {
        checked_quiet(
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

fn checked_quiet(mut command: Command, label: &str) -> Result<()> {
    let output = command.output().with_context(|| label.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        bail!("{label} failed: {}", detail.trim())
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{confirmation, parse_color, parse_peer_selection};
    use crate::ui::DeviceColor;

    #[test]
    fn codex_login_defaults_to_yes() {
        assert_eq!(confirmation("\n"), Some(true));
        assert_eq!(confirmation("Y"), Some(true));
        assert_eq!(confirmation("yes"), Some(true));
        assert_eq!(confirmation("n"), Some(false));
        assert_eq!(confirmation("NO"), Some(false));
        assert_eq!(confirmation("maybe"), None);
    }

    #[test]
    fn color_choices_accept_names_and_numbers() {
        assert_eq!(parse_color("1"), Some(DeviceColor::Emerald));
        assert_eq!(parse_color("cyan"), Some(DeviceColor::Cyan));
        assert_eq!(parse_color("  VIOLET "), Some(DeviceColor::Violet));
        assert_eq!(parse_color("7"), None);
        assert_eq!(parse_color("orange"), None);
    }

    #[test]
    fn peer_choices_accept_none_all_and_unique_numbers() {
        assert_eq!(
            parse_peer_selection("none", 3).unwrap(),
            Vec::<usize>::new()
        );
        assert_eq!(parse_peer_selection("all", 3).unwrap(), vec![0, 1, 2]);
        assert_eq!(parse_peer_selection("3, 1, 3", 3).unwrap(), vec![2, 0]);
        assert!(parse_peer_selection("4", 3).is_err());
        assert!(parse_peer_selection("studio", 3).is_err());
    }
}
