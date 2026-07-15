use crate::cli::{Cli, Color, Command, InitArgs, JoinArgs, LeaveArgs, Tool};
use crate::discovery::{CaptainAdvertisement, DEFAULT_PORT};
use crate::identity;
use crate::platform::Platform;
use crate::service;
use crate::skill;
use crate::state::{
    LocalConfig, Machine, Role, STATE_VERSION, StatePaths, ToolState, validate_machine_name,
};
use anyhow::{Context, Result, bail};
use dialoguer::{Confirm, MultiSelect, Select, theme::ColorfulTheme};
use std::fs;
use std::io::{self, IsTerminal};
use uuid::Uuid;

pub fn run(cli: Cli) -> Result<()> {
    let paths = StatePaths::discover()?;
    match cli.command {
        Command::Init(args) => init(&paths, args),
        Command::Join(args) => join(&paths, args),
        Command::Status(args) => status(&paths, args.json),
        Command::Leave(args) => leave(&paths, args),
        Command::Daemon(args) => service::run(&paths, &args.listen),
    }
}

fn init(paths: &StatePaths, args: InitArgs) -> Result<()> {
    if let Some(config) = paths.load()? {
        return resume_init(paths, args, config);
    }
    paths.ensure_uninitialized()?;
    let platform = Platform::new(args.dry_run)?;
    let shell = platform.active_shell()?;
    platform.preflight()?;
    let current = platform.current_hostname()?;
    let name = choose_name(args.name, &current)?;
    let color = choose_color(args.color)?;

    let host = format!("{name}.local");
    let host_preview = colorize(&host, color, io::stdout().is_terminal());
    println!("\nFleet will initialize this machine as captain {host_preview} ({color}).");
    println!("Fleet will request sudo to set the system hostname and local-network identity.");
    if !args.yes
        && !Confirm::with_theme(&ColorfulTheme::default())
            .with_prompt("Continue?")
            .default(true)
            .interact()?
    {
        bail!("initialization cancelled");
    }

    if args.dry_run {
        println!(
            "Would create a Fleet identity, set the hostname, configure tmux/{}, install the Fleet skill, and start the captain service.",
            shell_name(shell)
        );
        return Ok(());
    }

    working("Preparing native local-network discovery");
    platform.ensure_discovery()?;
    completed("Native local-network discovery");
    if platform.name_conflicts(&name)? {
        bail!(
            "{}.local is already in use; choose another machine name",
            name
        );
    }
    let identity = identity::ensure(paths)?;
    completed("Fleet identity and dedicated SSH key");
    platform.set_hostname_and_mdns(&name)?;
    completed(&format!("System hostname and mDNS name: {name}.local"));
    platform.ensure_tmux()?;
    platform.install_shell_theme(paths, shell, &name, color)?;
    completed("Shell and tmux setup");
    let machine = local_machine(
        &platform,
        name,
        color,
        identity.public_key,
        detected_tools(&platform),
    )?;
    paths.save(&LocalConfig {
        version: STATE_VERSION,
        role: Role::Captain,
        machine,
        captain: None,
    })?;
    skill::initialize(paths)?;
    crate::ssh_client::initialize(paths)?;
    completed("Captain inventory, Fleet skill, and SSH client trust");
    fs::create_dir_all(paths.logs_dir())?;
    platform.install_captain_service(paths)?;
    verify_local_captain_service(paths)?;
    completed("Captain service and mDNS advertisement");

    println!(
        "\nCaptain ready at {}.local.",
        paths.require()?.machine.name
    );
    println!("On another machine, install Fleet and run `fleet join`.");
    println!("Captain discovery is available while this user is logged in.");
    Ok(())
}

