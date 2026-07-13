mod config;
mod discovery;
mod service;
mod setup;
mod ssh;
mod status;
mod ui;

use std::time::Duration;

use anyhow::Result;
use clap::{Parser, Subcommand};
use ui::{DeviceColor, Ui};

#[derive(Parser)]
#[command(
    name = "fleet",
    version,
    about = "Your machines, one command away.",
    after_help = "Examples:\n  fleet init --name studio --color violet\n  fleet ls\n  fleet connect studio\n  fleet connect studio -- uname -a\n  fleet status --json"
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
    /// Open a shell or run a command
    Connect {
        host: String,
        #[arg(short, long)]
        user: Option<String>,
        #[arg(last = true)]
        args: Vec<String>,
    },
    /// Trust a device without a password
    Pair {
        host: String,
        #[arg(short, long)]
        user: Option<String>,
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
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let ui = Ui::new(cli.no_color);
    match cli.command {
        Some(Command::Init {
            name,
            color,
            no_service,
        }) => setup::init(name, color, !no_service, ui),
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
        Some(Command::Connect { host, user, args }) => {
            ssh::connect(&host, user.as_deref(), &args, ui)
        }
        Some(Command::Pair { host, user }) => ssh::pair(&host, user.as_deref(), ui),
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
        }) => ssh::pair(&host, user.as_deref(), ui),
        Some(Command::Ssh {
            command: SshCommand::Connect { host, user, args },
        }) => ssh::connect(&host, user.as_deref(), &args, ui),
        None => {
            use clap::CommandFactory;
            Cli::command().print_help()?;
            println!();
            Ok(())
        }
    }
}
