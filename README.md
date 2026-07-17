# Fleet

Fleet makes your local macOS and Linux machines feel like parts of one computer for AI-assisted development.

One machine is the **captain**. Members get real `.local` names, passwordless SSH from the captain, persistent themed tmux sessions, and optionally installed Codex or Claude Code. Fleet provides the device fabric; coding tools own delegation and work.

## Install

Install or update to the latest published release:

```sh
curl -fsSL https://extoci.lol/fleet.sh | sh
```

During local development, build Fleet and run the checked-in installer:

```sh
cargo build --release
FLEET_BINARY="$PWD/target/release/fleet" ./fleet.sh
```

The installer downloads the correct checksummed binary from GitHub Releases.
After installing v0.4.0 or newer, update in place with:

```sh
fleet update
```

Installations older than v0.4.0 must rerun the installer once to gain the
self-update command.

## Start a fleet

On the captain:

```sh
fleet init
```

On another machine on the same trusted LAN:

```sh
fleet join
```

Back on the captain:

```sh
fleet status
ssh emerald.local
```

Use `fleet status --check` for live reachability, `fleet status --watch` to
monitor it, `fleet doctor` for a concise health check, and `fleet logs` for
detailed diagnostics.

Interactive SSH creates or reattaches a tmux session named `fleet`. To bypass it for one login, run `ssh -t emerald.local 'NO_TMUX=1 exec "$SHELL" -l'`. Non-interactive SSH, SCP, and SFTP are not intercepted.

To leave while preserving the hostname, tools, prompt, tmux setup, repositories, and user data:

```sh
fleet leave
```

If an offline member leaves a stale record, run `fleet remove <name>` on the
captain. A captain can deliberately discard remaining records with
`fleet leave --force`.

## Trust and privacy

Fleet has no account, hosted control plane, relay, or telemetry. State and coordination stay on the local network. Tool and package installation may contact their official download sources.

Captain discovery is unauthenticated mDNS. The confirmation shown by `fleet join` is trust-on-first-use on a trusted LAN, not independently authenticated pairing. After confirmation, Fleet pins identities and SSH host keys. Member registration and leave requests are signed with the pinned Fleet identity.

## v0 boundaries

- macOS and Debian/Ubuntu Linux with systemd and apt
- Bash and Zsh only
- One fleet per machine
- LAN and `.local` addressing only
- No Tailscale, file transfer, synchronization, task orchestration, T3 Code installation, Windows, or captain recovery
- Captain discovery is available while the captain user's login session is active

See [the product vision](docs/product-vision.md), [v0 specification](docs/spec-v0.md), and [platform research](docs/research/fleet-v0-platform-assumptions.md).

## Development

```sh
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

The constrained Multipass and native macOS verification procedure is in [docs/verification.md](docs/verification.md). The requirement-by-requirement completion proof is in [docs/completion-audit-v0.md](docs/completion-audit-v0.md).

The release procedure and hosting setup are in [docs/releasing.md](docs/releasing.md).
