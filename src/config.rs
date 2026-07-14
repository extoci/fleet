use std::{env, fs, path::PathBuf};

use anyhow::{Context, Result, bail};
use clap::ValueEnum;
use serde::{Deserialize, Serialize};

use crate::hosted::HostedService;
use crate::ui::DeviceColor;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum DeviceRole {
    #[default]
    Server,
    Client,
}

impl DeviceRole {
    pub fn label(self) -> &'static str {
        match self {
            Self::Server => "server",
            Self::Client => "client",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub device_id: String,
    pub name: String,
    pub user: String,
    pub ssh_port: u16,
    #[serde(default = "default_pair_port")]
    pub pair_port: u16,
    #[serde(default)]
    pub color: DeviceColor,
    #[serde(default)]
    pub role: DeviceRole,
    #[serde(default)]
    pub services: Vec<HostedService>,
}

pub fn new_device_id() -> String {
    use std::io::Read;
    let mut bytes = [0_u8; 16];
    if fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .is_err()
    {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        std::time::SystemTime::now().hash(&mut hasher);
        std::process::id().hash(&mut hasher);
        bytes[..8].copy_from_slice(&hasher.finish().to_be_bytes());
        bytes[8..].copy_from_slice(&hasher.finish().rotate_left(17).to_be_bytes());
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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
    let mut config: Config = toml::from_str(&source).context("invalid Fleet configuration")?;
    if config.device_id.is_empty() {
        config.device_id = new_device_id();
        save(&config).context("upgrade Fleet configuration")?;
    }
    Ok(config)
}

pub fn load_optional() -> Result<Option<Config>> {
    let path = path()?;
    if !path.exists() {
        return Ok(None);
    }
    let source = fs::read_to_string(&path)
        .with_context(|| format!("read Fleet configuration at {}", path.display()))?;
    toml::from_str(&source)
        .context("invalid Fleet configuration")
        .map(Some)
}

pub fn save(config: &Config) -> Result<()> {
    validate_name(&config.name)?;
    let dir = dir()?;
    fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let destination = path()?;
    let temporary = dir.join("config.toml.tmp");
    fs::write(&temporary, toml::to_string_pretty(config)?).context("write Fleet configuration")?;
    fs::rename(temporary, destination).context("commit Fleet configuration")
}

pub fn remove() -> Result<()> {
    let path = path()?;
    if path.exists() {
        fs::remove_file(&path)
            .with_context(|| format!("remove Fleet configuration at {}", path.display()))?;
    }
    Ok(())
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

    #[test]
    fn generated_names_fit_dns() {
        assert!(validate_name(&"a".repeat(63)).is_ok());
        assert!(validate_name(&"a".repeat(64)).is_err());
        assert!(validate_name("").is_err());
    }

    #[test]
    fn device_ids_are_random_shaped_hex() {
        let first = new_device_id();
        let second = new_device_id();
        assert_eq!(first.len(), 32);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }
}
