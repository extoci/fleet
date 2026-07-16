use crate::state::StatePaths;
use std::fs::{self, OpenOptions};
use std::io::Write;

pub fn detail(paths: &StatePaths, area: &str, message: impl std::fmt::Display) {
    let _ = fs::create_dir_all(paths.logs_dir());
    secure(&paths.logs_dir(), 0o700);
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.log_file())
    {
        secure(&paths.log_file(), 0o600);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or_default();
        let sanitized = message.to_string().replace('\n', " | ");
        let _ = writeln!(file, "{now} [{area}] {sanitized}");
    }
}

#[cfg(unix)]
fn secure(path: &std::path::Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn secure(_path: &std::path::Path, _mode: u32) {}

pub fn user_error(
    paths: &StatePaths,
    area: &str,
    summary: &str,
    error: &anyhow::Error,
) -> anyhow::Error {
    detail(paths, area, format!("{error:#}"));
    anyhow::anyhow!("{summary}. Run `fleet logs` for more information")
}
