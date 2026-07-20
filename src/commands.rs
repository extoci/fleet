use crate::cli::{
    Cli, Color, Command, InitArgs, JoinArgs, LeaveArgs, RemoveArgs, RestartArgs, Tool, UsageArgs,
};
use crate::discovery::{CaptainAdvertisement, CaptainConnection, DEFAULT_PORT};
use crate::identity;
use crate::platform::Platform;
use crate::service;
use crate::skill;
use crate::state::{
    LocalConfig, Machine, Role, STATE_VERSION, StatePaths, ToolState, validate_machine_name,
};
use anyhow::{Context, Result, bail};
use dialoguer::{Confirm, MultiSelect, Select, theme::ColorfulTheme};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, IsTerminal};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command as ProcessCommand;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use uuid::Uuid;

pub fn run(cli: Cli) -> Result<()> {
    let paths = StatePaths::discover()?;
    match cli.command {
        Command::Init(args) => init(&paths, args),
        Command::Join(args) => join(&paths, args),
        Command::Status(args) => status(&paths, args.json, args.check || args.watch, args.watch),
        Command::Leave(args) => leave(&paths, args),
        Command::Remove(args) => remove(&paths, args),
        Command::Doctor => doctor(&paths),
        Command::Logs(args) => logs(&paths, args.lines),
        Command::Restart(args) => restart(&paths, args),
        Command::Update => update(&paths),
        Command::UpdateAll => update_all(&paths),
        Command::Usage(args) => usage(&paths, args),
        Command::Daemon(args) => service::run(&paths, &args.listen),
    }
}

const REMOTE_USAGE_COMMAND: &str = r#"
if command -v bunx >/dev/null 2>&1; then
  exec env LOG_LEVEL=0 bunx ccusage@latest daily --json
fi
if [ -x "$HOME/.bun/bin/bunx" ]; then
  exec env LOG_LEVEL=0 "$HOME/.bun/bin/bunx" ccusage@latest daily --json
fi
if command -v bun >/dev/null 2>&1; then
  exec env LOG_LEVEL=0 bun x ccusage@latest daily --json
fi
if [ -x "$HOME/.bun/bin/bun" ]; then
  exec env LOG_LEVEL=0 "$HOME/.bun/bin/bun" x ccusage@latest daily --json
fi
if command -v pnpm >/dev/null 2>&1; then
  exec env LOG_LEVEL=0 pnpm dlx ccusage@latest daily --json
fi
if command -v npx >/dev/null 2>&1; then
  exec env LOG_LEVEL=0 npx --yes ccusage@latest daily --json
fi
printf '%s\n' 'ccusage needs bunx, bun, pnpm, or npx; install Bun or Node.js on this machine' >&2
exit 127
"#;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct UsageTotals {
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    total_tokens: u64,
    total_cost: f64,
}

