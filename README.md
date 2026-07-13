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

During initialization, Fleet asks for the device name and color, then shows nearby Fleet devices and lets you choose which ones may SSH into this machine without a password. Devices you do not choose use the account's normal SSH authentication, typically a password when password login is enabled. Fleet previews the SSH and discovery changes and waits for confirmation before changing the machine. It may then ask for `sudo` to enable the system SSH server and boot-time discovery.

Fleet creates a dedicated `~/.ssh/id_ed25519_fleet` key and preserves existing SSH keys and unrelated `authorized_keys` entries. After core setup is complete, it offers to install and sign in to the standalone Codex CLI, then offers to start T3 Code with `bunx t3@latest`. T3 Code may compile its terminal dependency, so Fleet installs missing native build tools after telling you. Its temporary files live under `~/.config/fleet/tmp` instead of memory-backed `/tmp`, allowing it to start on small Fleet machines. Press Enter to accept or `n` to skip. Flags remain available for preconfigured installs, and non-interactive setup chooses no passwordless peers and skips optional tools.

## Everyday use

```sh
# Nearby devices
fleet ls

# A shell — uses the Fleet key when allowed, otherwise asks for a password
fleet connect studio

# A remote command with clean stdout
fleet connect studio -- uname -a

# Share T3 Code, even when it only listens on localhost
fleet expose t3

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
```

Initialization is idempotent. Running it again keeps the existing name, color, ports, and SSH identity unless an option explicitly changes them.

## Agents and automation

Fleet names are stable handles for agents; they do not need to select an interface address or manage SSH flags.

```sh
fleet discover --json
fleet status --json
fleet connect build-box -- cargo test
```

JSON commands write only JSON to stdout. Remote commands write only the remote command’s stdout/stderr, making them safe to compose. `fleet discover --plain` remains available for tab-separated shell pipelines. `NO_COLOR=1` and the global `--no-color` flag disable ANSI styling.

Useful commands:

```text
fleet init [--name NAME] [--color COLOR] [--no-service]
fleet discover|ls [--timeout SECONDS] [--json|--plain]
fleet connect NAME [-- COMMAND...]
fleet pair NAME                    # allow NAME to connect here passwordlessly
fleet expose NAME [LOCAL_URL] [--port PUBLIC_PORT]
fleet unexpose NAME
fleet open [DEVICE/]SERVICE
fleet status [--json]
```

The older `fleet ssh ...` form remains available for compatibility but is hidden from the main help.

## Hosted services

`fleet ls` shows hosted web services directly beneath each device. Fleet proxies loopback-only services onto a Fleet-owned port, so applications do not need to bind to every network interface.

T3 Code has a built-in preset using its documented local development server:

```sh
fleet expose t3                       # http://127.0.0.1:3773
fleet expose docs http://localhost:8080
fleet unexpose docs
```

The proxy supports HTTP, HTTPS, streaming responses, and WebSocket connections because it forwards TCP without modifying application traffic. Exposed services are reachable by other devices on the local network; only expose applications you are comfortable sharing with that network.

## How access works

Fleet advertises `_fleet._tcp.local` and its SSH username, port, version, and color. Each device also serves its dedicated Ed25519 public key through a read-only Fleet identity endpoint. During `fleet init`, you choose which discovered devices' keys are added to this machine's `authorized_keys`. You can allow another device later by running `fleet pair NAME` on the machine receiving the connection.

`fleet connect NAME` never changes access on either machine. It uses the dedicated Fleet key first and falls back to the account's normal SSH authentication when that key has not been allowed. Fleet names and public keys are discovered on the local network, so confirm the device name and address before granting passwordless access.

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