fn join(paths: &StatePaths, args: JoinArgs) -> Result<()> {
    if let Some(config) = paths.load()? {
        return resume_join(paths, args, config);
    }
    paths.ensure_uninitialized()?;
    let platform = Platform::new(args.dry_run)?;
    let shell = platform.active_shell()?;
    platform.preflight()?;
    println!("Fleet may request sudo to prepare native local-network discovery.");
    working("Preparing native local-network discovery");
    platform.ensure_discovery()?;
    completed("Native local-network discovery");
    let captains = crate::discovery::discover(args.captain.as_deref())?;
    if captains.is_empty() {
        bail!("no Fleet captain was discovered on this local network");
    }
    let captain = choose_captain(captains)?;
    println!("\nCaptain found: {}", captain.host);
    println!("Identity: {}", captain.fingerprint);
    if !args.yes
        && !Confirm::with_theme(&ColorfulTheme::default())
            .with_prompt("Join this fleet? This trusts the captain on the current LAN")
            .default(true)
            .interact()?
    {
        bail!("join cancelled");
    }

    let current = platform.current_hostname()?;
    let name = choose_name(args.name, &current)?;
    let color = choose_color(args.color)?;
    if platform.name_conflicts(&name)? {
        bail!(
            "{}.local is already in use; choose another machine name",
            name
        );
    }
    let selected = choose_tools(&platform, &args.tool)?;

    println!(
        "Fleet will request sudo to set the hostname and enable native mDNS and Remote Login."
    );

    if args.dry_run {
        println!(
            "Would rename this machine to {name}.local, enable SSH, authorize {}, configure tmux/{}, install selected tools, and register with the captain.",
            captain.name,
            shell_name(shell)
        );
        return Ok(());
    }

    let identity = identity::ensure(paths)?;
    completed("Fleet identity");
    platform.set_hostname_and_mdns(&name)?;
    completed(&format!("System hostname and mDNS name: {name}.local"));
    platform.ensure_ssh_server()?;
    platform.authorize_captain(&captain.ssh_public_key)?;
    completed("OpenSSH server and captain authorization");
    platform.ensure_tmux()?;
    platform.install_shell_theme(paths, shell, &name, color)?;
    completed("Shell and tmux setup");

    let mut newly_installed = Vec::new();
    let mut tool_errors = Vec::new();
    for tool in selected {
        let existed = platform.tool_installed(tool);
        if let Err(error) = platform.install_tool(tool) {
            tool_errors.push(format!("{}: {error:#}", tool.display_name()));
        } else if !existed {
            newly_installed.push(tool);
        }
    }
    if !args.no_login {
        for tool in newly_installed {
            if let Err(error) = platform.login_tool(tool) {
                tool_errors.push(format!("{} login: {error:#}", tool.display_name()));
            }
        }
    }

    let tools = Tool::ALL
        .into_iter()
        .map(|tool| ToolState {
            tool,
            installed: platform.tool_installed(tool),
        })
        .collect();
    let mut machine = local_machine(&platform, name.clone(), color, identity.public_key, tools)?;
    machine.ssh_host_key = platform.ssh_host_key()?;
    let endpoint = args
        .captain
        .unwrap_or_else(|| format!("{}:{}", captain.host, captain.port));
    let config = LocalConfig {
        version: STATE_VERSION,
        role: Role::Member,
        machine,
        captain: Some(captain.captain_ref()),
    };
    paths.save(&config)?;
    completed("Local member state");
    service::register(&endpoint, &config.machine).with_context(|| {
        format!(
            "register with captain at {endpoint}; local setup is saved, so rerun `fleet join` after resolving connectivity"
        )
    })?;
    completed("Captain registration and pinned SSH verification");

    println!("\nJoined. From the captain, run `ssh {name}.local`.");
    for error in tool_errors {
        eprintln!("warning: optional tool setup failed: {error}");
    }
    Ok(())
}

