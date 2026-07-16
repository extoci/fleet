use crate::cli::{Color, Tool};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    Captain,
    Member,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalConfig {
    pub version: u32,
    pub role: Role,
    pub machine: Machine,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captain: Option<CaptainRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Machine {
    pub id: Uuid,
    pub name: String,
    pub color: Color,
    pub ssh_user: String,
    pub os: String,
    pub arch: String,
    #[serde(default)]
    pub tools: Vec<ToolState>,
    pub public_identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_host_key: Option<String>,
}

impl Machine {
    pub fn host(&self) -> String {
        format!("{}.local", self.name)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptainRef {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub fingerprint: String,
    pub ssh_public_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolState {
    pub tool: Tool,
    pub installed: bool,
}

#[derive(Debug, Clone)]
pub struct StatePaths {
    pub root: PathBuf,
}

impl StatePaths {
    pub fn discover() -> Result<Self> {
        if let Some(path) = std::env::var_os("FLEET_HOME") {
            return Ok(Self { root: path.into() });
        }
        let home = dirs::home_dir().context("could not determine home directory")?;
        Ok(Self {
            root: home.join(".fleet"),
        })
    }

    pub fn config(&self) -> PathBuf {
        self.root.join("config.toml")
    }

    pub fn inventory_dir(&self) -> PathBuf {
        self.root.join("inventory")
    }

    pub fn identity_dir(&self) -> PathBuf {
        self.root.join("identity")
    }

    pub fn shell_dir(&self) -> PathBuf {
        self.root.join("shell")
    }

    pub fn skill_dir(&self) -> PathBuf {
        self.root.join("skill")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn log_file(&self) -> PathBuf {
        self.logs_dir().join("fleet.log")
    }

    pub fn known_hosts(&self) -> PathBuf {
        self.root.join("known_hosts")
    }

    pub fn load(&self) -> Result<Option<LocalConfig>> {
        let path = self.config();
        if !path.exists() {
            return Ok(None);
        }
        let source =
            fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
        let config =
            toml::from_str(&source).with_context(|| format!("parse {}", path.display()))?;
        validate_config(&config)?;
        Ok(Some(config))
    }

    pub fn require(&self) -> Result<LocalConfig> {
        self.load()?.context("this machine is not in a fleet")
    }

    pub fn save(&self, config: &LocalConfig) -> Result<()> {
        validate_config(config)?;
        fs::create_dir_all(&self.root)
            .with_context(|| format!("create {}", self.root.display()))?;
        let source = toml::to_string_pretty(config).context("serialize Fleet state")?;
        atomic_write(&self.config(), source.as_bytes(), 0o600)
    }

    pub fn ensure_uninitialized(&self) -> Result<()> {
        if let Some(config) = self.load()? {
            bail!(
                "this machine is already a {}; run `fleet leave` first",
                match config.role {
                    Role::Captain => "captain",
                    Role::Member => "member",
                }
            );
        }
        Ok(())
    }
}

fn validate_config(config: &LocalConfig) -> Result<()> {
    if config.version != STATE_VERSION {
        bail!(
            "Fleet state version {} is unsupported by this binary (expected {})",
            config.version,
            STATE_VERSION
        );
    }
    validate_machine_name(&config.machine.name)?;
    match (&config.role, &config.captain) {
        (Role::Captain, None) => {}
        (Role::Member, Some(captain)) => {
            validate_machine_name(&captain.name).context("invalid captain name in Fleet state")?;
            if captain.host != format!("{}.local", captain.name) {
                bail!("captain hostname in Fleet state does not match its machine name");
            }
        }
        (Role::Captain, Some(_)) => bail!("captain state must not refer to another captain"),
        (Role::Member, None) => bail!("member state is missing its captain"),
    }
    Ok(())
}

pub fn validate_machine_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > 63 {
        bail!("machine name must contain 1–63 characters");
    }
    let bytes = name.as_bytes();
    let valid_edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    if !valid_edge(bytes[0]) || !valid_edge(bytes[bytes.len() - 1]) {
        bail!("machine name must begin and end with a lowercase letter or digit");
    }
    if !bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
    {
        bail!("machine name may contain lowercase letters, digits, and interior hyphens only");
    }
    Ok(())
}

pub fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let parent = path.parent().context("file path has no parent")?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .with_context(|| format!("create temporary file in {}", parent.display()))?;
    temporary.write_all(bytes).context("write temporary file")?;
    temporary
        .as_file()
        .sync_all()
        .context("sync temporary file")?;
    set_mode(temporary.path(), mode)?;
    temporary
        .persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("replace {}", path.display()))?;
    Ok(())
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .with_context(|| format!("set permissions on {}", path.display()))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_name_contract() {
        for name in ["a", "emerald", "ruby-2", "x9"] {
            assert!(validate_machine_name(name).is_ok(), "{name}");
        }
        for name in ["", "Emerald", "ruby.local", "-ruby", "ruby-", "ruby_two"] {
            assert!(validate_machine_name(name).is_err(), "{name}");
        }
    }

    #[test]
    fn state_round_trips() {
        let temp = tempfile::tempdir().unwrap();
        let paths = StatePaths {
            root: temp.path().join("fleet"),
        };
        let config = LocalConfig {
            version: STATE_VERSION,
            role: Role::Captain,
            machine: Machine {
                id: Uuid::new_v4(),
                name: "obsidian".into(),
                color: Color::Violet,
                ssh_user: "test".into(),
                os: "macos".into(),
                arch: "aarch64".into(),
                tools: vec![],
                public_identity: "ssh-ed25519 AAAA".into(),
                ssh_host_key: None,
            },
            captain: None,
        };
        paths.save(&config).unwrap();
        assert_eq!(paths.load().unwrap(), Some(config));
    }

    #[test]
    fn state_rejects_unknown_versions_and_invalid_role_shape() {
        let mut config = LocalConfig {
            version: STATE_VERSION + 1,
            role: Role::Captain,
            machine: Machine {
                id: Uuid::new_v4(),
                name: "obsidian".into(),
                color: Color::Violet,
                ssh_user: "test".into(),
                os: "linux".into(),
                arch: "x86_64".into(),
                tools: vec![],
                public_identity: "unused".into(),
                ssh_host_key: None,
            },
            captain: None,
        };
        assert!(validate_config(&config).is_err());
        config.version = STATE_VERSION;
        config.role = Role::Member;
        assert!(validate_config(&config).is_err());
    }
}
