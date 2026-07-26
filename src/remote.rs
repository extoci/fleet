use anyhow::{Context, Result, bail};
use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const SSH_CONNECT_TIMEOUT_SECS: &str = "8";
const SSH_KEEPALIVE_SECS: &str = "5";

/// Run a non-interactive command through the system SSH client with a hard deadline.
///
/// OpenSSH remains Fleet's transport (and therefore continues to use Fleet's pinned
/// host keys and identity), while this wrapper makes every caller use the same
/// liveness settings. The outer deadline also covers DNS resolution and a remote
/// process that stops producing output, which OpenSSH's ConnectTimeout does not.
pub fn ssh_output(host: &str, remote_command: &str, timeout: Duration) -> Result<Output> {
    let mut command = Command::new("ssh");
    command.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectionAttempts=1",
        "-o",
        &format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_SECS}"),
        "-o",
        &format!("ServerAliveInterval={SSH_KEEPALIVE_SECS}"),
        "-o",
        "ServerAliveCountMax=2",
        host,
        remote_command,
    ]);
    output_with_timeout(&mut command, timeout)
        .with_context(|| format!("communicate with {host} over SSH"))
}

pub fn output_with_timeout(command: &mut Command, timeout: Duration) -> Result<Output> {
    configure_process_group(command);
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("start command")?;
    let stdout = child.stdout.take().context("capture command stdout")?;
    let stderr = child.stderr.take().context("capture command stderr")?;
    let stdout_reader = thread::spawn(move || read_all(stdout));
    let stderr_reader = thread::spawn(move || read_all(stderr));

    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().context("wait for command")? {
            break status;
        }
        if started.elapsed() >= timeout {
            terminate_process_group(&mut child);
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            bail!(
                "operation timed out after {} seconds",
                timeout.as_secs_f64()
            );
        }
        thread::sleep(Duration::from_millis(25));
    };

    let stdout = stdout_reader
        .join()
        .map_err(|_| anyhow::anyhow!("stdout reader panicked"))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| anyhow::anyhow!("stderr reader panicked"))??;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process_group(child: &mut std::process::Child) {
    // A remote shell can start descendants that inherit its output pipes. Kill
    // the isolated group so waiting for those readers cannot extend the deadline.
    let group = format!("-{}", child.id());
    let _ = Command::new("kill").args(["-KILL", "--", &group]).status();
    let _ = child.kill();
}

#[cfg(not(unix))]
fn terminate_process_group(child: &mut std::process::Child) {
    let _ = child.kill();
}

fn read_all(mut reader: impl Read) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_has_a_hard_deadline() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 10"]);
        let started = Instant::now();
        let error = output_with_timeout(&mut command, Duration::from_millis(50)).unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn command_captures_stdout_and_stderr() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf out; printf err >&2"]);
        let output = output_with_timeout(&mut command, Duration::from_secs(1)).unwrap();
        assert_eq!(output.stdout, b"out");
        assert_eq!(output.stderr, b"err");
    }
}