fn resume_init(paths: &StatePaths, args: InitArgs, mut config: LocalConfig) -> Result<()> {
    if config.role != Role::Captain {
        bail!("this machine is already a member; run `fleet leave` first");
    }
    if args
        .name
        .as_deref()
        .is_some_and(|name| name != config.machine.name)
    {
        bail!(
            "this captain is already named {}; v0 does not rename an initialized machine",
            config.machine.name
        );
    }
    if args
        .color
        .is_some_and(|color| color != config.machine.color)
    {
        bail!(
            "this captain already uses {}; v0 does not recolor an initialized machine",
            config.machine.color
        );
    }
    let platform = Platform::new(args.dry_run)?;
    let shell = platform.active_shell()?;
    platform.preflight()?;
    println!("Resuming captain setup for {}.local.", config.machine.name);
    if args.dry_run {
        println!(
            "Would verify identity, hostname/mDNS, tmux/{}, Fleet skill, and captain service.",
            shell_name(shell)
        );
        return Ok(());
    }
    identity::ensure(paths)?;
    completed("Fleet identity and dedicated SSH key");
    working("Preparing native local-network discovery");
    platform.ensure_discovery()?;
    completed("Native local-network discovery");
    platform.set_hostname_and_mdns(&config.machine.name)?;
    completed(&format!(
        "System hostname and mDNS name: {}",
        config.machine.host()
    ));
    platform.ensure_tmux()?;
    platform.install_shell_theme(paths, shell, &config.machine.name, config.machine.color)?;
    completed("Shell and tmux setup");
    config.machine.tools = detected_tools(&platform);
    paths.save(&config)?;
    skill::initialize(paths)?;
    crate::ssh_client::initialize(paths)?;
    fs::create_dir_all(paths.logs_dir())?;
    platform.install_captain_service(paths)?;
    verify_local_captain_service(paths)?;
    completed("Captain service and mDNS advertisement");
    println!("Captain setup is healthy at {}.local.", config.machine.name);
    Ok(())
}

fn resume_join(paths: &StatePaths, args: JoinArgs, mut config: LocalConfig) -> Result<()> {
    if config.role != Role::Member {
        bail!("this machine is already the captain; run `fleet leave` first");
    }
    if args
        .name
        .as_deref()
        .is_some_and(|name| name != config.machine.name)
    {
        bail!(
            "this member is already named {}; v0 does not rename a joined machine",
            config.machine.name
        );
    }
    if args
        .color
        .is_some_and(|color| color != config.machine.color)
    {
        bail!(
            "this member already uses {}; v0 does not recolor a joined machine",
            config.machine.color
        );
    }
    let captain_ref = config
        .captain
        .clone()
        .context("member state is missing captain information")?;
    let endpoint = args
        .captain
        .unwrap_or_else(|| format!("{}:{DEFAULT_PORT}", captain_ref.host));
    let captain = crate::discovery::fetch_identity(&endpoint)?;
    if captain.id != captain_ref.id || captain.fingerprint != captain_ref.fingerprint {
        bail!("captain identity changed; refusing to resume join");
    }
    let platform = Platform::new(args.dry_run)?;
    let shell = platform.active_shell()?;
    platform.preflight()?;
    let selected = choose_tools(&platform, &args.tool)?;
    println!("Resuming member setup for {}.local.", config.machine.name);
    if args.dry_run {
        println!(
            "Would verify hostname/mDNS, SSH trust, tmux/{}, tools, and captain registration.",
            shell_name(shell)
        );
        return Ok(());
    }
    identity::ensure(paths)?;
    completed("Fleet identity");
    working("Preparing native local-network discovery");
    platform.ensure_discovery()?;
    completed("Native local-network discovery");
    if platform.name_conflicts(&config.machine.name)? {
        bail!(
            "{}.local resolves to another machine; run `fleet leave --yes`, then rejoin with a unique name",
            config.machine.name
        );
    }
    platform.set_hostname_and_mdns(&config.machine.name)?;
    completed(&format!(
        "System hostname and mDNS name: {}",
        config.machine.host()
    ));
    platform.ensure_ssh_server()?;
    platform.authorize_captain(&captain.ssh_public_key)?;
    completed("OpenSSH server and captain authorization");
    platform.ensure_tmux()?;
    platform.install_shell_theme(paths, shell, &config.machine.name, config.machine.color)?;
    completed("Shell and tmux setup");
    for tool in selected {
        let existed = platform.tool_installed(tool);
        if let Err(error) = platform.install_tool(tool) {
            eprintln!(
                "warning: optional tool setup failed for {}: {error:#}",
                tool.display_name()
            );
        } else if !existed
            && !args.no_login
            && let Err(error) = platform.login_tool(tool)
        {
            eprintln!(
                "warning: optional {} login failed: {error:#}",
                tool.display_name()
            );
        }
    }
    config.machine.tools = Tool::ALL
        .into_iter()
        .map(|tool| ToolState {
            tool,
            installed: platform.tool_installed(tool),
        })
        .collect();
    config.machine.ssh_host_key = platform.ssh_host_key()?;
    paths.save(&config)?;
    service::register(&endpoint, &config.machine).context(
        "captain registration still failed; resolve connectivity and rerun `fleet join`",
    )?;
    completed("Captain registration and pinned SSH verification");
    println!(
        "Member setup is healthy. From the captain, run `ssh {}.local`.",
        config.machine.name
    );
    Ok(())
}

