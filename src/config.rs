use std::{env, fs, path::PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub name: String,
    pub user: String,
    pub ssh_port: u16,
    #[serde(default = "default_pair_port")]
    pub pair_port: u16,
}

pub fn default_pair_port() -> u16 {
    47_651
}

pub fn home() -> Result<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set")
}

pub fn dir() -> Result<PathBuf> {
    Ok(home()?.join(".config/fleet"))
}
pub fn path() -> Result<PathBuf> {
    Ok(dir()?.join("config.toml"))
}

pub fn load() -> Result<Config> {
    let path = path()?;
    let source = fs::read_to_string(&path).with_context(|| {
        format!(
            "Fleet is not initialized (missing {}). Run `fleet init`.",
            path.display()
        )
    })?;
    toml::from_str(&source).context("invalid Fleet configuration")
}

pub fn save(config: &Config) -> Result<()> {
    validate_name(&config.name)?;
    let dir = dir()?;
    fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    fs::write(path()?, toml::to_string_pretty(config)?).context("write Fleet configuration")
}

pub fn default_user() -> String {
    env::var("USER")
        .or_else(|_| env::var("USERNAME"))
        .unwrap_or_else(|_| "user".into())
}

pub fn validate_name(name: &str) -> Result<()> {
    let valid = !name.is_empty()
        && name.len() <= 63
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-');
    if !valid {
        bail!(
            "name must be 1–63 letters, numbers, or hyphens and cannot start or end with a hyphen"
        )
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_dns_labels() {
        assert!(validate_name("studio-mac").is_ok());
        assert!(validate_name("-bad").is_err());
        assert!(validate_name("spaces are bad").is_err());
    }
}
