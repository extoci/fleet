use clap::{ArgAction, Args, Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};

#[derive(Debug, Parser)]
#[command(
    name = "fleet",
    version,
    disable_version_flag = true,
    about = "Make your computers feel like one computer"
)]
pub struct Cli {
    /// Print version information.
    #[arg(
        short = 'v',
        long = "version",
        visible_short_alias = 'V',
        action = ArgAction::Version
    )]
    pub version: Option<bool>,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Turn this machine into the captain.
    Init(InitArgs),
    /// Join the captain discovered on this local network.
    Join(JoinArgs),
    /// Show this machine's locally recorded Fleet topology.
    Status(StatusArgs),
    /// Leave the current fleet without undoing machine setup.
    Leave(LeaveArgs),
    /// Remove a member from this captain's inventory.
    Remove(RemoveArgs),
    /// Check Fleet's local setup and network health.
    Doctor,
    /// Show detailed Fleet diagnostic logs.
    Logs(LogsArgs),
    /// Restart the captain background service.
    Restart(RestartArgs),
    /// Update Fleet to the latest available version.
    Update,
    /// Run the captain registration service.
    #[command(hide = true)]
    Daemon(DaemonArgs),
}

#[derive(Debug, Args)]
pub struct InitArgs {
    /// Real hostname to assign to this captain.
    #[arg(long)]
    pub name: Option<String>,
    /// Terminal identity color.
    #[arg(long, value_enum)]
    pub color: Option<Color>,
    /// Accept confirmations; still prompts for missing values.
    #[arg(long)]
    pub yes: bool,
    /// Print the mutation plan without changing the machine.
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(Debug, Args)]
pub struct JoinArgs {
    /// Real hostname to assign to this member.
    #[arg(long)]
    pub name: Option<String>,
    /// Terminal identity color.
    #[arg(long, value_enum)]
    pub color: Option<Color>,
    /// Explicit captain endpoint for diagnostics/tests, such as host:port.
    #[arg(long, hide = true)]
    pub captain: Option<String>,
    /// Install a missing tool. May be repeated.
    #[arg(long, value_enum)]
    pub tool: Vec<Tool>,
    /// Trust the discovered captain and accept confirmations.
    #[arg(long)]
    pub yes: bool,
    /// Do not launch newly installed tools' login flows.
    #[arg(long)]
    pub no_login: bool,
    /// Print the mutation plan without changing the machine.
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(Debug, Args)]
pub struct StatusArgs {
    /// Emit stable JSON for scripts and tests.
    #[arg(long)]
    pub json: bool,
    /// Check whether recorded machines are currently reachable.
    #[arg(long)]
    pub check: bool,
    /// Refresh checked status until interrupted.
    #[arg(long)]
    pub watch: bool,
}

#[derive(Debug, Args)]
pub struct LeaveArgs {
    /// Skip the leave confirmation.
    #[arg(long)]
    pub yes: bool,
    /// Print the mutation plan without changing the machine.
    #[arg(long)]
    pub dry_run: bool,
    /// Let a captain leave even when stale members remain.
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, Args)]
pub struct RemoveArgs {
    /// Member name (with or without .local) or machine ID.
    pub member: String,
    /// Skip the removal confirmation.
    #[arg(long)]
    pub yes: bool,
    /// Print the mutation plan without changing anything.
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(Debug, Args)]
pub struct LogsArgs {
    /// Number of recent log lines to show.
    #[arg(long, default_value_t = 100)]
    pub lines: usize,
}

#[derive(Debug, Args)]
pub struct RestartArgs {
    /// Print the restart command without running it.
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(Debug, Args)]
pub struct DaemonArgs {
    /// Listen address; normally supplied by the service definition.
    #[arg(long, default_value = "0.0.0.0:42170")]
    pub listen: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Color {
    Red,
    Orange,
    Yellow,
    Green,
    Emerald,
    Cyan,
    Blue,
    Violet,
    Magenta,
}

impl Color {
    pub const ALL: [Self; 9] = [
        Self::Red,
        Self::Orange,
        Self::Yellow,
        Self::Green,
        Self::Emerald,
        Self::Cyan,
        Self::Blue,
        Self::Violet,
        Self::Magenta,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Red => "red",
            Self::Orange => "orange",
            Self::Yellow => "yellow",
            Self::Green => "green",
            Self::Emerald => "emerald",
            Self::Cyan => "cyan",
            Self::Blue => "blue",
            Self::Violet => "violet",
            Self::Magenta => "magenta",
        }
    }

    pub fn ansi_256(self) -> u8 {
        match self {
            Self::Red => 196,
            Self::Orange => 208,
            Self::Yellow => 220,
            Self::Green => 34,
            Self::Emerald => 42,
            Self::Cyan => 44,
            Self::Blue => 33,
            Self::Violet => 99,
            Self::Magenta => 201,
        }
    }

    pub fn tmux_foreground_256(self) -> u8 {
        match self {
            Self::Violet => 231,
            _ => 16,
        }
    }
}

impl std::fmt::Display for Color {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.name())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Tool {
    Codex,
    ClaudeCode,
}

impl Tool {
    pub const ALL: [Self; 2] = [Self::Codex, Self::ClaudeCode];

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::ClaudeCode => "Claude Code",
        }
    }

    pub fn command(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude",
        }
    }
}
