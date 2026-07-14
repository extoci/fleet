# Fleet v0 verification

This checklist records the real-machine evidence required before Fleet v0 can be called complete. Unit tests do not substitute for these checks.

## Automated checks

```sh
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

## Local installer check

```sh
cargo build --release
temporary_home="$(mktemp -d)"
HOME="$temporary_home" SHELL=/bin/zsh \
  FLEET_INSTALL_DIR="$temporary_home/.local/bin" \
  FLEET_BINARY="$PWD/target/release/fleet" \
  ./fleet.sh
"$temporary_home/.local/bin/fleet" --version
rm -rf "$temporary_home"
```

## Multipass limits

Never run more than two Fleet test VMs concurrently. Each VM is limited to 2 CPUs, 2 GiB memory, and 10 GiB storage.

```sh
multipass launch --name fleet-captain --cpus 2 --memory 2G --disk 10G
multipass launch --name fleet-member  --cpus 2 --memory 2G --disk 10G
multipass list
```

Copy the working tree or release binary into each VM. Confirm both VMs share a network on which multicast reaches the other VM; Multipass's default network may isolate mDNS. Do not replace the acceptance test with persisted IP addresses. If necessary, use a bridged Multipass network or perform the canonical discovery check with physical LAN machines.

### Linux captain/member evidence

- [x] `fleet init` gives the captain a real hostname and starts its systemd user service.
- [x] `_fleet._tcp.local` is visible through `avahi-browse`.
- [x] `fleet join` discovers the captain without an IP address.
- [x] Fingerprint confirmation is shown before the key is authorized.
- [x] The member hostname and `.local` resolver path work from the captain.
- [x] The captain's exact marked Ed25519 key is present once in member `authorized_keys`.
- [x] `ssh member.local -- true` succeeds without tmux output.
- [x] `scp` and `sftp` continue to work.
- [x] Interactive SSH attaches to the themed `fleet` tmux session.
- [x] A process survives disconnect/reconnect.
- [x] The captain inventory and `~/.agents/skills/fleet` update.
- [x] `fleet leave` removes only Fleet trust and inventory membership.
- [x] Hostname, prompt, tmux, tools, repositories, and user data remain after leave.

## macOS evidence

- [x] The full Rust suite and strict Clippy compile and run natively on Apple Silicon macOS.
- [x] The native `dns-sd` publisher is visible to Fleet's Bonjour browser and serves a self-consistent cryptographic identity.
- [x] The macOS command plan contains all three required `scutil` names: `ComputerName`, `LocalHostName`, and `HostName`.
- [x] The Remote Login plan uses Apple's `systemsetup -setremotelogin on` without rewriting the existing allowed-user ACL.
- [x] The LaunchAgent plist, service paths, XML escaping, shell integration, tmux attachment guards, and contrasting theme are rendered and tested without host mutation.

Optional post-v0 confidence checks, explicitly not release blockers:

- [ ] Run macOS captain to Linux member on a Mac whose real hostname and Remote Login settings may be changed.
- [ ] Run Linux captain to macOS member on such a Mac where multicast networking permits it.

Record dates, operating-system versions, commands, and relevant output beneath this line when executing the checks.

## Verification record: Ubuntu 24.04, 2026-07-15

Environment:

- Multipass 1.16.3 on Apple Silicon macOS
- `fleet-captain`: Ubuntu 24.04 LTS, arm64, 2 CPUs, 2 GiB memory, 10 GiB disk
- `fleet-member`: Ubuntu 24.04 LTS, arm64, 2 CPUs, 2 GiB memory, 10 GiB disk
- Fleet 0.0.1 release build

Observed evidence:

- `fleet init --name obsidian --color violet --yes` changed the captain's real hostname and made `obsidian.local` resolve from the member.
- The enabled systemd user service remained active and advertised `_fleet._tcp` through Avahi.
- `fleet join --name emerald --color emerald --yes --no-login` discovered the captain without an IP address and displayed its SHA-256 fingerprint.
- The captain registered one pinned `emerald.local` host key and one exact Fleet key appeared in the member's `authorized_keys` with mode `0600`.
- `ssh -G emerald.local` selected user `ubuntu`, Fleet's dedicated identity, Fleet's known-hosts file, and strict host-key checking.
- Plain `ssh emerald.local -- true`, `ssh emerald.local -- hostname`, SCP, and batch SFTP all succeeded without tmux interference.
- An interactive `ssh emerald.local` opened tmux session `fleet`; the status bar and prompt used ANSI color 42 and displayed `emerald`.
- A background `sleep 300` process remained alive after tmux detach and SSH disconnect.
- Captain `fleet status`, `~/.fleet/inventory`, and `~/.agents/skills/fleet/references/machines.md` all contained `emerald.local`.
- A second join selected both missing tools. Fleet installed Codex 0.144.4 and Claude Code 2.1.209 through their official installers, detected both under `~/.local/bin`, and included both in status and skill inventory.
- `fleet leave --yes` removed the captain key, inventory record, generated SSH host block, and pinned known-host entry. Captain SSH access then failed as expected.
- After leave, the member remained named `emerald`; its Bash integration, themed tmux configuration, live tmux session, Codex, Claude Code, a test repository-independent user file, and other user state remained.
- Repeating captain initialization, member joining, and member leaving was idempotent. This caught and verified fixes for missing `avahi-utils`, Avahi's stale pre-rename hostname, mDNS propagation delay, and stale daemon processes after binary replacement.
- The hardened build was rerun after the completion audit. Discovery locally verified that the advertised SHA-256 fingerprint matched the canonical Ed25519 captain key before trust, and the captain regenerated its pinned `known_hosts` file from inventory.
- Fleet's SSH `Include` appeared before pre-existing host rules, and `ssh -G emerald.local` resolved to the Fleet user, dedicated identity, strict host-key checking, and Fleet-managed known-hosts file.
- After the member left, an empty captain successfully ran `fleet leave`. The service, captain-only skill link/files, generated SSH host configuration, and known-hosts file were removed. The real hostname, Fleet identity, shell/tmux theme, and a user preservation file remained.

The Linux-to-Linux acceptance slice is verified. Per the v0 acceptance policy, destructive mutation of the developer's only Mac and the mixed-OS slices are optional confidence work, not completion requirements.

## Verification record: macOS Bonjour, 2026-07-15

- The ignored real-network integration test `cargo test --test macos_bonjour -- --ignored --nocapture` started the Rust captain daemon on macOS, published it through the native `dns-sd` utility, found it again through Fleet's native Bonjour browser/parser, fetched and matched its HTTP identity, and terminated the daemon and publisher cleanly.
- A macOS `fleet init --dry-run` selected the Zsh/macOS path, and unit tests inspected the exact non-mutating `scutil`, `systemsetup`, LaunchAgent, shell, and tmux plans.
- The full test suite and strict Clippy pass compile and run natively on Apple Silicon macOS.
- The development Mac was intentionally not renamed and Remote Login was not changed.
