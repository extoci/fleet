use anyhow::Result;
use clap::Parser;
use fleet::cli::Cli;

fn main() -> Result<()> {
    fleet::commands::run(Cli::parse())
}