impl UsageTotals {
    fn add(&mut self, other: &Self) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_creation_tokens += other.cache_creation_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.total_tokens += other.total_tokens;
        self.total_cost += other.total_cost;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct MachineUsage {
    machine: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    totals: Option<UsageTotals>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct UsageReport {
    machines: Vec<MachineUsage>,
    totals: UsageTotals,
}

#[derive(Deserialize)]
struct CcusageReport {
    totals: UsageTotals,
}

fn usage(paths: &StatePaths, args: UsageArgs) -> Result<()> {
    let config = paths.require()?;
    let report = if config.role == Role::Captain {
        collect_usage(paths, &args.machines)?
    } else if is_local_only(&args.machines, &config.machine.name) {
        report_from_results(vec![(config.machine.name.clone(), run_local_usage())])
    } else {
        let captain = config
            .captain
            .as_ref()
            .context("member state is missing captain information")?;
        let connection = crate::discovery::connect_pinned(None, captain)
            .context("find the fleet captain for the usage request")?;
        service::request_usage(paths, &connection, config.machine.id, &args.machines)?
    };
    print_usage_report(&report);
    if !report.machines.is_empty()
        && report
            .machines
            .iter()
            .all(|machine| machine.totals.is_none())
    {
        bail!("usage could not be collected from any selected machine");
    }
    Ok(())
}

fn is_local_only(requested: &[String], local: &str) -> bool {
    requested.len() == 1 && requested[0].trim_end_matches(".local") == local
}

pub(crate) fn collect_usage(paths: &StatePaths, requested: &[String]) -> Result<UsageReport> {
    let config = paths.require()?;
    if config.role != Role::Captain {
        bail!("only the captain can collect fleet usage");
    }
    let members = skill::load_members(paths)?;
    let names = select_usage_machines(&config.machine, &members, requested)?;
    let mut results = Vec::with_capacity(names.len());
    for name in names {
        let result = if name == config.machine.name {
            run_local_usage()
        } else {
            run_remote_usage(members.iter().find(|member| member.name == name).unwrap())
        };
        results.push((name, result));
    }
    Ok(report_from_results(results))
}

fn select_usage_machines(
    local: &Machine,
    members: &[Machine],
    requested: &[String],
) -> Result<Vec<String>> {
    if requested.is_empty() || requested.iter().any(|name| name == "all") {
        if requested.len() > 1 {
            bail!("`all` cannot be combined with machine names");
        }
        let mut names = vec![local.name.clone()];
        names.extend(members.iter().map(|member| member.name.clone()));
        return Ok(names);
    }
    let mut names = Vec::new();
    for raw in requested {
        let name = raw.trim_end_matches(".local");
        validate_machine_name(name)?;
        if name != local.name && !members.iter().any(|member| member.name == name) {
            bail!("no machine named {name} is registered");
        }
        if !names.iter().any(|existing| existing == name) {
            names.push(name.to_owned());
        }
    }
    Ok(names)
}

fn run_local_usage() -> Result<UsageTotals> {
    let output = ProcessCommand::new("sh")
        .args(["-c", REMOTE_USAGE_COMMAND])
        .output()
        .context("start ccusage locally")?;
    parse_usage_output(output, "local machine")
}

fn run_remote_usage(member: &Machine) -> Result<UsageTotals> {
    let output = ProcessCommand::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            &member.host(),
            REMOTE_USAGE_COMMAND,
        ])
        .output()
        .with_context(|| format!("start SSH to {}", member.host()))?;
    parse_usage_output(output, &member.host())
}

fn parse_usage_output(output: std::process::Output, source: &str) -> Result<UsageTotals> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        bail!(
            "ccusage on {source} exited with {}{}",
            output.status,
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        );
    }
    let report: CcusageReport = serde_json::from_slice(&output.stdout)
        .with_context(|| format!("decode ccusage JSON from {source}"))?;
    Ok(report.totals)
}

fn report_from_results(results: Vec<(String, Result<UsageTotals>)>) -> UsageReport {
    let mut report = UsageReport::default();
    for (machine, result) in results {
        match result {
            Ok(totals) => {
                report.totals.add(&totals);
                report.machines.push(MachineUsage {
                    machine,
                    totals: Some(totals),
                    error: None,
                });
            }
            Err(error) => report.machines.push(MachineUsage {
                machine,
                totals: None,
                error: Some(format!("{error:#}")),
            }),
        }
    }
    report
}

fn print_usage_report(report: &UsageReport) {
    println!("Fleet usage");
    println!("{:<24} {:>16} {:>12}", "Machine", "Tokens", "Cost (USD)");
    for machine in &report.machines {
        if let Some(totals) = &machine.totals {
            println!(
                "{:<24} {:>16} {:>12.2}",
                format!("{}.local", machine.machine),
                totals.total_tokens,
                totals.total_cost
            );
        } else {
            println!(
                "{:<24} {:>16}",
                format!("{}.local", machine.machine),
                "unavailable"
            );
            eprintln!(
                "  {}: {}",
                machine.machine,
                machine.error.as_deref().unwrap_or("unknown error")
            );
        }
    }
    println!(
        "{:<24} {:>16} {:>12.2}",
        "TOTAL", report.totals.total_tokens, report.totals.total_cost
    );
    println!(
        "Input: {}  Output: {}  Cache write: {}  Cache read: {}",
        report.totals.input_tokens,
        report.totals.output_tokens,
        report.totals.cache_creation_tokens,
        report.totals.cache_read_tokens
    );
}

const REMOTE_UPDATE_COMMAND: &str = r#"
fleet_bin=$(command -v fleet 2>/dev/null || true)
if [ -z "$fleet_bin" ] && [ -x "$HOME/.local/bin/fleet" ]; then
  fleet_bin="$HOME/.local/bin/fleet"
