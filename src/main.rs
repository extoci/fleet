use anyhow::Result;
use clap::Parser;
use fleet::cli::Cli;

fn main() -> Result<()> {
    let cli = Cli::parse();
    let result = fleet::commands::run(cli);
    if let Err(error) = &result
        && let Ok(paths) = fleet::state::StatePaths::discover()
    {
        fleet::logging::detail(&paths, "command", format!("{error:#}"));
    }
    result
}
