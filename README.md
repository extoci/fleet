# Fleet

Your machines, one command away.

Fleet turns Macs and Linux boxes on the same network into an SSH-ready group. Devices announce themselves over mDNS, carry a recognizable color, and let their owners choose which Fleet keys receive passwordless access. There is no registry, and devices that have not been allowed can use normal SSH password authentication.

## Install

```sh
npm install --global @extoci/fleet
fleet init
```

Or use the small shell installer, which only verifies and installs the native Rust binary:

```sh
curl -fsSL https://raw.githubusercontent.com/extoci/fleet/main/fleet.sh | sh
fleet init
```

The installer stops after placing the binary on your machine. Run `fleet init` when you're ready to configure it.

Published binaries support macOS on Apple Silicon and Intel, plus glibc-based ARM64/x64 Linux distributions equivalent to Ubuntu 22.04 or newer.

During initialization, Fleet asks whether the device is a server or client, followed by its name and color. A server accepts SSH connections, advertises itself, and offers the full developer-workstation setup. A client is a lightweight controller: it gets a dedicated Fleet key and can discover and connect to servers on demand, but Fleet does not enable inbound SSH or install a background service. Fleet previews the selected setup and waits for confirmation before changing the machine.

Server setup includes a dedicated Fleet SSH key, tmux, Git, GitHub CLI, a color-coded Bash/Zsh prompt, automatic tmux resume on interactive SSH logins, Git identity and GitHub authentication, Codex installation/sign-in, Bun when needed, and optional T3 Code startup. Client setup only creates Fleet's configuration and dedicated key. Existing shell configuration, SSH keys, and unrelated `authorized_keys` entries are preserved.

## Everyday use

```sh
# Nearby devices
fleet ls

# A shell — uses the Fleet key when allowed, otherwise asks for a password
fleet connect studio

# A remote command with clean stdout
fleet connect studio -- uname -a

# Inspect this device's stable identity and key fingerprint
fleet identity

# Review or revoke inbound passwordless access
fleet access list
fleet access revoke laptop

# Configure missing Git identity fields and, optionally, GitHub authentication
fleet git setup

# Share T3 Code, even when it only listens on localhost
fleet expose t3 --public

# Open a discovered service
fleet open studio/t3

# Inspect or repair local setup
fleet status
fleet init
```

Choose a device identity explicitly or let Fleet derive a stable color from its name:

```sh
fleet init --name studio --color violet
fleet init --name build-box --color amber
fleet init --role client --name powerbook
```

Initialization is idempotent. Running it again keeps the existing name, color, ports, and SSH identity unless an option explicitly changes them.

Interactive SSH shells automatically attach to the device's persistent `fleet` tmux session, so reconnecting returns to the same terminals. Set `NO_TMUX=1` for a login that should bypass tmux. Remote commands such as `fleet connect studio -- uptime` remain non-interactive and never enter tmux.

## Agents and automation

Fleet names are stable handles for agents; they do not need to select an interface address or manage SSH flags.

```sh
fleet discover --json
fleet status --json
fleet connect build-box -- cargo test
```

SSH host keys are pinned to Fleet's stable device ID. The first interactive connection asks for confirmation; first-use automation must opt in with `--trust-host`, and later commands fail closed if that host key changes.

JSON commands write only JSON to stdout. Remote commands write only the remote command’s stdout/stderr, making them safe to compose. `fleet discover --plain` remains available for tab-separated shell pipelines. `NO_COLOR=1` and the global `--no-color` flag disable ANSI styling.

Useful commands:

```text
fleet init [--name NAME] [--color COLOR] [--role server|client] [--no-service]
fleet discover|ls [--timeout SECONDS] [--json|--plain]
fleet connect NAME [-- COMMAND...]
fleet pair NAME                    # allow NAME to connect here passwordlessly
fleet expose NAME [LOCAL_URL] [--port PUBLIC_PORT] --public
fleet unexpose NAME
fleet open [DEVICE/]SERVICE
fleet status [--json]
```

The older `fleet ssh ...` form remains available for compatibility but is hidden from the main help.

## Hosted services

`fleet ls` shows hosted web services directly beneath each device. Fleet proxies loopback-only services onto a Fleet-owned port, so applications do not need to bind to every network interface.

T3 Code has a built-in preset using its documented local development server:

```sh
fleet expose t3 --public                       # http://127.0.0.1:3773
fleet expose docs http://localhost:8080 --public
fleet unexpose docs
```

The proxy supports HTTP, HTTPS, streaming responses, and WebSocket connections because it forwards TCP without modifying application traffic. It binds every LAN interface, so Fleet requires the explicit `--public` acknowledgement. Only expose applications you are comfortable sharing with everyone on that network.

## How access works

Fleet advertises `_fleet._tcp.local` and its SSH username, port, version, and color. Each device also serves its dedicated Ed25519 public key through a read-only Fleet identity endpoint. During `fleet init`, you choose which discovered devices' keys are added to this machine's `authorized_keys`. You can allow another device later by running `fleet pair NAME` on the machine receiving the connection.

`fleet connect NAME` never changes access on either machine. It uses the dedicated Fleet key first and can fall back to the account's normal SSH authentication. Fleet pins SSH host keys to a persistent device ID so DHCP address changes do not discard that trust.

Pairing displays the peer's Ed25519 SHA-256 fingerprint before making changes. Compare it with `fleet identity` on the peer. Scripts must provide that exact value with `fleet pair NAME --fingerprint SHA256:…`; a non-interactive bare pairing is rejected. `fleet access list` shows recorded grants and `fleet access revoke NAME` removes only keys Fleet added itself.

## Git and GitHub

The first-run wizard fills in missing global Git name and email fields without overwriting existing values, then uses GitHub CLI to sign in and configure credentials when accepted. You can revisit it with `fleet git setup`; preconfigured environments may pass `--name`, `--email`, and `--github` explicitly. `fleet git status --json` is available for automation.

The wizard also offers Codex installation/sign-in and T3 Code startup by default. Their standalone commands remain available:

```sh
fleet tools codex
fleet tools t3
```

## Development

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release
```

For a local npm packaging test:

```sh
FLEET_BINARY="$PWD/target/release/fleet" npm install --global "$PWD"
```

Pushing a matching `v*` tag builds checksum-verified archives for Apple Silicon, Intel macOS, ARM64 Linux, and x64 Linux, creates a GitHub release, and publishes `@extoci/fleet`. Configure `NPM_TOKEN` before the first release.
