# Fleet

Your machines, one command away.

Fleet turns Macs and Linux boxes on the same network into an SSH-ready group. Devices announce themselves over mDNS, carry a recognizable color, and exchange dedicated SSH keys automatically when you connect. There is no registry and no password bootstrap between Fleet devices.

## Install

```sh
npm install --global @extoci/fleet
fleet init
```

Or use the small shell installer, which only verifies and installs the native Rust binary:

```sh
curl -fsSL https://raw.githubusercontent.com/extoci/fleet/main/fleet.sh | sh
```

The first initialization may ask for `sudo` to enable the system SSH server and boot-time discovery. Fleet then creates a dedicated `~/.ssh/id_ed25519_fleet` key and starts its user-level discovery service. Existing SSH keys and unrelated `authorized_keys` entries are preserved.

## Everyday use

```sh
# Nearby devices
fleet ls

# A shell — pairing happens automatically
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
fleet pair NAME
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
fleet expose t3                       # http://127.0.0.1:4001
fleet expose docs http://localhost:8080
fleet unexpose docs
```

The proxy supports HTTP, HTTPS, streaming responses, and WebSocket connections because it forwards TCP without modifying application traffic. Exposed services are reachable by other devices on the local network; only expose applications you are comfortable sharing with that network.

## How pairing works

Fleet advertises `_fleet._tcp.local` and its SSH username, port, version, and color. On `fleet connect NAME`, the client resolves the first routable address, exchanges dedicated Ed25519 public keys with the peer, and opens SSH with `IdentitiesOnly=yes`. This works with passwordless accounts such as a fresh Multipass `ubuntu` user because it does not depend on `ssh-copy-id` or a pre-existing password.

Pairing grants the requesting local-network peer SSH access. Run Fleet only on a network you trust. A non-Fleet hostname falls back to the system’s `ssh-copy-id` flow when `fleet pair` is used explicitly.

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
