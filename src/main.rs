mod config;
mod discovery;
mod service;
mod setup;
mod ssh;

use std::time::Duration;

use anyhow::{Result, bail};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "fleet", version, about = "Manage the computers in your fleet")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Set up this machine's identity, SSH key, and discovery service
    Init {
        /// Fleet name for this machine (defaults to its hostname)
        #[arg(long)]
        name: Option<String>,
        /// Do not install the background discovery service
        #[arg(long)]
        no_service: bool,
    },
    /// Find Fleet machines on the local network
    Discover {
        /// Seconds to listen for announcements
        #[arg(short, long, default_value_t = 3)]
        timeout: u64,
        /// Print machine-readable tab-separated output
        #[arg(long)]
        plain: bool,
    },
    /// Advertise this machine (normally run by the background service)
    Serve,
    /// Install and start the per-user discovery service
    Service {
        #[command(subcommand)]
        command: ServiceCommand,
    },
    /// Manage SSH access between Fleet machines
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
    match cli.command {
        Some(Command::Init { name, no_service }) => setup::init(name, !no_service),
        Some(Command::Discover { timeout, plain }) => {
            let peers = discovery::discover(Duration::from_secs(timeout))?;
            discovery::print(&peers, plain);
            Ok(())
        }
        Some(Command::Serve) => discovery::serve(),
        Some(Command::Service {
            command: ServiceCommand::Install,
        }) => service::install(),
        Some(Command::Service {
            command: ServiceCommand::Uninstall,
        }) => service::uninstall(),
        Some(Command::Ssh {
            command: SshCommand::Keygen,
        }) => {
            ssh::ensure_key()?;
            Ok(())
        }
        Some(Command::Ssh {
            command: SshCommand::PublicKey,
        }) => ssh::print_public_key(),
        Some(Command::Ssh {
            command: SshCommand::Pair { host, user },
        }) => ssh::pair(&host, user.as_deref()),
        Some(Command::Ssh {
            command: SshCommand::Connect { host, user, args },
        }) => ssh::connect(&host, user.as_deref(), &args),
        None => {
            Cli::parse_from(["fleet", "--help"]);
            bail!("choose a command; try `fleet --help`");
        }
    }
}