fi
if [ -z "$fleet_bin" ]; then
  curl -fsSL https://extoci.lol/fleet | sh
  exit $?
fi
output=$("$fleet_bin" update 2>&1)
status=$?
printf '%s\n' "$output"
if [ "$status" -eq 0 ]; then
  exit 0
fi
case "$output" in
  *"not implemented yet"*) curl -fsSL https://extoci.lol/fleet | sh ;;
  *) exit "$status" ;;
esac
"#;

fn update_all(paths: &StatePaths) -> Result<()> {
    let config = paths.require()?;
    if config.role != Role::Captain {
        bail!("only the captain can update every machine in the fleet");
    }

    let members = skill::load_members(paths)?;
    println!(
        "Updating Fleet on {} machine(s), members first and captain last.",
        members.len() + 1
    );
    let failures = update_members_with(&members, update_member);

    println!("Updating {} (captain)...", config.machine.host());
    let captain_result = update(paths);
    if failures.is_empty() {
        return captain_result;
    }
    if let Err(error) = captain_result {
        bail!(
            "updates failed on {} and the captain update failed: {error:#}",
            failures.join(", ")
        );
    }
    bail!("updates failed on: {}", failures.join(", "))
}

fn update_members_with<F>(members: &[Machine], mut run: F) -> Vec<String>
where
    F: FnMut(&Machine) -> Result<String>,
{
    let mut failures = Vec::new();
    for member in members {
        let host = member.host();
        println!("Updating {host}...");
        match run(member) {
            Ok(output) => {
                for line in output.lines().filter(|line| !line.trim().is_empty()) {
                    println!("  {line}");
                }
                println!("  ✓ {host}");
            }
            Err(error) => {
                eprintln!("  ! {host}: {error:#}");
                failures.push(host);
            }
        }
    }
    failures
}

fn update_member(member: &Machine) -> Result<String> {
    let output = ProcessCommand::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            &member.host(),
            REMOTE_UPDATE_COMMAND,
        ])
        .output()
        .with_context(|| format!("start SSH to {}", member.host()))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    bail!(
        "remote update exited with {}{}",
        output.status,
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    )
}

fn update(paths: &StatePaths) -> Result<()> {
    match crate::updater::update()? {
        crate::updater::UpdateOutcome::Current { version } => {
            println!("Fleet {version} is already up to date.");
        }
        crate::updater::UpdateOutcome::Updated { version } => {
            println!("Fleet updated to {version}.");
            if paths
                .load()?
                .is_some_and(|config| config.role == Role::Captain)
            {
                Platform::new(false)?.restart_captain_service()?;
                println!("Restarted the Fleet captain service.");
            }
        }
    }
    Ok(())
}

fn restart(paths: &StatePaths, args: RestartArgs) -> Result<()> {
    let config = paths.require()?;
    if config.role != Role::Captain {
        bail!("only a captain has a Fleet background service to restart");
    }
    let platform = Platform::new(args.dry_run)?;
    platform.restart_captain_service()?;
    if !args.dry_run {
        println!("Restarted the Fleet captain service.");
    }
    Ok(())
}

