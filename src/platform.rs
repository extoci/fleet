use crate::cli::{Color, Tool};
use crate::state::{StatePaths, atomic_write};
use anyhow::{Context, Result, bail};
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{IpAddr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub struct Platform {
    pub dry_run: bool,
    kind: PlatformKind,
    setup_log: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlatformKind {
    MacOs,
    DebianSystemd,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PlannedCommand {
    privileged: bool,
    program: &'static str,
    args: Vec<String>,
}

impl Platform {
    pub fn new(dry_run: bool) -> Result<Self> {
        let kind = match std::env::consts::OS {
            "macos" => PlatformKind::MacOs,
            "linux" => PlatformKind::DebianSystemd,
            _ => bail!("Fleet v0 supports macOS and Linux only"),
        };
        let setup_log = StatePaths::discover()?.logs_dir().join("setup.log");
        Ok(Self {
            dry_run,
            kind,
            setup_log,
        })
    }

    pub fn os_name(&self) -> String {
        std::env::consts::OS.to_owned()
    }

    pub fn arch(&self) -> String {
        std::env::consts::ARCH.to_owned()
    }

    pub fn current_user(&self) -> Result<String> {
        let output = Command::new("id")
            .arg("-un")
            .output()
            .context("determine the current user with `id -un`")?;
        if !output.status.success() {
            bail!("`id -un` failed with {}", output.status);
        }
        let user = String::from_utf8(output.stdout)
            .context("`id -un` returned non-UTF-8 output")?
            .trim()
            .to_owned();
        if user.is_empty()
            || !user
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        {
            bail!("current SSH username is unsupported: {user:?}");
        }
        Ok(user)
    }

    pub fn current_hostname(&self) -> Result<String> {
        let name = hostname::get().context("read hostname")?;
        Ok(name
            .to_string_lossy()
            .split('.')
            .next()
            .unwrap_or_default()
            .to_owned())
    }

    pub fn active_shell(&self) -> Result<Shell> {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        match Path::new(&shell).file_name().and_then(OsStr::to_str) {
            Some("bash") => Ok(Shell::Bash),
            Some("zsh") => Ok(Shell::Zsh),
            _ => bail!("Fleet v0 supports Bash and Zsh; current shell is {shell}"),
        }
    }

    pub fn preflight(&self) -> Result<()> {
        if self.kind == PlatformKind::DebianSystemd {
            self.require_linux_systemd_apt()?;
        }
        let required: &[&str] = match self.kind {
            PlatformKind::MacOs => &[
                "sudo",
                "id",
                "scutil",
                "systemsetup",
                "dns-sd",
                "ssh-keygen",
            ],
            PlatformKind::DebianSystemd => &[
                "sudo",
                "id",
                "apt-get",
                "systemctl",
                "hostnamectl",
                "getent",
                "ssh-keygen",
            ],
        };
        for command in required {
            if which::which(command).is_err() {
                bail!("Fleet requires `{command}` on this platform");
            }
        }
        if self.kind == PlatformKind::MacOs
            && which::which("tmux").is_err()
            && which::which("brew").is_err()
        {
            bail!("tmux is missing; install Homebrew or tmux, then rerun Fleet");
        }
        Ok(())
    }

    fn resolved_name_addresses(&self, name: &str) -> Vec<IpAddr> {
        let host = format!("{name}.local");
        let mut command = if self.kind == PlatformKind::MacOs {
            let mut command = Command::new("dscacheutil");
            command.args(["-q", "host", "-a", "name", &host]);
            command
        } else {
            let mut command = Command::new("avahi-resolve-host-name");
            command.args(["--", &host]);
            command
        };
        let Some(output) = output_with_timeout(&mut command, Duration::from_secs(1)) else {
            return Vec::new();
        };
        if !output.status.success() {
            return Vec::new();
        }
        let mut addresses: Vec<_> = String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .filter_map(|field| {
                field
                    .split_once('%')
                    .map_or(field, |(address, _)| address)
                    .parse()
                    .ok()
            })
            .collect();
        addresses.sort();
        addresses.dedup();
        addresses
    }

    pub fn name_conflicts(&self, name: &str) -> Result<bool> {
        let resolved = self.resolved_name_addresses(name);
        if resolved.is_empty() {
            return Ok(false);
        }
        let current_hostname = self.current_hostname()?;
        let local: Vec<_> = if_addrs::get_if_addrs()
            .context("read local network interfaces")?
            .into_iter()
            .map(|interface| interface.ip())
            .collect();
        Ok(name_conflicts_for_machine(
            name,
            &current_hostname,
            &resolved,
            &local,
        ))
    }

    pub fn set_hostname_and_mdns(&self, name: &str) -> Result<()> {
        if self.kind == PlatformKind::DebianSystemd {
            self.require_linux_systemd_apt()?;
        }
        for command in hostname_plan(self.kind, name) {
            self.run_planned(command)?;
        }
        Ok(())
    }

    pub fn ensure_discovery(&self) -> Result<()> {
        if self.kind == PlatformKind::MacOs {
            if which::which("dns-sd").is_err() {
                bail!("macOS DNS-SD utility is unavailable");
            }
            return Ok(());
        }
        self.require_linux_systemd_apt()?;
        self.run_sudo("apt-get", ["update"])?;
        self.run_sudo(
            "apt-get",
            [
                "install",
                "-y",
                "avahi-daemon",
                "avahi-utils",
                "libnss-mdns",
            ],
        )?;
        self.run_sudo("systemctl", ["enable", "--now", "avahi-daemon"])
    }

    pub fn ensure_ssh_server(&self) -> Result<()> {
        if self.kind == PlatformKind::DebianSystemd {
            self.require_linux_systemd_apt()?;
        }
        for command in ssh_server_plan(self.kind) {
            self.run_planned(command)?;
        }
        Ok(())
    }

    pub fn ensure_tmux(&self) -> Result<()> {
        if which::which("tmux").is_ok() {
            return Ok(());
        }
        if self.kind == PlatformKind::MacOs {
            if which::which("brew").is_err() {
                bail!("tmux is missing; install Homebrew or tmux, then rerun Fleet");
            }
            self.run_quiet("brew", ["install", "tmux"])
        } else {
            self.require_linux_systemd_apt()?;
            self.run_sudo("apt-get", ["update"])?;
            self.run_sudo("apt-get", ["install", "-y", "tmux"])
        }
    }

    pub fn install_shell_theme(
        &self,
        paths: &StatePaths,
        shell: Shell,
        name: &str,
        color: Color,
    ) -> Result<()> {
        let init = render_shell_init(name, color);
        let tmux = render_tmux(name, color);
        if self.dry_run {
            println!(
                "Would write {} and configure {}",
                paths.shell_dir().display(),
                shell.name()
            );
            return Ok(());
        }
        fs::create_dir_all(paths.shell_dir()).context("create Fleet shell directory")?;
        atomic_write(&paths.shell_dir().join("init.sh"), init.as_bytes(), 0o644)?;
        atomic_write(&paths.shell_dir().join("tmux.conf"), tmux.as_bytes(), 0o644)?;

        let home = dirs::home_dir().context("could not determine home directory")?;
        let rc = home.join(shell.rc_file());
        append_marked_line(
            &rc,
            "# Fleet shell integration",
            "[ -f \"$HOME/.fleet/shell/init.sh\" ] && . \"$HOME/.fleet/shell/init.sh\"",
        )?;
        append_marked_line(
            &home.join(".tmux.conf"),
            "# Fleet tmux integration",
            "source-file ~/.fleet/shell/tmux.conf",
        )?;
        if which::which("tmux").is_ok()
            && Command::new("tmux")
                .arg("list-sessions")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        {
            let _ = Command::new("tmux")
                .args([
                    "source-file",
                    &paths.shell_dir().join("tmux.conf").to_string_lossy(),
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        Ok(())
    }

    pub fn authorize_captain(&self, public_key: &str) -> Result<()> {
        let home = dirs::home_dir().context("could not determine home directory")?;
        let ssh = home.join(".ssh");
        if self.dry_run {
            println!(
                "Would authorize captain key in {}",
                ssh.join("authorized_keys").display()
            );
            return Ok(());
        }
        fs::create_dir_all(&ssh).context("create .ssh directory")?;
        set_mode(&ssh, 0o700)?;
        let path = ssh.join("authorized_keys");
        let existing = fs::read_to_string(&path).unwrap_or_default();
        let next = authorize_key_text(&existing, public_key)?;
        if next == existing {
            return Ok(());
        }
        atomic_write(&path, next.as_bytes(), 0o600)
    }

    pub fn remove_captain_authorization(&self, public_key: &str) -> Result<()> {
        let path = dirs::home_dir()
            .context("could not determine home directory")?
            .join(".ssh/authorized_keys");
        if !path.exists() {
            return Ok(());
        }
        if self.dry_run {
            println!("Would remove captain key from {}", path.display());
            return Ok(());
        }
        let existing = fs::read_to_string(&path).context("read authorized_keys")?;
        let next = remove_authorized_key_text(&existing, public_key)?;
        atomic_write(&path, next.as_bytes(), 0o600)
    }

    pub fn ssh_host_key(&self) -> Result<Option<String>> {
        for path in [
            "/etc/ssh/ssh_host_ed25519_key.pub",
            "/private/etc/ssh/ssh_host_ed25519_key.pub",
        ] {
            if let Ok(value) = fs::read_to_string(path) {
                return Ok(Some(value.trim().to_owned()));
            }
        }
        Ok(None)
    }

    pub fn tool_installed(&self, tool: Tool) -> bool {
        self.tool_path(tool).is_some()
    }

    pub fn install_tool(&self, tool: Tool) -> Result<()> {
        if self.tool_installed(tool) {
            return Ok(());
        }
        let command = match tool {
            Tool::Codex => "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
            Tool::ClaudeCode => "curl -fsSL https://claude.ai/install.sh | bash",
        };
        if self.dry_run {
            println!(
                "Would install {} with its official installer",
                tool.display_name()
            );
            return Ok(());
        }
        let status = Command::new("sh")
            .args(["-c", command])
            // Installers should only install. Fleet owns the separate login prompt so a
            // declined prompt cannot be followed by an unexpected authentication flow.
            .env("NON_INTERACTIVE", "1")
            .status()
            .with_context(|| format!("launch {} installer", tool.display_name()))?;
        if !status.success() {
            bail!("{} installer failed with {status}", tool.display_name());
        }
        if self.tool_path(tool).is_none() {
            bail!(
                "{} installer finished but `{}` was not found in PATH or ~/.local/bin",
                tool.display_name(),
                tool.command()
            );
        }
        Ok(())
    }

    pub fn login_tool(&self, tool: Tool) -> Result<()> {
        let args: &[&str] = match tool {
            Tool::Codex => &["login"],
            Tool::ClaudeCode => &["auth", "login"],
        };
        let executable = self
            .tool_path(tool)
            .with_context(|| format!("{} is not installed", tool.display_name()))?;
        self.run(&executable.to_string_lossy(), args.iter().copied())
    }

    fn tool_path(&self, tool: Tool) -> Option<std::path::PathBuf> {
        which::which(tool.command()).ok().or_else(|| {
            let path = dirs::home_dir()?.join(".local/bin").join(tool.command());
            path.is_file().then_some(path)
        })
    }

    pub fn install_captain_service(&self, paths: &StatePaths) -> Result<()> {
        let executable = std::env::current_exe().context("locate Fleet executable")?;
        if self.kind == PlatformKind::MacOs {
            let home = dirs::home_dir().context("could not determine home directory")?;
            let service_path = home.join("Library/LaunchAgents/dev.fleet.captain.plist");
            let plist = render_launch_agent(&executable, paths);
            if self.dry_run {
                println!("Would install {}", service_path.display());
                return Ok(());
            }
            atomic_write(&service_path, plist.as_bytes(), 0o644)?;
            let domain = format!("gui/{}", unsafe { libc_geteuid() });
            run_best_effort(
                "launchctl",
                ["bootout", &domain, &service_path.to_string_lossy()],
            );
            self.run_quiet(
                "launchctl",
                ["bootstrap", &domain, &service_path.to_string_lossy()],
            )?;
        } else {
            self.require_linux_systemd_apt()?;
            let home = dirs::home_dir().context("could not determine home directory")?;
            let service_path = home.join(".config/systemd/user/fleet-captain.service");
            let unit = render_systemd_user_unit(&executable);
            if self.dry_run {
                println!("Would install {}", service_path.display());
                return Ok(());
            }
            atomic_write(&service_path, unit.as_bytes(), 0o644)?;
            self.run_quiet("systemctl", ["--user", "daemon-reload"])?;
            self.run_quiet(
                "systemctl",
                ["--user", "enable", "--now", "fleet-captain.service"],
            )?;
            self.run_quiet("systemctl", ["--user", "restart", "fleet-captain.service"])?;
        }
        Ok(())
    }

    pub fn stop_captain_service(&self) -> Result<()> {
        if self.kind == PlatformKind::MacOs {
            let home = dirs::home_dir().context("could not determine home directory")?;
            let path = home.join("Library/LaunchAgents/dev.fleet.captain.plist");
            if path.exists() {
                let domain = format!("gui/{}", unsafe { libc_geteuid() });
                if self.dry_run {
                    self.run("launchctl", ["bootout", &domain, &path.to_string_lossy()])?;
                } else {
                    run_best_effort("launchctl", ["bootout", &domain, &path.to_string_lossy()]);
                    fs::remove_file(path)?;
                }
            }
        } else {
            let _ = self.run_quiet(
                "systemctl",
                ["--user", "disable", "--now", "fleet-captain.service"],
            );
        }
        Ok(())
    }

    pub fn restart_captain_service(&self) -> Result<()> {
        if self.kind == PlatformKind::MacOs {
            let target = format!("gui/{}/dev.fleet.captain", unsafe { libc_geteuid() });
            self.run("launchctl", ["kickstart", "-k", &target])
        } else {
            self.require_linux_systemd_apt()?;
            self.run("systemctl", ["--user", "restart", "fleet-captain.service"])
        }
    }

    fn require_linux_systemd_apt(&self) -> Result<()> {
        if self.kind == PlatformKind::DebianSystemd
            && (which::which("systemctl").is_err() || which::which("apt-get").is_err())
        {
            bail!("Fleet v0 Linux support requires a Debian/Ubuntu system with systemd and apt");
        }
        if self.kind == PlatformKind::DebianSystemd && !self.dry_run {
            if !Path::new("/run/systemd/system").is_dir() {
                bail!("Fleet v0 Linux support requires systemd as the running init system");
            }
            let release = fs::read_to_string("/etc/os-release")
                .context("read /etc/os-release to verify Linux support")?;
            let supported = release.lines().any(|line| {
                matches!(line, "ID=debian" | "ID=ubuntu")
                    || (line.starts_with("ID_LIKE=")
                        && (line.contains("debian") || line.contains("ubuntu")))
            });
            if !supported {
                bail!("Fleet v0 Linux support is limited to Debian/Ubuntu-family systems");
            }
        }
        Ok(())
    }

    fn run<I, S>(&self, program: &str, args: I) -> Result<()>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let args: Vec<_> = args
            .into_iter()
            .map(|value| value.as_ref().to_owned())
            .collect();
        if self.dry_run {
            println!(
                "Would run: {} {}",
                program,
                args.iter()
                    .map(|arg| arg.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            return Ok(());
        }
        let status = Command::new(program)
            .args(&args)
            .status()
            .with_context(|| format!("run {program}"))?;
        if !status.success() {
            bail!("{program} failed with {status}");
        }
        Ok(())
    }

    fn run_sudo<I, S>(&self, program: &str, args: I) -> Result<()>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        if self.dry_run {
            let mut all = vec![program.to_owned()];
            all.extend(
                args.into_iter()
                    .map(|value| value.as_ref().to_string_lossy().into_owned()),
            );
            return self.run("sudo", all);
        }
        let authenticated = Command::new("sudo")
            .args(["-n", "true"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if !authenticated {
            self.run("sudo", ["-v"])?;
        }
        let mut all = vec![std::ffi::OsString::from("-n"), program.into()];
        all.extend(args.into_iter().map(|value| value.as_ref().to_owned()));
        run_setup_command(&self.setup_log, "sudo", &all)
    }

    fn run_planned(&self, command: PlannedCommand) -> Result<()> {
        if command.privileged {
            self.run_sudo(command.program, command.args)
        } else {
            self.run_quiet(command.program, command.args)
        }
    }

    fn run_quiet<I, S>(&self, program: &str, args: I) -> Result<()>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let args: Vec<_> = args
            .into_iter()
            .map(|value| value.as_ref().to_owned())
            .collect();
        if self.dry_run {
            return self.run(program, args);
        }
        run_setup_command(&self.setup_log, program, &args)
    }
}

fn name_conflicts_from_addresses(resolved: &[IpAddr], local: &[IpAddr]) -> bool {
    resolved.iter().any(|resolved_address| {
        let resolved_address = without_macos_link_local_scope(*resolved_address);
        !local
            .iter()
            .any(|local_address| without_macos_link_local_scope(*local_address) == resolved_address)
    })
}

fn name_conflicts_for_machine(
    requested_name: &str,
    current_hostname: &str,
    resolved: &[IpAddr],
    local: &[IpAddr],
) -> bool {
    // There is no rename to validate when Fleet keeps the machine's current
    // hostname. Resolver caches and temporary interface addresses can otherwise
    // make the machine's own mDNS record look remote on both macOS and Linux.
    if requested_name.eq_ignore_ascii_case(current_hostname) {
        return false;
    }
    name_conflicts_from_addresses(resolved, local)
}

fn without_macos_link_local_scope(address: IpAddr) -> IpAddr {
    let IpAddr::V6(address) = address else {
        return address;
    };
    let mut segments = address.segments();
    if segments[0] == 0xfe80 && segments[1] != 0 && segments[2] == 0 && segments[3] == 0 {
        segments[1] = 0;
        return IpAddr::V6(Ipv6Addr::from(segments));
    }
    IpAddr::V6(address)
}

fn planned(privileged: bool, program: &'static str, args: &[&str]) -> PlannedCommand {
    PlannedCommand {
        privileged,
        program,
        args: args.iter().map(|value| (*value).to_owned()).collect(),
    }
}

fn hostname_plan(kind: PlatformKind, name: &str) -> Vec<PlannedCommand> {
    match kind {
        PlatformKind::MacOs => ["ComputerName", "LocalHostName", "HostName"]
            .into_iter()
            .map(|key| planned(true, "scutil", &["--set", key, name]))
            .collect(),
        PlatformKind::DebianSystemd => vec![
            planned(true, "hostnamectl", &["hostname", name]),
            planned(true, "systemctl", &["enable", "--now", "avahi-daemon"]),
            planned(true, "systemctl", &["restart", "avahi-daemon"]),
        ],
    }
}

fn ssh_server_plan(kind: PlatformKind) -> Vec<PlannedCommand> {
    match kind {
        PlatformKind::MacOs => vec![planned(true, "systemsetup", &["-setremotelogin", "on"])],
        PlatformKind::DebianSystemd => vec![
            planned(true, "apt-get", &["update"]),
            planned(true, "apt-get", &["install", "-y", "openssh-server"]),
            planned(true, "systemctl", &["enable", "--now", "ssh"]),
        ],
    }
}

fn output_with_timeout(command: &mut Command, timeout: Duration) -> Option<std::process::Output> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    while started.elapsed() < timeout {
        if child.try_wait().ok().flatten().is_some() {
            return child.wait_with_output().ok();
        }
        thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill();
    child.wait_with_output().ok()
}

fn run_best_effort<I, S>(program: &str, args: I)
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let _ = Command::new(program)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn run_setup_command(log_path: &Path, program: &str, args: &[std::ffi::OsString]) -> Result<()> {
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).context("create Fleet setup log directory")?;
    }
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("run {program}"))?;
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .with_context(|| format!("open {}", log_path.display()))?;
    set_mode(log_path, 0o600)?;
    writeln!(
        log,
        "\n$ {} {}",
        program,
        args.iter()
            .map(|arg| arg.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ")
    )?;
    log.write_all(&output.stdout)?;
    log.write_all(&output.stderr)?;
    if !output.status.success() {
        bail!(
            "{program} failed with {}; details: {}",
            output.status,
            log_path.display()
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
pub enum Shell {
    Bash,
    Zsh,
}

impl Shell {
    fn name(self) -> &'static str {
        match self {
            Self::Bash => "Bash",
            Self::Zsh => "Zsh",
        }
    }
    fn rc_file(self) -> &'static str {
        match self {
            Self::Bash => ".bashrc",
            Self::Zsh => ".zshrc",
        }
    }
}

fn render_shell_init(name: &str, color: Color) -> String {
    format!(
        r#"# Generated by Fleet. Preserved by `fleet leave`.
export FLEET_MACHINE_NAME='{name}'
export FLEET_MACHINE_COLOR='{color}'
export FLEET_MACHINE_COLOR_256='{code}'

fleet_git_branch() {{
  if command -v vcprompt >/dev/null 2>&1; then
    vcprompt -f '(%b) ' 2>/dev/null
  else
    git branch --show-current 2>/dev/null | sed 's/.*/(&) /'
  fi
}}

if [ -n "${{ZSH_VERSION:-}}" ]; then
  fleet_zsh_prompt() {{
    local branch path
    path=${{PWD/#$HOME/~}}
    if [ "$path" != "~" ]; then
      path="${{path##*/}}"
    fi
    branch="$(fleet_git_branch)"
    print -Pn "\e]0;${{FLEET_MACHINE_NAME}}: ${{PWD/#$HOME/~}}\a"
    PROMPT="%B%F{{{code}}} ◆ %f%b ${{path}}/ %F{{{code}}}${{branch}}%f "
  }}
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd fleet_zsh_prompt
  fleet_zsh_prompt
elif [ -n "${{BASH_VERSION:-}}" ]; then
  fleet_bash_prompt() {{
    local branch path
    path=${{PWD/#$HOME/~}}
    if [ "$path" != "~" ]; then
      path="${{path##*/}}"
    fi
    branch="$(fleet_git_branch)"
    PS1="\[\e]0;${{FLEET_MACHINE_NAME}}: ${{PWD/#$HOME/~}}\a\]\[\033[1;38;5;{code}m\] ◆ \[\033[0m\] ${{path}}/ \[\033[38;5;{code}m\]${{branch}}\[\033[0m\] "
  }}
  PROMPT_COMMAND=fleet_bash_prompt
fi

if [ "${{TERM:-}}" = xterm-ghostty ] \
  && ! infocmp xterm-ghostty >/dev/null 2>&1; then
  export TERM=xterm-256color
fi

case $- in
  *i*)
    if [ -n "${{SSH_CONNECTION:-}}" ] \
      && [ -t 0 ] && [ -t 1 ] \
      && [ -z "${{TMUX:-}}" ] \
      && [ -z "${{NO_TMUX:-}}" ] \
      && command -v tmux >/dev/null 2>&1; then
      exec tmux new-session -A -s fleet
    fi
    ;;
esac
"#,
        code = color.ansi_256()
    )
}

fn render_tmux(machine_name: &str, color: Color) -> String {
    format!(
        r#"# Generated by Fleet. Preserved by `fleet leave`.
set-option -g status on
set-option -g status-style "bg=colour{code},fg=colour{foreground}"
set-option -g status-left " #[bold]{name} #[default]"
set-option -g status-left-length 30
set-option -g status-right " #[fg=colour231]%Y-%m-%d %H:%M "
set-option -g pane-border-style "fg=colour{code}"
set-option -g pane-active-border-style "fg=colour{code}"
"#,
        code = color.ansi_256(),
        foreground = color.tmux_foreground_256(),
        name = machine_name
    )
}

fn append_marked_line(path: &Path, marker: &str, line: &str) -> Result<()> {
    let existing = fs::read_to_string(path).unwrap_or_default();
    if existing.lines().any(|candidate| candidate.trim() == line) {
        return Ok(());
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(marker);
    next.push('\n');
    next.push_str(line);
    next.push('\n');
    atomic_write(path, next.as_bytes(), existing_mode(path, 0o644))
}

#[cfg(unix)]
fn existing_mode(path: &Path, default: u32) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|metadata| metadata.permissions().mode() & 0o777)
        .unwrap_or(default)
}

#[cfg(not(unix))]
fn existing_mode(_path: &Path, default: u32) -> u32 {
    default
}

fn key_material(line: &str) -> Result<String> {
    crate::identity::public_key_material(line)
}

fn authorize_key_text(existing: &str, public_key: &str) -> Result<String> {
    let target = key_material(public_key)?;
    let (algorithm, encoded) = target
        .split_once(' ')
        .context("canonical SSH public key is malformed")?;
    let mut retained = Vec::new();
    let mut found = false;
    for line in existing.lines() {
        match key_material(line) {
            Ok(material) if material == target => {
                if !found {
                    retained.push(format!("{target} fleet-captain"));
                    found = true;
                }
            }
            _ if contains_key_tokens(line, algorithm, encoded) => {
                bail!(
                    "the captain key already exists with authorized_keys options; remove or review that entry before joining Fleet"
                );
            }
            _ => retained.push(line.to_owned()),
        }
    }
    if !found {
        retained.push(format!("{target} fleet-captain"));
    }
    let mut next = retained.join("\n");
    if !next.is_empty() {
        next.push('\n');
    }
    Ok(next)
}

fn remove_authorized_key_text(existing: &str, public_key: &str) -> Result<String> {
    let target = key_material(public_key)?;
    let retained: Vec<_> = existing
        .lines()
        .filter(|line| {
            !(key_material(line).ok().as_deref() == Some(&target)
                && line
                    .split_whitespace()
                    .skip(2)
                    .any(|field| field == "fleet-captain"))
        })
        .collect();
    let mut next = retained.join("\n");
    if !next.is_empty() {
        next.push('\n');
    }
    Ok(next)
}

fn contains_key_tokens(line: &str, algorithm: &str, encoded: &str) -> bool {
    let fields: Vec<_> = line.split_whitespace().collect();
    fields.windows(2).any(|pair| pair == [algorithm, encoded])
}

fn render_launch_agent(executable: &Path, paths: &StatePaths) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.fleet.captain</string>
<key>ProgramArguments</key><array><string>{}</string><string>daemon</string></array>
<key>KeepAlive</key><true/>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>{}/captain.log</string>
<key>StandardErrorPath</key><string>{}/captain.error.log</string>
</dict></plist>
"#,
        xml_escape(&executable.display().to_string()),
        xml_escape(&paths.logs_dir().display().to_string()),
        xml_escape(&paths.logs_dir().display().to_string())
    )
}

fn render_systemd_user_unit(executable: &Path) -> String {
    format!(
        r#"[Unit]
Description=Fleet captain discovery and registration service
After=network-online.target

[Service]
ExecStart={} daemon
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
"#,
        systemd_quote(&executable.display().to_string())
    )
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn systemd_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .with_context(|| format!("set permissions on {}", path.display()))
}

#[cfg(target_family = "unix")]
unsafe fn libc_geteuid() -> u32 {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    unsafe { geteuid() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_command_output_is_logged_instead_of_printed() {
        let temp = tempfile::tempdir().unwrap();
        let log = temp.path().join("setup.log");
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "platform::tests::setup_command_output_child",
                "--nocapture",
            ])
            .env("FLEET_SETUP_OUTPUT_CHILD", &log)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("apt-spam"));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("systemd-spam"));
        let logged = fs::read_to_string(log).unwrap();
        assert!(logged.contains("apt-spam"));
        assert!(logged.contains("systemd-spam"));
    }

    #[test]
    fn setup_command_output_child() {
        let Some(log) = std::env::var_os("FLEET_SETUP_OUTPUT_CHILD") else {
            return;
        };
        run_setup_command(
            Path::new(&log),
            "sh",
            &[
                "-c".into(),
                "printf apt-spam; printf systemd-spam >&2".into(),
            ],
        )
        .unwrap();
    }

    #[test]
    fn best_effort_commands_do_not_leak_expected_errors() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "platform::tests::best_effort_command_child",
                "--nocapture",
            ])
            .env("FLEET_BEST_EFFORT_CHILD", "1")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("expected-launchd-error"));
    }

    #[test]
    fn best_effort_command_child() {
        if std::env::var_os("FLEET_BEST_EFFORT_CHILD").is_none() {
            return;
        }
        run_best_effort("sh", ["-c", "printf expected-launchd-error >&2; exit 5"]);
    }

    #[test]
    fn this_machines_own_addresses_are_not_a_name_collision() {
        let loopback = "127.0.0.1".parse().unwrap();
        let lan = "192.168.1.100".parse().unwrap();
        assert!(!name_conflicts_from_addresses(
            &[loopback, lan],
            &[loopback, lan]
        ));
    }

    #[test]
    fn macos_scoped_link_local_addresses_are_recognized_as_this_machine() {
        // dscacheutil inserts the interface index into the second hextet, while
        // getifaddrs reports the same address without that scope information.
        let resolved = [
            "fe80:1::1".parse().unwrap(),
            "fe80:b::105d:b1d1:d458:16d0".parse().unwrap(),
            "192.168.1.100".parse().unwrap(),
        ];
        let local = [
            "fe80::1".parse().unwrap(),
            "fe80::105d:b1d1:d458:16d0".parse().unwrap(),
            "192.168.1.100".parse().unwrap(),
        ];

        assert!(!name_conflicts_from_addresses(&resolved, &local));
    }

    #[test]
    fn same_hostname_is_a_collision_when_it_resolves_to_another_machine() {
        let other_machine = "192.168.1.69".parse().unwrap();
        let this_machine = "192.168.1.100".parse().unwrap();
        assert!(name_conflicts_for_machine(
            "powerbook",
            "workstation",
            &[other_machine],
            &[this_machine],
        ));
    }

    #[test]
    fn current_hostname_does_not_collide_with_its_own_mdns_record() {
        let stale_or_alternate_address = "192.168.1.69".parse().unwrap();
        let current_address = "192.168.1.100".parse().unwrap();

        assert!(!name_conflicts_for_machine(
            "powerbook",
            "powerbook",
            &[stale_or_alternate_address],
            &[current_address],
        ));
    }

    #[test]
    fn shell_attach_is_guarded() {
        let rendered = render_shell_init("test-machine", Color::Cyan);
        for guard in [
            "SSH_CONNECTION",
            "[ -t 0 ]",
            "[ -t 1 ]",
            "TMUX",
            "NO_TMUX",
            "case $-",
        ] {
            assert!(rendered.contains(guard));
        }
        assert!(rendered.contains("TERM:-}"));
        assert!(rendered.contains("infocmp xterm-ghostty"));
        assert!(rendered.contains("export TERM=xterm-256color"));
        assert!(rendered.contains("new-session -A -s fleet"));
    }

    #[test]
    fn fleet_prompts_have_one_machine_agnostic_shape() {
        for (name, color) in [("machine-one", Color::Red), ("machine-two", Color::Blue)] {
            let rendered = render_shell_init(name, color);
            let code = color.ansi_256();
            assert!(rendered.contains("fleet_git_branch()"));
            assert!(rendered.contains("path=${PWD/#$HOME/~}"));
            assert!(rendered.contains("path=\"${path##*/}\""));
            assert!(rendered.contains(&format!("38;5;{code}m\\] ◆ ")));
            assert!(rendered.contains("${path}/"));
            assert!(rendered.contains("${branch}"));
            assert!(!rendered.contains(r#"\u@\h"#));
            assert!(!rendered.contains("%n@%m"));
        }
    }

    #[test]
    fn rendered_bash_prompt_executes_and_shows_the_current_directory() {
        let temp = tempfile::tempdir().unwrap();
        let worktree = temp.path().join("sample-project");
        fs::create_dir(&worktree).unwrap();
        let init = temp.path().join("init.sh");
        fs::write(&init, render_shell_init("test-machine", Color::Cyan)).unwrap();

        let output = Command::new("bash")
            .args(["--noprofile", "--norc", "-c"])
            .arg(". \"$1\"; cd \"$2\"; fleet_bash_prompt; printf '%s\n' \"$PS1\"")
            .arg("fleet-prompt-test")
            .arg(&init)
            .arg(&worktree)
            .output()
            .unwrap();
        assert!(output.status.success());
        let prompt = String::from_utf8(output.stdout).unwrap();
        assert!(prompt.contains(" ◆ "));
        assert!(prompt.contains(" sample-project/ "));
        assert!(!prompt.contains("test-machine@"));
    }

    #[test]
    fn tmux_theme_uses_contrasting_foreground() {
        assert!(render_tmux("sun", Color::Yellow).contains("bg=colour220,fg=colour16"));
        assert!(render_tmux("violet", Color::Violet).contains("bg=colour99,fg=colour231"));
    }

    #[test]
    fn marked_line_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rc");
        append_marked_line(&path, "# Fleet", ". ~/.fleet/init.sh").unwrap();
        append_marked_line(&path, "# Fleet", ". ~/.fleet/init.sh").unwrap();
        assert_eq!(
            fs::read_to_string(&path)
                .unwrap()
                .matches(". ~/.fleet/init.sh")
                .count(),
            1
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            append_marked_line(&path, "# Another", ". ~/.fleet/another.sh").unwrap();
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn captain_key_removal_matches_material() {
        let one =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElmqI4v+7cZFSmB7soOSl3vymQTl8v7/15ZnHH2DA4d";
        let two =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIChI5Jpps7nIfSzIzaEtYx3aDU8IrgbGEmIcKJJE86la";
        assert_eq!(
            key_material(&format!("{one} one")).unwrap(),
            key_material(&format!("{one} two")).unwrap()
        );
        assert_ne!(key_material(one).unwrap(), key_material(two).unwrap());
    }

    #[test]
    fn authorized_key_is_adopted_deduplicated_and_removed_by_marker() {
        let key =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElmqI4v+7cZFSmB7soOSl3vymQTl8v7/15ZnHH2DA4d";
        let existing = format!("ssh-ed25519 OTHER unrelated\n{key} old-comment\n{key} duplicate\n");
        let authorized = authorize_key_text(&existing, key).unwrap();
        assert_eq!(authorized.matches(key).count(), 1);
        assert!(authorized.contains(&format!("{key} fleet-captain")));
        assert!(authorized.contains("ssh-ed25519 OTHER unrelated"));
        let removed = remove_authorized_key_text(&authorized, key).unwrap();
        assert!(!removed.contains(key));
        assert!(removed.contains("ssh-ed25519 OTHER unrelated"));
    }

    #[test]
    fn authorized_key_with_options_is_not_silently_rewritten() {
        let key =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElmqI4v+7cZFSmB7soOSl3vymQTl8v7/15ZnHH2DA4d";
        let existing = format!("from=\"192.0.2.1\" {key} restricted\n");
        assert!(
            authorize_key_text(&existing, key)
                .unwrap_err()
                .to_string()
                .contains("authorized_keys options")
        );
    }

    #[test]
    fn service_definitions_escape_paths() {
        let paths = StatePaths {
            root: "/tmp/a&b/.fleet".into(),
        };
        let launchd = render_launch_agent(Path::new("/tmp/a&b/fleet"), &paths);
        assert!(launchd.contains("/tmp/a&amp;b/fleet"));
        let systemd = render_systemd_user_unit(Path::new("/tmp/a b/fleet"));
        assert!(systemd.contains("ExecStart=\"/tmp/a b/fleet\" daemon"));
    }

    #[test]
    fn macos_system_mutations_are_inspectable_without_execution() {
        let hostname = hostname_plan(PlatformKind::MacOs, "emerald");
        assert_eq!(hostname.len(), 3);
        assert_eq!(hostname[0].program, "scutil");
        assert_eq!(hostname[0].args, ["--set", "ComputerName", "emerald"]);
        assert_eq!(hostname[1].args, ["--set", "LocalHostName", "emerald"]);
        assert_eq!(hostname[2].args, ["--set", "HostName", "emerald"]);

        let ssh = ssh_server_plan(PlatformKind::MacOs);
        assert_eq!(ssh.len(), 1);
        assert_eq!(ssh[0].program, "systemsetup");
        assert_eq!(ssh[0].args, ["-setremotelogin", "on"]);
        assert!(ssh[0].privileged);
    }

    #[test]
    fn linux_hostname_plan_does_not_reinstall_discovery_packages() {
        let hostname = hostname_plan(PlatformKind::DebianSystemd, "emerald");
        let rendered = hostname
            .iter()
            .map(|command| format!("{} {}", command.program, command.args.join(" ")))
            .collect::<Vec<_>>()
            .join("\n");
        for expected in [
            "hostnamectl hostname emerald",
            "systemctl restart avahi-daemon",
        ] {
            assert!(rendered.contains(expected), "missing {expected}");
        }
        assert!(!rendered.contains("apt-get"));
        assert!(
            ssh_server_plan(PlatformKind::DebianSystemd)
                .iter()
                .any(|command| command.args.iter().any(|arg| arg == "openssh-server"))
        );
    }
}
