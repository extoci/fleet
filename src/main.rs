mod config;
mod discovery;
mod git_setup;
mod hosted;
mod service;
mod setup;
mod ssh;
mod status;
mod ui;

use std::time::Duration;

use anyhow::Result;
use clap::{Parser, Subcommand};
use config::DeviceRole;
use ui::{DeviceColor, Ui};

#[derive(Parser)]
#[command(
    name = "fleet",
    version,
    about = "Your machines, one command away.",
    after_help = "Examples:\n  fleet init --name studio --color violet\n  fleet ls\n  fleet connect studio\n  fleet connect studio -- uname -a\n  fleet expose t3 --public\n  fleet open studio/t3\n  fleet status --json"
)]
struct Cli {
    /// Disable ANSI color (also honors NO_COLOR)
    #[arg(long, global = true)]
    no_color: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Set up this machine
    Init {
        /// Fleet name for this machine (defaults to its hostname)
        #[arg(long)]
        name: Option<String>,
        /// Device accent advertised to the fleet
        #[arg(long, value_enum)]
        color: Option<DeviceColor>,
        /// Configure this machine as an SSH host or a lightweight controller
        #[arg(long, value_enum)]
        role: Option<DeviceRole>,
        /// Do not install the background discovery service
        #[arg(long)]
        no_service: bool,
    },
    /// See devices on the local network
    #[command(visible_alias = "ls")]
    Discover {
        /// Seconds to listen for announcements
        #[arg(short, long, default_value_t = 2)]
        timeout: u64,
        /// Print machine-readable tab-separated output
        #[arg(long)]
        plain: bool,
        /// Print stable JSON for scripts and agents
        #[arg(long, conflicts_with = "plain")]
        json: bool,
    },
    /// Check this machine's setup
    Status {
        /// Print stable JSON for scripts and agents
        #[arg(long)]
        json: bool,
    },
    /// Set up Git identity and GitHub authentication
    Git {
        #[command(subcommand)]
        command: GitCommand,
    },
    /// Open a shell or run a command
    Connect {
        host: String,
        #[arg(short, long)]
        user: Option<String>,
        /// Trust and pin a previously unseen SSH host key
        #[arg(long)]
        trust_host: bool,
        #[arg(last = true)]
        args: Vec<String>,
    },
    /// Allow a Fleet device to connect here without a password
    Pair {
        /// Fleet device that will be allowed to connect to this machine
        host: String,
        /// Expected SHA256 fingerprint (required without a terminal)
        #[arg(long)]
        fingerprint: Option<String>,
    },
    /// Show this device's stable identity and Fleet key fingerprint
    Identity {
        /// Print stable JSON for scripts and agents
        #[arg(long)]
        json: bool,
    },
    /// Inspect or revoke passwordless Fleet access
    Access {
        #[command(subcommand)]
        command: AccessCommand,
    },
    /// Share a local web service with the fleet
    Expose {
        /// Service name; `t3` defaults to http://127.0.0.1:3773
        name: String,
        /// Local service URL
        url: Option<String>,
        /// Fleet-facing port (automatically selected by default)
        #[arg(long)]
        port: Option<u16>,
        /// Confirm that the service may listen on every LAN interface
        #[arg(long)]
        public: bool,
    },
    /// Stop sharing a local service
    Unexpose { name: String },
    /// Open a hosted service in your browser
    Open {
        /// Service name, or device/service when names collide
        service: String,
    },
    /// Install or start optional agent tools
    Tools {
        #[command(subcommand)]
        command: ToolsCommand,
    },
    /// Advertise this machine (used by the background service)
    #[command(hide = true)]
    Serve,
    /// Install and start the per-user discovery service
    #[command(hide = true)]
    Service {
        #[command(subcommand)]
        command: ServiceCommand,
    },
    /// Manage SSH access between Fleet machines
    #[command(hide = true)]
    Ssh {
        #[command(subcommand)]
        command: SshCommand,
    },
}

#[derive(Subcommand)]
enum ServiceCommand {
    Install,
    Uninstall,
}

#[derive(Subcommand)]
enum AccessCommand {
    /// Show devices granted passwordless access to this machine
    List {
        /// Print stable JSON for scripts and agents
        #[arg(long)]
        json: bool,
    },
    /// Revoke a device's Fleet-managed SSH key
    Revoke { name: String },
}