fn init(paths: &StatePaths, args: InitArgs) -> Result<()> {
    if let Some(config) = paths.load()? {
        return resume_init(paths, args, config);
    }
    paths.ensure_uninitialized()?;
    let platform = Platform::new(args.dry_run)?;
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
            "Would create a Fleet identity, set the hostname, configure tmux, install the Fleet skill, and start the captain service."
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
    platform.install_tmux_theme(paths, &name, color)?;
    completed("Tmux setup");
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
    prepare_captain_service(&platform)?;
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
    let captains = crate::discovery::discover(args.captain.as_deref()).map_err(|error| {
        crate::logging::user_error(
            paths,
            "discovery",
            "Fleet found a captain advertisement but could not verify it",
            &error,
        )
    })?;
    if captains.is_empty() {
        bail!("no Fleet captain was discovered on this local network");
    }
    let captain_connection = choose_captain(captains)?;
    let captain = captain_connection.captain();
    println!("\nCaptain found: {}", captain.host);
    println!("Identity: {}", captain.fingerprint);
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

    println!("\nReady to join:");
    println!("  Captain: {}", captain.host);
    println!("  Identity: {}", captain.fingerprint);
    println!("  This machine: {name}.local ({color})");
    if !args.yes
        && !Confirm::with_theme(&ColorfulTheme::default())
            .with_prompt("Continue? This trusts the captain discovered on the current LAN")
            .default(true)
            .interact()?
    {
        bail!("join cancelled");
    }

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
    for tool in selected {
        let existed = platform.tool_installed(tool);
        if let Err(error) = platform.install_tool(tool) {
            crate::logging::detail(
                paths,
                "tool-install",
                format!("{}: {error:#}", tool.display_name()),
            );
            eprintln!(
                "Warning: {} could not be installed. Run `fleet logs` for details.",
                tool.display_name()
            );
        } else if !existed {
            newly_installed.push(tool);
        }
    }
    login_to_new_tools(paths, &platform, newly_installed, args.yes, args.no_login)?;

    let tools = Tool::ALL
        .into_iter()
        .map(|tool| ToolState {
            tool,
            installed: platform.tool_installed(tool),
        })
        .collect();
    let mut machine = local_machine(&platform, name.clone(), color, identity.public_key, tools)?;
    machine.ssh_host_key = platform.ssh_host_key()?;
    let config = LocalConfig {
        version: STATE_VERSION,
        role: Role::Member,
        machine,
        captain: Some(captain.captain_ref()),
    };
    paths.save(&config)?;
    completed("Local member state");
    service::register(paths, &captain_connection, &config.machine).with_context(|| {
        format!(
            "register with captain at {}; local setup is saved, so rerun `fleet join` after resolving connectivity",
            captain_connection.endpoint()
        )
    })?;
    completed("Captain registration and pinned SSH verification");

    println!("\nJoined. From the captain, run `ssh {name}.local`.");
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
    platform.preflight()?;
    println!("Resuming captain setup for {}.local.", config.machine.name);
    if args.dry_run {
        println!("Would verify identity, hostname/mDNS, tmux, Fleet skill, and captain service.");
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
    platform.install_tmux_theme(paths, &config.machine.name, config.machine.color)?;
    completed("Tmux setup");
    config.machine.tools = detected_tools(&platform);
    paths.save(&config)?;
    skill::initialize(paths)?;
    crate::ssh_client::initialize(paths)?;
    fs::create_dir_all(paths.logs_dir())?;
    prepare_captain_service(&platform)?;
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
    let captain_connection =
        crate::discovery::connect_pinned(args.captain.as_deref(), &captain_ref).map_err(
            |error| {
                crate::logging::user_error(
                    paths,
                    "resume-join",
                    "The captain could not be reached",
                    &error,
                )
            },
        )?;
    let captain = captain_connection.captain();
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
    let mut newly_installed = Vec::new();
    for tool in selected {
        let existed = platform.tool_installed(tool);
        if let Err(error) = platform.install_tool(tool) {
            crate::logging::detail(
                paths,
                "tool-install",
                format!("{}: {error:#}", tool.display_name()),
            );
            eprintln!(
                "Warning: {} could not be installed. Run `fleet logs` for details.",
                tool.display_name()
            );
        } else if !existed {
            newly_installed.push(tool);
        }
    }
    login_to_new_tools(paths, &platform, newly_installed, args.yes, args.no_login)?;
    config.machine.tools = Tool::ALL
        .into_iter()
        .map(|tool| ToolState {
            tool,
            installed: platform.tool_installed(tool),
        })
        .collect();
    config.machine.ssh_host_key = platform.ssh_host_key()?;
    paths.save(&config)?;
    service::register(paths, &captain_connection, &config.machine).context(
        "captain registration still failed; resolve connectivity and rerun `fleet join`",
    )?;
    completed("Captain registration and pinned SSH verification");
    println!(
        "Member setup is healthy. From the captain, run `ssh {}.local`.",
        config.machine.name
    );
    Ok(())
}

fn status(paths: &StatePaths, json: bool, check: bool, watch: bool) -> Result<()> {
    if watch {
        if json {
            bail!("`fleet status --watch` cannot be combined with `--json`");
        }
        let stopped = Arc::new(AtomicBool::new(false));
        let signal = stopped.clone();
        ctrlc::set_handler(move || signal.store(true, Ordering::SeqCst))?;
        while !stopped.load(Ordering::SeqCst) {
            if io::stdout().is_terminal() {
                print!("\x1b[2J\x1b[H");
            }
            status(paths, false, true, false)?;
            if io::stdout().is_terminal() {
                println!("\nRefreshing every 2 seconds. Press Ctrl-C to stop.");
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        return Ok(());
    }
    let config = paths.require()?;
    if json {
        let members = if config.role == Role::Captain {
            skill::load_members(paths)?
        } else {
            vec![]
        };
        let health = check.then(|| {
            if config.role == Role::Captain {
                members
                    .iter()
                    .map(|member| (member.host(), reachability(&member.host())))
                    .collect::<std::collections::BTreeMap<_, _>>()
            } else {
                config
                    .captain
                    .as_ref()
                    .map(|captain| {
                        let state = if captain_health(captain) == "✓" {
                            "online"
                        } else {
                            "unreachable"
                        };
                        std::iter::once((captain.host.clone(), state)).collect()
                    })
                    .unwrap_or_default()
            }
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "local": config,
                "members": members,
                "health": health,
            }))?
        );
        return Ok(());
    }
    match config.role {
        Role::Captain => {
            let members = skill::load_members(paths)?;
            let width = terminal_width();
            let colors = io::stdout().is_terminal();
            println!("CAPTAIN");
            print!(
                "{}",
                render_status_rows(&[(config.machine, None)], width, colors)
            );
            println!("\nMEMBERS");
            if members.is_empty() {
                println!("  No members have joined yet.");
            }
            if !members.is_empty() {
                let rows = members
                    .into_iter()
                    .map(|member| {
                        let health = check.then(|| reachability(&member.host()));
                        (member, health)
                    })
                    .collect::<Vec<_>>();
                print!("{}", render_status_rows(&rows, width, colors));
            }
        }
        Role::Member => {
            let width = terminal_width();
            let colors = io::stdout().is_terminal();
            println!("MEMBER");
            print!(
                "{}",
                render_status_rows(&[(config.machine, None)], width, colors)
            );
            if let Some(captain) = config.captain {
                let health = check.then(|| captain_health(&captain));
                println!(
                    "\nCAPTAIN\n  {}  {}{}",
                    captain.host,
                    captain.fingerprint,
                    health
                        .map(|value| format!(
                            "  {}",
                            if value == "✓" {
                                "online"
                            } else {
                                "unreachable"
                            }
                        ))
                        .unwrap_or_default()
                );
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
            if !members.is_empty() && !args.force {
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
            let notification =
                crate::discovery::connect_pinned(None, &captain).and_then(|connection| {
                    service::notify_leave(paths, &connection, config.machine.id)
                });
            if let Err(error) = notification {
                crate::logging::detail(paths, "leave", format!("{error:#}"));
                eprintln!(
                    "Warning: the captain could not accept the leave request and may retain this member. The captain can run `fleet remove {}`. Run `fleet logs` for details.",
                    config.machine.name
                );
            }
            platform.remove_captain_authorization(&captain.ssh_public_key)?;
        }
        Role::Captain => {
            platform.stop_captain_service()?;
            skill::uninstall(paths)?;
            crate::ssh_client::uninstall(paths)?;
            if paths.inventory_dir().exists() {
                fs::remove_dir_all(paths.inventory_dir()).context("remove captain inventory")?;
            }
        }
    }
    fs::remove_file(paths.config()).context("remove Fleet membership state")?;
    println!("Left the fleet. Hostname, tools, shell, tmux, and user data were preserved.");
    Ok(())
}

fn remove(paths: &StatePaths, args: RemoveArgs) -> Result<()> {
    let config = paths.require()?;
    if config.role != Role::Captain {
        bail!("only the captain can remove a member");
    }
    let members = skill::load_members(paths)?;
    let query = args.member.trim_end_matches(".local");
    let member = members
        .iter()
        .find(|member| member.name == query || member.id.to_string() == query)
        .with_context(|| format!("no member named {query} is registered"))?;
    if !args.yes
        && !Confirm::with_theme(&ColorfulTheme::default())
        .with_prompt(format!(
            "Remove {}.local from the captain inventory? The member must leave locally to revoke captain access",
            member.name
        ))
            .default(false)
            .interact()?
    {
        bail!("removal cancelled");
    }
    if args.dry_run {
        println!(
            "Would remove {}.local from the captain inventory and SSH configuration.",
            member.name
        );
        return Ok(());
    }
    skill::remove_member(paths, member.id)?;
    crate::ssh_client::regenerate(paths)?;
    println!(
        "Removed {}.local from the captain inventory. The member machine was not changed; run `fleet leave` there to revoke captain access.",
        member.name
    );
    Ok(())
}

fn logs(paths: &StatePaths, lines: usize) -> Result<()> {
    let mut sources = Vec::new();
    for (label, path) in [
        ("Fleet", paths.log_file()),
        ("Setup", paths.logs_dir().join("setup.log")),
    ] {
        match fs::read_to_string(path) {
            Ok(source) if !source.is_empty() => sources.push((label, source)),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("read Fleet diagnostic log"),
        }
    }
    if sources.is_empty() {
        println!("No Fleet diagnostic logs have been recorded yet.");
        return Ok(());
    }
    for (label, source) in sources {
        println!("{label} log:");
        let selected: Vec<_> = source.lines().rev().take(lines).collect();
        for line in selected.into_iter().rev() {
            println!("{line}");
        }
    }
    Ok(())
}

fn doctor(paths: &StatePaths) -> Result<()> {
    println!("Fleet doctor");
    let config = match paths.load() {
        Ok(Some(config)) => {
            println!("  ✓ Membership state is readable");
            config
        }
        Ok(None) => {
            println!("  ! This machine is not in a fleet");
            return Ok(());
        }
        Err(error) => {
            crate::logging::detail(paths, "doctor", format!("{error:#}"));
            bail!("membership state is damaged. Run `fleet logs` for more information");
        }
    };
    let identity_ok = paths.identity_dir().join("id_ed25519").is_file();
    println!("  {} Fleet identity", if identity_ok { "✓" } else { "!" });
    match config.role {
        Role::Captain => {
            let members = skill::load_members(paths)?;
            println!("  ✓ Captain inventory contains {} member(s)", members.len());
            for member in members {
                println!("  {} {}", reachability(&member.host()), member.host());
            }
        }
        Role::Member => {
            let captain = config
                .captain
                .context("member state is missing captain information")?;
            println!("  {} captain {}", captain_health(&captain), captain.host);
        }
    }
    println!("Detailed diagnostics: `fleet logs`");
    Ok(())
}

fn reachability(host: &str) -> &'static str {
    let address = format!("{host}:22");
    let reachable = address
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| {
            addresses.find(|address| {
                TcpStream::connect_timeout(address, Duration::from_millis(700)).is_ok()
            })
        })
        .is_some();
    if reachable { "online" } else { "unreachable" }
}

fn captain_health(captain: &crate::state::CaptainRef) -> &'static str {
    if crate::discovery::connect_pinned(None, captain).is_ok() {
        "✓"
    } else {
        "!"
    }
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

fn choose_captain(captains: Vec<CaptainConnection>) -> Result<CaptainConnection> {
    if captains.len() == 1 {
        return Ok(captains.into_iter().next().unwrap());
    }
    let labels: Vec<_> = captains
        .iter()
        .map(|connection| {
            format!(
                "{}  {}",
                connection.captain().host,
                connection.captain().fingerprint
            )
        })
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

fn login_to_new_tools(
    paths: &StatePaths,
    platform: &Platform,
    tools: Vec<Tool>,
    yes: bool,
    no_login: bool,
) -> Result<()> {
    if no_login {
        return Ok(());
    }
    for tool in tools {
        let login = yes
            || !std::io::IsTerminal::is_terminal(&std::io::stdin())
            || Confirm::with_theme(&ColorfulTheme::default())
                .with_prompt(format!("Login to {}?", tool.display_name()))
                .default(true)
                .interact()?;
        if login && let Err(error) = platform.login_tool(tool) {
            crate::logging::detail(
                paths,
                "tool-login",
                format!("{}: {error:#}", tool.display_name()),
            );
            eprintln!(
                "Warning: {} login did not complete. Run `fleet logs` for details.",
                tool.display_name()
            );
        }
    }
    Ok(())
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

fn terminal_width() -> usize {
    terminal_size::terminal_size()
        .map(|(terminal_size::Width(width), _)| usize::from(width))
        .or_else(|| std::env::var("COLUMNS").ok()?.parse().ok())
        .unwrap_or(80)
}

fn render_status_rows(rows: &[(Machine, Option<&str>)], width: usize, colors: bool) -> String {
    if width < 64 {
        return rows
            .iter()
            .map(|(machine, health)| {
                let identity = colorize(&format!("● {}", machine.host()), machine.color, colors);
                let details = [system_name(&machine.os), installed_tools(machine)]
                    .into_iter()
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join(" · ");
                let health = health
                    .as_deref()
                    .map(|value| format!(" · {value}"))
                    .unwrap_or_default();
                format!("  {identity}\n    {details}{health}\n")
            })
            .collect();
    }

    let show_health = rows.iter().any(|(_, health)| health.is_some());
    let health_width = if show_health { 14 } else { 0 };
    let system_width = 8;
    let host_width = rows
        .iter()
        .map(|(machine, _)| machine.host().len() + 2)
        .max()
        .unwrap_or(20)
        .clamp(18, 28);
    let tools_width = width.saturating_sub(host_width + system_width + health_width + 8);
    let mut output = String::new();
    output.push_str(&format!(
        "  {:<host_width$} {:<system_width$} {:<tools_width$}{}\n",
        "MACHINE",
        "SYSTEM",
        "TOOLS",
        if show_health { "  STATUS" } else { "" }
    ));
    for (machine, health) in rows {
        let plain_identity = format!("● {}", machine.host());
        let identity = colorize(&plain_identity, machine.color, colors);
        let tools = truncate(&installed_tools(machine), tools_width);
        output.push_str(&format!(
            "  {identity}{:identity_padding$} {:<system_width$} {:<tools_width$}{}\n",
            "",
            system_name(&machine.os),
            tools,
            health
                .as_deref()
                .map(|value| format!("  {value}"))
                .unwrap_or_default(),
            identity_padding = host_width.saturating_sub(plain_identity.chars().count()),
        ));
    }
    output
}

fn installed_tools(machine: &Machine) -> String {
    let tools = machine
        .tools
        .iter()
        .filter(|state| state.installed)
        .map(|state| state.tool.display_name())
        .collect::<Vec<_>>()
        .join(", ");
    if tools.is_empty() {
        "—".into()
    } else {
        tools
    }
}

fn system_name(os: &str) -> String {
    match os.to_ascii_lowercase().as_str() {
        "macos" | "darwin" => "macOS".into(),
        "linux" => "Linux".into(),
        other => {
            let mut chars = other.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        }
    }
}

fn truncate(value: &str, width: usize) -> String {
    if value.chars().count() <= width {
        return value.into();
    }
    if width <= 1 {
        return "…".into();
    }
    value.chars().take(width - 1).collect::<String>() + "…"
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
            Ok(actual) => last_error = Some(captain_identity_mismatch(&expected, &actual)),
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
        if discovered.iter().any(|connection| {
            connection.captain().id == expected.id && connection.captain().host == expected.host()
        }) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    bail!(
        "captain service was not visible through mDNS as {}",
        expected.host()
    )
}

fn prepare_captain_service(platform: &Platform) -> Result<()> {
    platform.stop_captain_service()?;
    let endpoint = format!("127.0.0.1:{DEFAULT_PORT}");
    for _ in 0..12 {
        if TcpStream::connect_timeout(
            &endpoint
                .parse()
                .expect("constant captain endpoint is valid"),
            Duration::from_millis(100),
        )
        .is_err()
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }

    if let Ok(actual) = crate::discovery::fetch_identity(&endpoint) {
        bail!(
            "another Fleet captain ({}, identity {}) is already using local port {DEFAULT_PORT}; stop that daemon and resume with `fleet init`",
            actual.host,
            actual.id
        );
    }
    bail!(
        "another process is already using Fleet's local port {DEFAULT_PORT}; stop it and resume with `fleet init`"
    )
}

fn captain_identity_mismatch(expected: &Machine, actual: &CaptainAdvertisement) -> anyhow::Error {
    anyhow::anyhow!(
        "local port {DEFAULT_PORT} answered as {} (identity {}), but current Fleet state expects {} (identity {}); stop the stale daemon and resume with `fleet init`",
        actual.host,
        actual.id,
        expected.host(),
        expected.id
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status_machine() -> Machine {
        Machine {
            id: Uuid::nil(),
            name: "emerald".into(),
            color: Color::Orange,
            ssh_user: "fleet-test".into(),
            os: "linux".into(),
            arch: "x86_64".into(),
            tools: vec![ToolState {
                tool: Tool::Codex,
                installed: true,
            }],
            public_identity: "ssh-ed25519 AAAATEST".into(),
            ssh_host_key: None,
        }
    }

    #[test]
    fn captain_identity_mismatch_explains_the_stale_daemon_and_recovery() {
        let expected = status_machine();
        let actual = CaptainAdvertisement {
            protocol: 1,
            id: Uuid::new_v4(),
            name: "old-captain".into(),
            host: "old-captain.local".into(),
            port: DEFAULT_PORT,
            fingerprint: "SHA256:test".into(),
            ssh_public_key: "ssh-ed25519 AAAATEST".into(),
        };

        let message = captain_identity_mismatch(&expected, &actual).to_string();
        assert!(message.contains(&actual.id.to_string()));
        assert!(message.contains(&expected.id.to_string()));
        assert!(message.contains("stop the stale daemon"));
        assert!(message.contains("fleet init"));
    }

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

    #[test]
    fn status_rows_use_color_without_printing_its_name() {
        let output = render_status_rows(&[(status_machine(), None)], 100, true);
        assert!(output.contains("\u{1b}[38;5;208m● emerald.local\u{1b}[0m"));
        assert!(!output.contains("orange"));
        assert!(!output.contains("x86_64"));
    }

    #[test]
    fn narrow_status_rows_switch_to_a_stacked_layout() {
        let output = render_status_rows(&[(status_machine(), Some("online"))], 40, false);
        assert_eq!(output, "  ● emerald.local\n    Linux · Codex · online\n");
        assert!(!output.contains("MACHINE"));
    }

    #[test]
    fn update_all_continues_after_a_member_fails() {
        let mut ruby = status_machine();
        ruby.name = "ruby".into();
        let failures = update_members_with(&[status_machine(), ruby], |member| {
            if member.name == "emerald" {
                bail!("offline")
            }
            Ok("Fleet 0.4.0 is already up to date.".into())
        });
        assert_eq!(failures, ["emerald.local"]);
    }

    #[test]
    fn remote_update_bootstraps_missing_and_legacy_installations() {
        assert!(REMOTE_UPDATE_COMMAND.contains("https://extoci.lol/fleet"));
        assert!(REMOTE_UPDATE_COMMAND.contains("not implemented yet"));
        assert!(REMOTE_UPDATE_COMMAND.contains("$HOME/.local/bin/fleet"));
    }

    #[test]
    fn usage_selection_defaults_to_all_and_accepts_multiple_names() {
        let local = status_machine();
        let mut ruby = status_machine();
        ruby.name = "ruby".into();
        assert_eq!(
            select_usage_machines(&local, &[ruby.clone()], &[]).unwrap(),
            ["emerald", "ruby"]
        );
        assert_eq!(
            select_usage_machines(&local, &[ruby], &["ruby.local".into(), "emerald".into()])
                .unwrap(),
            ["ruby", "emerald"]
        );
        assert!(select_usage_machines(&local, &[], &["all".into(), "emerald".into()]).is_err());
    }

    #[test]
    fn unavailable_machines_do_not_discard_successful_usage() {
        let totals = UsageTotals {
            total_tokens: 42,
            total_cost: 1.25,
            ..UsageTotals::default()
        };
        let report = report_from_results(vec![
            ("emerald".into(), Ok(totals)),
            ("ruby".into(), Err(anyhow::anyhow!("offline"))),
        ]);
        assert_eq!(report.totals.total_tokens, 42);
        assert!(
            report.machines[1]
                .error
                .as_deref()
                .unwrap()
                .contains("offline")
        );
    }

    #[test]
    fn ccusage_json_without_cost_fields_is_supported() {
        let report: CcusageReport = serde_json::from_str(
            r#"{"totals":{"inputTokens":2,"outputTokens":3,"totalTokens":5}}"#,
        )
        .unwrap();
        assert_eq!(report.totals.total_tokens, 5);
        assert_eq!(report.totals.total_cost, 0.0);
    }
}
