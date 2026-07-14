use std::io::{self, IsTerminal, Write};
use std::process::{Command, Output};

use anyhow::{Context, Result, bail};
use serde::Serialize;

use crate::ui::Ui;

#[derive(Debug, Serialize)]
struct GitStatus {
    git_installed: bool,
    name: Option<String>,
    email: Option<String>,
    gh_installed: bool,
    gh_authenticated: bool,
}

pub fn status(json: bool, ui: Ui) -> Result<()> {
    let status = inspect();
    if json {
        println!("{}", serde_json::to_string_pretty(&status)?);
        return Ok(());
    }

    if !status.git_installed {
        println!("Git             not installed");
        return Ok(());
    }

    println!("Git             installed");
    println!(
        "Name            {}",
        status.name.as_deref().unwrap_or("not configured")
    );
    println!(
        "Email           {}",
        status.email.as_deref().unwrap_or("not configured")
    );
    println!(
        "GitHub CLI      {}",
        if status.gh_installed {
            "installed"
        } else {
            "not installed"
        }
    );
    if status.gh_installed {
        println!(
            "GitHub account  {}",
            if status.gh_authenticated {
                "signed in"
            } else {
                "not signed in"
            }
        );
    }

    if status.name.is_none() || status.email.is_none() {
        ui.muted("Run `fleet git setup` to finish configuring Git.");
    }
    Ok(())
}

pub fn setup(name: Option<String>, email: Option<String>, github: bool, ui: Ui) -> Result<()> {
    if !command_succeeds("git", &["--version"]) {
        bail!("Git is not installed; install Git, then run `fleet git setup` again");
    }

    let interactive = io::stdin().is_terminal();
    let mut current_name = git_config("user.name");
    let mut current_email = git_config("user.email");

    configure_value(
        "name",
        "user.name",
        name,
        &mut current_name,
        interactive,
        ui,
    )?;
    configure_value(
        "email",
        "user.email",
        email,
        &mut current_email,
        interactive,
        ui,
    )?;

    let gh_installed = command_succeeds("gh", &["--version"]);
    let already_authenticated = gh_installed && command_succeeds("gh", &["auth", "status"]);
    let requested_github = already_authenticated
        || github
        || (interactive
            && gh_installed
            && confirm("Set up GitHub authentication with `gh`? [Y/n] ")?);

    if requested_github {
        if !gh_installed {
            bail!("GitHub CLI (`gh`) is not installed; install it from https://cli.github.com/");
        }
        if !already_authenticated {
            if !interactive {
                bail!(
                    "GitHub CLI is not signed in; run `gh auth login`, then `fleet git setup --github`"
                );
            }
            run("gh", &["auth", "login"])
                .context("GitHub CLI could not complete authentication")?;
        }

        // This is only reached after --github or an affirmative prompt. `setup-git`
        // lets gh choose the correct credential helper for each authenticated host.
        run("gh", &["auth", "setup-git"])
            .context("GitHub CLI could not configure Git credentials")?;
        ui.success("GitHub authentication is ready");
    }

    if current_name.is_some() && current_email.is_some() {
        ui.success("Git identity is ready");
    } else {
        ui.muted("Git identity is incomplete. Re-run with --name and/or --email when ready.");
    }
    Ok(())
}

fn inspect() -> GitStatus {
    let git_installed = command_succeeds("git", &["--version"]);
    let gh_installed = command_succeeds("gh", &["--version"]);
    GitStatus {
        git_installed,
        name: git_installed.then(|| git_config("user.name")).flatten(),
        email: git_installed.then(|| git_config("user.email")).flatten(),
        gh_installed,
        gh_authenticated: gh_installed && command_succeeds("gh", &["auth", "status"]),
    }
}

fn configure_value(
    label: &str,
    key: &str,
    requested: Option<String>,
    current: &mut Option<String>,
    interactive: bool,
    ui: Ui,
) -> Result<()> {
    if let Some(existing) = current.as_deref() {
        if requested
            .as_deref()
            .is_some_and(|value| value.trim() != existing)
        {
            ui.muted(format!(
                "Keeping existing Git {label} `{existing}` (Fleet never overwrites it)."
            ));
        }
        return Ok(());
    }

    let value = match requested {
        Some(value) => normalized(value),
        None if interactive => prompt(&format!("Git {label} (leave blank to skip): "))?,
        None => None,
    };
    let Some(value) = value else {
        return Ok(());
    };

    run("git", &["config", "--global", key, &value])
        .with_context(|| format!("set global Git {label}"))?;
    *current = Some(value);
    ui.success(format!("Configured Git {label}"));
    Ok(())
}

fn git_config(key: &str) -> Option<String> {
    let output = output("git", &["config", "--global", "--get", key])?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn output(program: &str, args: &[&str]) -> Option<Output> {
    Command::new(program).args(args).output().ok()
}

fn command_succeeds(program: &str, args: &[&str]) -> bool {
    output(program, args).is_some_and(|output| output.status.success())
}

fn run(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .status()
        .with_context(|| format!("run {program}"))?;
    if !status.success() {
        bail!("`{program} {}` exited unsuccessfully", args.join(" "));
    }
    Ok(())
}

fn prompt(label: &str) -> Result<Option<String>> {
    print!("{label}");
    io::stdout().flush().context("show Git setup prompt")?;
    let mut answer = String::new();
    io::stdin()
        .read_line(&mut answer)
        .context("read Git setup response")?;
    Ok(normalized(answer))
}

fn confirm(label: &str) -> Result<bool> {
    Ok(prompt(label)?
        .is_none_or(|answer| matches!(answer.to_ascii_lowercase().as_str(), "y" | "yes")))
}

fn normalized(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_trims_and_rejects_empty_values() {
        assert_eq!(
            normalized("  Ada Lovelace \n".into()).as_deref(),
            Some("Ada Lovelace")
        );
        assert_eq!(normalized(" \t\n".into()), None);
    }

    #[test]
    fn status_is_stable_json() {
        let status = GitStatus {
            git_installed: true,
            name: Some("Ada".into()),
            email: None,
            gh_installed: true,
            gh_authenticated: false,
        };
        let json = serde_json::to_value(status).unwrap();
        assert_eq!(json["name"], "Ada");
        assert_eq!(json["email"], serde_json::Value::Null);
        assert_eq!(json["gh_authenticated"], false);
    }
}