#[derive(Subcommand)]
enum ToolsCommand {
    /// Install if needed and sign in to Codex
    Codex,
    /// Start T3 Code in the current directory
    T3,
}

#[derive(Subcommand)]
enum GitCommand {
    /// Show Git and GitHub configuration
    Status {
        /// Print stable JSON for scripts and agents
        #[arg(long)]
        json: bool,
    },
    /// Configure missing Git identity fields and optionally GitHub authentication
    Setup {
        /// Global Git author name (only used when one is not already configured)
        #[arg(long)]
        name: Option<String>,
        /// Global Git author email (only used when one is not already configured)
        #[arg(long)]
        email: Option<String>,
        /// Authenticate and configure Git credentials using GitHub CLI
        #[arg(long)]
        github: bool,
    },
}

#[derive(Subcommand)]
enum SshCommand {
    /// Create Fleet's dedicated Ed25519 key if it does not exist
    Keygen,
    /// Print Fleet's public key
    PublicKey,
    /// Authorize Fleet's key on another machine (uses ssh-copy-id)
    Pair {
        /// Hostname, address, or name.local
        host: String,
        /// Remote SSH username (defaults to the local username)
        #[arg(short, long)]
        user: Option<String>,
    },
    /// Open an SSH session using Fleet's key
    Connect {
        host: String,
        #[arg(short, long)]
        user: Option<String>,
        #[arg(last = true)]
        args: Vec<String>,
    },
}

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error:#}");
        std::process::exit(ssh::exit_code(&error).unwrap_or(1));
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let ui = Ui::new(cli.no_color);
    match cli.command {
        Some(Command::Init {
            name,
            color,
            role,
            no_service,
        }) => setup::init(name, color, role, !no_service, ui),
        Some(Command::Discover {
            timeout,
            plain,
            json,
        }) => {
            let peers = discovery::discover(Duration::from_secs(timeout))?;
            discovery::print(&peers, plain, json, ui)?;
            Ok(())
        }
        Some(Command::Status { json }) => status::show(json, ui),
        Some(Command::Git {
            command: GitCommand::Status { json },
        }) => git_setup::status(json, ui),
        Some(Command::Git {
            command:
                GitCommand::Setup {
                    name,
                    email,
                    github,
                },
        }) => git_setup::setup(name, email, github, ui),
        Some(Command::Connect {
            host,
            user,
            trust_host,
            args,
        }) => ssh::connect(&host, user.as_deref(), &args, trust_host, ui),
        Some(Command::Pair { host, fingerprint }) => ssh::pair(&host, fingerprint.as_deref(), ui),
        Some(Command::Identity { json }) => ssh::print_identity(json, ui),
        Some(Command::Access {
            command: AccessCommand::List { json },
        }) => ssh::print_access(json, ui),
        Some(Command::Access {
            command: AccessCommand::Revoke { name },
        }) => ssh::revoke_access(&name, ui),
        Some(Command::Expose {
            name,
            url,
            port,
            public,
        }) => hosted::expose(&name, url.as_deref(), port, public, ui),
        Some(Command::Unexpose { name }) => hosted::unexpose(&name, ui),
        Some(Command::Open { service }) => hosted::open(&service, ui),
        Some(Command::Tools {
            command: ToolsCommand::Codex,
        }) => setup::setup_codex(ui),
        Some(Command::Tools {
            command: ToolsCommand::T3,
        }) => setup::start_t3_code(ui),
        Some(Command::Serve) => discovery::serve(),
        Some(Command::Service {
            command: ServiceCommand::Install,
        }) => service::install(),
        Some(Command::Service {
            command: ServiceCommand::Uninstall,
        }) => service::uninstall(),
        Some(Command::Ssh {
            command: SshCommand::Keygen,
        }) => ssh::keygen(ui),
        Some(Command::Ssh {
            command: SshCommand::PublicKey,
        }) => ssh::print_public_key(),
        Some(Command::Ssh {
            command: SshCommand::Pair { host, user },
        }) => ssh::copy_key(&host, user.as_deref(), ui),
        Some(Command::Ssh {
            command: SshCommand::Connect { host, user, args },
        }) => ssh::connect(&host, user.as_deref(), &args, false, ui),
        None => {
            use clap::CommandFactory;
            Cli::command().print_help()?;
            println!();
            Ok(())
        }
    }
}