fn status(paths: &StatePaths, json: bool) -> Result<()> {
    let config = paths.require()?;
    if json {
        let members = if config.role == Role::Captain {
            skill::load_members(paths)?
        } else {
            vec![]
        };
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "local": config,
                "members": members,
            }))?
        );
        return Ok(());
    }
    match config.role {
        Role::Captain => {
            println!("CAPTAIN\n  {}", status_line(&config.machine));
            println!("\nMEMBERS");
            let members = skill::load_members(paths)?;
            if members.is_empty() {
                println!("  No members have joined yet.");
            }
            for member in members {
                println!("  {}", status_line(&member));
            }
        }
        Role::Member => {
            println!("MEMBER\n  {}", status_line(&config.machine));
            if let Some(captain) = config.captain {
                println!("\nCAPTAIN\n  {}  {}", captain.host, captain.fingerprint);
            }
        }
    }
    Ok(())
}

fn leave(paths: &StatePaths, args: LeaveArgs) -> Result<()> {
    let config = paths.require()?;
    let platform = Platform::new(args.dry_run)?;
    match config.role {
        Role::Captain => {
            let members = skill::load_members(paths)?;
            if !members.is_empty() {
                bail!(
                    "this captain still has {} member(s); those members must leave before the captain",
                    members.len()
                );
            }
        }
        Role::Member => {}
    }
    if !args.yes
        && !Confirm::with_theme(&ColorfulTheme::default())
            .with_prompt("Leave this fleet? Hostname, tools, shell, and tmux setup will remain")
            .default(false)
            .interact()?
    {
        bail!("leave cancelled");
    }
    if args.dry_run {
        println!(
            "Would remove Fleet membership and captain SSH trust; machine setup and user data would remain."
        );
        return Ok(());
    }

    match config.role {
        Role::Member => {
            let captain = config
                .captain
                .context("member state is missing captain information")?;
            platform.remove_captain_authorization(&captain.ssh_public_key)?;
            let endpoint = format!("{}:{}", captain.host, DEFAULT_PORT);
            if let Err(error) = service::notify_leave(&endpoint, config.machine.id) {
                eprintln!(
                    "warning: captain could not be notified and may retain a stale record: {error:#}"
                );
            }
        }
        Role::Captain => {
            platform.stop_captain_service()?;
            skill::uninstall(paths)?;
            crate::ssh_client::uninstall(paths)?;
        }
    }
    fs::remove_file(paths.config()).context("remove Fleet membership state")?;
    println!("Left the fleet. Hostname, tools, shell, tmux, and user data were preserved.");
    Ok(())
}

fn choose_name(provided: Option<String>, current: &str) -> Result<String> {
    let name = match provided {
        Some(name) => name,
        None => dialoguer::Input::<String>::with_theme(&ColorfulTheme::default())
            .with_prompt("Machine name")
            .default(current.to_lowercase())
            .interact_text()?,
    };
    validate_machine_name(&name)?;
    Ok(name)
}

fn choose_color(provided: Option<Color>) -> Result<Color> {
    if let Some(color) = provided {
        return Ok(color);
    }
    let labels: Vec<_> = Color::ALL
        .iter()
        .map(|color| colorize(&format!("● {color}"), *color, true))
        .collect();
    let index = Select::with_theme(&ColorfulTheme::default())
        .with_prompt("Machine color")
        .items(&labels)
        .default(3)
        .interact()?;
    Ok(Color::ALL[index])
}

fn colorize(value: &str, color: Color, enabled: bool) -> String {
    if enabled {
        format!("\u{1b}[38;5;{}m{value}\u{1b}[0m", color.ansi_256())
    } else {
        value.to_owned()
    }
}

