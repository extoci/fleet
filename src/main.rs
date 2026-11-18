use anyhow::Result;
use clap::Parser;
use fleet::cli::Cli;

fn main() -> Result<()> {
    let cli = Cli::parse();
    let dry_run = cli.command.is_dry_run();
    let result = fleet::commands::run(cli);
    if !dry_run
        && let Err(error) = &result
        && let Ok(paths) = fleet::state::StatePaths::discover()
    {
        fleet::logging::detail(&paths, "command", format!("{error:#}"));
    }
    result
}
