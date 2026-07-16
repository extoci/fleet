use crate::state::StatePaths;
use anyhow::{Context, Result, bail};
use base64::Engine;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::process::Stdio;

#[derive(Debug)]
pub struct Identity {
    pub private_key: PathBuf,
    pub public_key: String,
    pub fingerprint: String,
}

pub fn ensure(paths: &StatePaths) -> Result<Identity> {
    fs::create_dir_all(paths.identity_dir()).context("create identity directory")?;
    set_dir_mode(&paths.identity_dir())?;
    let private_key = paths.identity_dir().join("id_ed25519");
    let public_key_path = paths.identity_dir().join("id_ed25519.pub");
    match (private_key.exists(), public_key_path.exists()) {
        (false, false) => {
            let status = Command::new("ssh-keygen")
                .args([
                    "-q",
                    "-t",
                    "ed25519",
                    "-N",
                    "",
                    "-C",
                    "fleet-identity",
                    "-f",
                ])
                .arg(&private_key)
                .status()
                .context("run ssh-keygen; install OpenSSH client first")?;
            if !status.success() {
                bail!("ssh-keygen failed with {status}");
            }
        }
        (true, false) => {
            let output = Command::new("ssh-keygen")
                .args(["-y", "-f"])
                .arg(&private_key)
                .output()
                .context("recover Fleet public key from its private key")?;
            if !output.status.success() {
                bail!("could not recover the Fleet public key; inspect the private key and rerun");
            }
            let material = String::from_utf8(output.stdout)
                .context("ssh-keygen returned a non-UTF-8 public key")?;
            let public_key = format!("{} fleet-identity\n", public_key_material(material.trim())?);
            crate::state::atomic_write(&public_key_path, public_key.as_bytes(), 0o644)?;
        }
        (false, true) => {
            bail!(
                "Fleet's public identity exists but its private key is missing; restore the private key or remove {} and rerun",
                public_key_path.display()
            );
        }
        (true, true) => {}
    }
    let public_key = fs::read_to_string(&public_key_path)
        .with_context(|| format!("read {}", public_key_path.display()))?
        .trim()
        .to_owned();
    let fingerprint = fingerprint_public_key(&public_key)?;
    Ok(Identity {
        private_key,
        public_key,
        fingerprint,
    })
}

pub fn public_key_material(line: &str) -> Result<String> {
    if line.bytes().any(|byte| byte.is_ascii_control()) {
        bail!("SSH public key contains control characters");
    }
    let mut fields = line.split_whitespace();
    let algorithm = fields.next().context("missing SSH key algorithm")?;
    let encoded = fields.next().context("missing SSH public key")?;
    if algorithm != "ssh-ed25519" {
        bail!("Fleet requires an Ed25519 SSH public key");
    }
    let blob = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("SSH public key is not valid base64")?;
    validate_ed25519_blob(&blob)?;
    Ok(format!("{algorithm} {encoded}"))
}

pub fn fingerprint_public_key(line: &str) -> Result<String> {
    let material = public_key_material(line)?;
    let encoded = material
        .split_once(' ')
        .context("canonical SSH key is malformed")?
        .1;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("SSH public key is not valid base64")?;
    let digest = Sha256::digest(blob);
    Ok(format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)
    ))
}

