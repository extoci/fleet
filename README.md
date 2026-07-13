# Fleet

Fleet makes a group of Macs and Linux machines feel like one SSH-ready fleet. Each machine advertises itself over local-network mDNS, discovers peers without a registry, and gets a dedicated Ed25519 key for machine-to-machine access.

## Install

With npm:

```sh
npm install --global fleet-cli
fleet init
```

Or with the zero-dependency shell installer:

```sh
curl -fsSL https://raw.githubusercontent.com/exotic/fleet/main/fleet.sh | sh
```

`fleet.sh` only detects the platform, downloads the Rust binary, and runs `fleet init`. Set `FLEET_NO_INIT=1` to install without initializing, or `FLEET_GITHUB_REPOSITORY=owner/repo` when publishing from a fork.

## Use

Run this once on every machine:

```sh
fleet init --name studio-mac
```

Initialization enables the system SSH server, creates `~/.config/fleet/config.toml`, generates `~/.ssh/id_ed25519_fleet`, and installs a user-level launchd or systemd discovery service. It does not overwrite existing SSH keys. Enabling SSH may ask for `sudo`.

Then, from either machine:

```sh
fleet discover
fleet ssh pair build-box
fleet ssh connect build-box
```

Discovery uses `_fleet._tcp.local` multicast DNS and therefore works automatically on a multicast-capable LAN. Two Fleet agents exchange their dedicated public keys directly when you run `fleet ssh pair NAME`; no SSH password is required. Pairing is intentionally available to peers on the local network, so only run Fleet's discovery service on a network you trust. If the target is not a discovered Fleet machine, `pair` falls back to the system's `ssh-copy-id`.

### Commands

```text
fleet init [--name NAME] [--no-service]
fleet discover [--timeout SECONDS] [--plain]
fleet serve
fleet service install|uninstall
fleet ssh keygen|public-key|pair|connect
```

## Develop and release

```sh
cargo test
cargo build --release
FLEET_BINARY="$PWD/target/release/fleet" npm install --global "$PWD"
```

Pushing a `v*` tag builds four release archives and publishes `fleet-cli` to npm. Configure the repository's `NPM_TOKEN` secret before tagging. The package version and Git tag must match.
