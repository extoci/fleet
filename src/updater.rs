use anyhow::{Context, Result, bail};
use flate2::read::GzDecoder;
use reqwest::blocking::Client;
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tar::Archive;

const DEFAULT_REPOSITORY: &str = "extoci/fleet";
const POST_UPDATE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq, Eq)]
pub enum UpdateOutcome {
    Current { version: String },
    Updated { version: String },
}

pub fn update() -> Result<UpdateOutcome> {
    let target = release_target()?;
    let archive_name = format!("fleet-{target}.tar.gz");
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .user_agent(format!("fleet/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .context("create Fleet update client")?;

    println!("Checking for Fleet updates...");
    let release = resolve_release(&client)?;
    let version = release
        .version
        .unwrap_or_else(|| "the latest release".to_string());
    if version != "the latest release" && !is_newer(&version)? {
        return Ok(UpdateOutcome::Current {
            version: format!("v{}", env!("CARGO_PKG_VERSION")),
        });
    }
    let archive = download(&client, &format!("{}/{archive_name}", release.base))?;
    let checksum = download(&client, &format!("{}/{archive_name}.sha256", release.base))?;
    verify_checksum(&archive, &checksum)?;

    let workspace = tempfile::tempdir().context("create Fleet update workspace")?;
    Archive::new(GzDecoder::new(Cursor::new(archive)))
        .unpack(workspace.path())
        .context("extract Fleet update")?;
    let source = workspace.path().join("fleet");
    if !source.is_file() {
        bail!("release archive did not contain a binary named `fleet`");
    }

    let destination = update_destination()?;
    replace_binary(&source, &destination)?;
    complete_update(&destination, env!("CARGO_PKG_VERSION"))?;
    Ok(UpdateOutcome::Updated { version })
}

struct Release {
    base: String,
    version: Option<String>,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
}

fn resolve_release(client: &Client) -> Result<Release> {
    if let Ok(base) = std::env::var("FLEET_RELEASE_BASE_URL") {
        return Ok(Release {
            base: base.trim_end_matches('/').to_string(),
            version: std::env::var("FLEET_RELEASE_VERSION").ok(),
        });
    }
    let repository =
        std::env::var("FLEET_REPOSITORY").unwrap_or_else(|_| DEFAULT_REPOSITORY.into());
    let url = format!("https://api.github.com/repos/{repository}/releases/latest");
    let release: GithubRelease = client
        .get(&url)
        .send()
        .with_context(|| format!("check {repository} for updates"))?
        .error_for_status()
        .with_context(|| format!("check {repository} for updates"))?
        .json()
        .context("read latest Fleet release")?;
    if release.tag_name.is_empty() || release.tag_name.contains('/') {
        bail!("latest Fleet release has an invalid tag");
    }
    Ok(Release {
        base: format!(
            "https://github.com/{repository}/releases/download/{}",
            release.tag_name
        ),
        version: Some(release.tag_name),
    })
}

fn release_target() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        ("linux", "aarch64") => Ok("aarch64-unknown-linux-gnu"),
        ("linux", "x86_64") => Ok("x86_64-unknown-linux-gnu"),
        (os, arch) => bail!("Fleet updates are not available for {os}/{arch}"),
    }
}

fn is_newer(tag: &str) -> Result<bool> {
    let latest = Version::parse(tag.strip_prefix('v').unwrap_or(tag))
        .with_context(|| format!("latest Fleet release has invalid version `{tag}`"))?;
    let current =
        Version::parse(env!("CARGO_PKG_VERSION")).context("parse current Fleet version")?;
    Ok(latest > current)
}

fn download(client: &Client, url: &str) -> Result<Vec<u8>> {
    let response = client
        .get(url)
        .send()
        .with_context(|| format!("download {url}"))?
        .error_for_status()
        .with_context(|| format!("download {url}"))?;
    let bytes = response.bytes().context("read Fleet update download")?;
    Ok(bytes.to_vec())
}

fn verify_checksum(archive: &[u8], checksum_file: &[u8]) -> Result<()> {
    let checksum_file = std::str::from_utf8(checksum_file).context("read release checksum")?;
    let expected = checksum_file
        .split_whitespace()
        .next()
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .context("release checksum is invalid")?;
    let actual = format!("{:x}", Sha256::digest(archive));
    if !expected.eq_ignore_ascii_case(&actual) {
        bail!("release checksum did not match");
    }
    Ok(())
}

fn update_destination() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("FLEET_UPDATE_DESTINATION") {
        return Ok(path.into());
    }
    std::env::current_exe().context("locate the installed Fleet binary")
}

fn replace_binary(source: &Path, destination: &Path) -> Result<()> {
    let parent = destination
        .parent()
        .context("Fleet executable has no parent directory")?;
    let mut replacement = tempfile::NamedTempFile::new_in(parent)
        .with_context(|| format!("prepare update beside {}", destination.display()))?;
    let mut source = File::open(source).context("open downloaded Fleet binary")?;
    std::io::copy(&mut source, &mut replacement).context("stage Fleet update")?;
    replacement.flush().context("flush Fleet update")?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        replacement
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o755))
            .context("make Fleet update executable")?;
    }
    replacement
        .as_file()
        .sync_all()
        .context("sync Fleet update")?;
    replacement
        .into_temp_path()
        .persist(destination)
        .with_context(|| format!("replace {}", destination.display()))?;
    Ok(())
}

fn complete_update(destination: &Path, previous_version: &str) -> Result<()> {
    let mut child = Command::new(destination)
        .args(["__complete-update", "--from", previous_version])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| {
            format!(
                "start the newly installed Fleet binary at {}",
                destination.display()
            )
        })?;
    let deadline = Instant::now() + POST_UPDATE_TIMEOUT;
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "Fleet updated, but managed setup finalization timed out; run `fleet doctor --repair`"
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let output = child
        .wait_with_output()
        .context("collect managed setup finalization output")?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    bail!(
        "Fleet updated, but managed setup finalization failed{}; run `fleet doctor --repair`",
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_standard_checksum_file() {
        let archive = b"fleet archive";
        let checksum = format!("{:x}  fleet-test.tar.gz\n", Sha256::digest(archive));
        verify_checksum(archive, checksum.as_bytes()).unwrap();
    }

    #[test]
    fn rejects_checksum_mismatch() {
        let checksum = format!("{}  fleet-test.tar.gz\n", "0".repeat(64));
        let error = verify_checksum(b"fleet archive", checksum.as_bytes()).unwrap_err();
        assert!(error.to_string().contains("did not match"));
    }

    #[test]
    fn only_updates_to_a_newer_semantic_version() {
        assert!(!is_newer(env!("CARGO_PKG_VERSION")).unwrap());
        assert!(!is_newer("v0.1.0").unwrap());
        assert!(is_newer("v999.0.0").unwrap());
    }

    #[test]
    fn atomically_replaces_binary_and_sets_executable_mode() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("downloaded");
        let destination = directory.path().join("fleet");
        fs::write(&source, b"new fleet").unwrap();
        fs::write(&destination, b"old fleet").unwrap();

        replace_binary(&source, &destination).unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"new fleet");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
    }

    #[test]
    fn post_update_hook_reports_new_binary_failures() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("fleet");
        fs::write(&destination, b"#!/bin/sh\necho boom >&2\nexit 7\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&destination, fs::Permissions::from_mode(0o755)).unwrap();
        }

        let error = complete_update(&destination, "0.7.4").unwrap_err();
        assert!(
            error
                .to_string()
                .contains("managed setup finalization failed")
        );
        assert!(error.to_string().contains("doctor --repair"));
    }
}