pub fn sign(private_key: &Path, payload: &[u8]) -> Result<String> {
    let temp = tempfile::tempdir().context("create signing workspace")?;
    let message = temp.path().join("request");
    crate::state::atomic_write(&message, payload, 0o600)?;
    let output = Command::new("ssh-keygen")
        .args(["-Y", "sign", "-n", "fleet-request", "-f"])
        .arg(private_key)
        .arg(&message)
        .output()
        .context("sign Fleet request with ssh-keygen")?;
    if !output.status.success() {
        bail!(
            "could not sign Fleet request: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let signature = fs::read(message.with_extension("sig")).context("read request signature")?;
    Ok(base64::engine::general_purpose::STANDARD.encode(signature))
}

pub fn verify(public_key: &str, payload: &[u8], signature: &str) -> Result<()> {
    let public_key = public_key_material(public_key)?;
    let signature = base64::engine::general_purpose::STANDARD
        .decode(signature)
        .context("request signature is not valid base64")?;
    let temp = tempfile::tempdir().context("create verification workspace")?;
    let allowed = temp.path().join("allowed_signers");
    let signature_path = temp.path().join("request.sig");
    crate::state::atomic_write(
        &allowed,
        format!("fleet-device {public_key}\n").as_bytes(),
        0o600,
    )?;
    crate::state::atomic_write(&signature_path, &signature, 0o600)?;
    let mut child = Command::new("ssh-keygen")
        .args([
            "-Y",
            "verify",
            "-I",
            "fleet-device",
            "-n",
            "fleet-request",
            "-f",
        ])
        .arg(&allowed)
        .arg("-s")
        .arg(&signature_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("verify Fleet request with ssh-keygen")?;
    child
        .stdin
        .take()
        .context("open verifier input")?
        .write_all(payload)?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        bail!("request signature verification failed");
    }
    Ok(())
}

fn validate_ed25519_blob(blob: &[u8]) -> Result<()> {
    let (algorithm, remainder) = take_ssh_string(blob)?;
    if algorithm != b"ssh-ed25519" {
        bail!("SSH key blob does not contain an Ed25519 key");
    }
    let (key, trailing) = take_ssh_string(remainder)?;
    if key.len() != 32 || !trailing.is_empty() {
        bail!("SSH Ed25519 key blob has an invalid length");
    }
    Ok(())
}

fn take_ssh_string(bytes: &[u8]) -> Result<(&[u8], &[u8])> {
    let length_bytes: [u8; 4] = bytes
        .get(..4)
        .context("SSH key blob is truncated")?
        .try_into()
        .expect("slice has exactly four bytes");
    let length = u32::from_be_bytes(length_bytes) as usize;
    let value = bytes
        .get(4..4 + length)
        .context("SSH key blob is truncated")?;
    Ok((value, &bytes[4 + length..]))
}

#[cfg(unix)]
fn set_dir_mode(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("secure {}", path.display()))
}

#[cfg(not(unix))]
fn set_dir_mode(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEz89+OW5ab2qECsv5R8wC7KrgFcr1mHupSl25JaoOZp fleet-test";

    #[test]
    fn canonicalizes_keys_and_derives_openssh_fingerprint() {
        assert_eq!(
            public_key_material(KEY).unwrap(),
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEz89+OW5ab2qECsv5R8wC7KrgFcr1mHupSl25JaoOZp"
        );
        assert!(fingerprint_public_key(KEY).unwrap().starts_with("SHA256:"));
    }

    #[test]
    fn rejects_multiline_and_mislabeled_keys() {
        assert!(public_key_material(&format!("{KEY}\nssh-ed25519 injected")).is_err());
        assert!(public_key_material(&KEY.replacen("ssh-ed25519", "ssh-rsa", 1)).is_err());
    }

    #[test]
    fn resumes_when_only_the_generated_public_key_is_missing() {
        let temp = tempfile::tempdir().unwrap();
        let paths = StatePaths {
            root: temp.path().join(".fleet"),
        };
        let original = ensure(&paths).unwrap();
        fs::remove_file(paths.identity_dir().join("id_ed25519.pub")).unwrap();
        let recovered = ensure(&paths).unwrap();
        assert_eq!(recovered.fingerprint, original.fingerprint);
        assert_eq!(recovered.public_key, original.public_key);
    }

    #[test]
    fn fails_actionably_when_the_private_key_is_missing() {
        let temp = tempfile::tempdir().unwrap();
        let paths = StatePaths {
            root: temp.path().join(".fleet"),
        };
        fs::create_dir_all(paths.identity_dir()).unwrap();
        fs::write(paths.identity_dir().join("id_ed25519.pub"), KEY).unwrap();
        assert!(
            ensure(&paths)
                .unwrap_err()
                .to_string()
                .contains("private key is missing")
        );
    }

    #[test]
    fn signatures_bind_requests_to_the_fleet_identity() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_paths = StatePaths {
            root: first.path().join(".fleet"),
        };
        let second_paths = StatePaths {
            root: second.path().join(".fleet"),
        };
        let first_identity = ensure(&first_paths).unwrap();
        let second_identity = ensure(&second_paths).unwrap();
        let payload = br#"{"id":"device-one"}"#;
        let signature = sign(&first_identity.private_key, payload).unwrap();
        verify(&first_identity.public_key, payload, &signature).unwrap();
        assert!(verify(&second_identity.public_key, payload, &signature).is_err());
        assert!(verify(&first_identity.public_key, b"changed", &signature).is_err());
    }
}