fn choose_captain(captains: Vec<CaptainAdvertisement>) -> Result<CaptainAdvertisement> {
    if captains.len() == 1 {
        return Ok(captains.into_iter().next().unwrap());
    }
    let labels: Vec<_> = captains
        .iter()
        .map(|captain| format!("{}  {}", captain.host, captain.fingerprint))
        .collect();
    let index = Select::with_theme(&ColorfulTheme::default())
        .with_prompt("Choose a captain")
        .items(&labels)
        .default(0)
        .interact()?;
    Ok(captains.into_iter().nth(index).unwrap())
}

fn choose_tools(platform: &Platform, provided: &[Tool]) -> Result<Vec<Tool>> {
    println!("\nTools to install:");
    let mut missing = Vec::new();
    for tool in Tool::ALL {
        if platform.tool_installed(tool) {
            println!("  ✓ {:<12} already installed", tool.display_name());
        } else {
            println!("  ○ {:<12} available", tool.display_name());
            missing.push(tool);
        }
    }
    if !provided.is_empty() {
        return Ok(provided
            .iter()
            .copied()
            .filter(|tool| !platform.tool_installed(*tool))
            .collect());
    }
    if missing.is_empty() || !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        return Ok(vec![]);
    }
    let labels: Vec<_> = missing.iter().map(|tool| tool.display_name()).collect();
    let choices = MultiSelect::with_theme(&ColorfulTheme::default())
        .with_prompt("Select missing tools to install")
        .items(&labels)
        .interact()?;
    Ok(choices.into_iter().map(|index| missing[index]).collect())
}

fn local_machine(
    platform: &Platform,
    name: String,
    color: Color,
    public_identity: String,
    tools: Vec<ToolState>,
) -> Result<Machine> {
    Ok(Machine {
        id: Uuid::new_v4(),
        name,
        color,
        ssh_user: platform.current_user()?,
        os: platform.os_name(),
        arch: platform.arch(),
        tools,
        public_identity,
        ssh_host_key: None,
    })
}

fn detected_tools(platform: &Platform) -> Vec<ToolState> {
    Tool::ALL
        .into_iter()
        .map(|tool| ToolState {
            tool,
            installed: platform.tool_installed(tool),
        })
        .collect()
}

fn completed(label: &str) {
    println!("  ✓ {label}");
}

fn working(label: &str) {
    println!("  … {label}");
}

fn status_line(machine: &Machine) -> String {
    let tools = machine
        .tools
        .iter()
        .filter(|state| state.installed)
        .map(|state| state.tool.display_name())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "{:<24} {:<9} {} {}  {}",
        machine.host(),
        machine.color,
        machine.os,
        machine.arch,
        if tools.is_empty() { "no tools" } else { &tools }
    )
}

fn shell_name(shell: crate::platform::Shell) -> &'static str {
    match shell {
        crate::platform::Shell::Bash => "Bash",
        crate::platform::Shell::Zsh => "Zsh",
    }
}

fn verify_local_captain_service(paths: &StatePaths) -> Result<()> {
    let expected = paths.require()?.machine;
    let mut last_error = None;
    let mut local_ready = false;
    for _ in 0..12 {
        match crate::discovery::fetch_identity(&format!("127.0.0.1:{DEFAULT_PORT}")) {
            Ok(captain) if captain.id == expected.id => {
                local_ready = true;
                break;
            }
            Ok(_) => {
                last_error = Some(anyhow::anyhow!("unexpected captain identity on local port"))
            }
            Err(error) => last_error = Some(error),
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    if !local_ready {
        return Err(last_error
            .unwrap_or_else(|| anyhow::anyhow!("captain service did not answer"))
            .context("captain service failed its local health check"));
    }
    for _ in 0..6 {
        let discovered = crate::discovery::discover(None)
            .context("captain HTTP service works, but mDNS advertisement could not be verified")?;
        if discovered
            .iter()
            .any(|captain| captain.id == expected.id && captain.host == expected.host())
        {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    bail!(
        "captain service was not visible through mDNS as {}",
        expected.host()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_preview_uses_the_same_palette_as_machine_themes() {
        assert_eq!(
            colorize("● orange", Color::Orange, true),
            "\u{1b}[38;5;208m● orange\u{1b}[0m"
        );
        assert_eq!(
            colorize("powerbook.local", Color::Orange, false),
            "powerbook.local"
        );
    }
}
