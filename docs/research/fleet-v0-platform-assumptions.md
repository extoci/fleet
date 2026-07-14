# Fleet v0 platform assumptions

Research date: 2026-07-15

This note validates the platform assumptions behind the proposed Fleet v0. It is implementation research, not the product specification. Sources are standards, vendor documentation, upstream manuals, and upstream project documentation.

## Executive conclusions

1. A real system rename and a usable `name.local` address are separate operations on Linux. Fleet must set the hostname **and** ensure an mDNS responder/resolver is working.
2. DNS-SD discovery is appropriate for finding a captain, but it provides discovery rather than authentication. A fingerprint learned only from the same mDNS announcement does not prove that the advertiser is the intended captain.
3. SSH setup can usually avoid editing `sshd_config`: enable/install the stock server and add one marked Ed25519 captain key to the joining user's `authorized_keys`, preserving all unrelated lines.
4. tmux auto-attach belongs in interactive shell initialization and must be guarded by interactivity, SSH presence, and the absence of an existing tmux session. Otherwise it will break remote commands, `scp`, or nested sessions.
5. A user service is sufficient while the captain user is logged in. “Available after reboot before login” is a different promise: Linux needs user lingering or a system service, and a macOS LaunchAgent begins with the user's login session.
6. “Linux” is too broad for v0 system configuration unless Fleet implements and tests distro/init adapters. Multipass with Ubuntu validates Ubuntu/systemd/apt, not generic Linux.
7. Codex and Claude Code both have first-party native install paths. Fleet can detect the commands before offering installation and hand authentication back to each tool's own login flow.

## Hostnames and `.local`

### macOS

macOS distinguishes a user-facing computer name from its Bonjour local hostname. Apple documents that the local hostname identifies the Mac to Bonjour-compatible services and appears with a `.local` suffix; Apple also warns that a numeric suffix is added when another Mac already uses the same local name ([Apple: change the computer name or local hostname](https://support.apple.com/en-mide/guide/mac-help/mchlp2322/mac)).

The installed macOS `scutil(8)` manual exposes three persistent preferences: `ComputerName`, `LocalHostName`, and `HostName`; `scutil --set` requires superuser access. Therefore a Fleet real rename should set all three consistently and read them back after the operation. `LocalHostName` should be the bare label (`emerald`), not `emerald.local`.

Fleet must still perform a conflict check before mutating the host. It should also verify afterward that the requested name was retained rather than silently accepting Bonjour's conflict-renamed form.

### Linux

On systemd-based Linux, `hostnamectl hostname NAME` updates the pretty, static, and transient hostname by default. Static hostnames are constrained to DNS-like labels and a Linux maximum of 64 characters ([systemd `hostnamectl`](https://www.freedesktop.org/software/systemd/man/latest/hostnamectl.html)). A conservative Fleet name grammar shared by macOS and Linux is therefore:

```text
lowercase ASCII letters, digits, and interior hyphens; 1-63 characters
```

Changing the Linux hostname does not itself guarantee that `NAME.local` is advertised or resolved. Avahi is the Linux implementation of mDNS/DNS-SD compatible with Apple Bonjour ([Avahi upstream](https://github.com/avahi/avahi)). Ordinary programs such as SSH also need libc name resolution wired to mDNS; `nss-mdns` provides that integration and relies on a running Avahi daemon ([`nss-mdns` upstream](https://github.com/avahi/nss-mdns)). Fleet must verify the complete outcome (`gethostname`, responder running, and `NAME.local` resolving through the normal system resolver from another machine), not merely the exit status of `hostnamectl`.

For v0, either:

- explicitly support systemd-based Debian/Ubuntu and install/enable Avahi, OpenSSH, and tmux with apt; or
- build separate, tested package/init adapters before advertising broader Linux support.

An Ubuntu Multipass test cannot substantiate a generic Linux claim.

### mDNS and DNS-SD semantics

RFC 6762 defines `single-label.local` names as link-local. Queries go to multicast UDP port 5353, and the protocol includes probing and conflict handling ([RFC 6762](https://datatracker.ietf.org/doc/html/rfc6762)). This has two important consequences:

- `emerald.local` is a location on the current link, not a durable machine identity.
- mDNS is intentionally link-local; routed VLANs, guest-network client isolation, and many Wi-Fi multicast filters are outside the v0 guarantee.

DNS-SD represents a service with an instance name plus a service type and domain, and resolves it to SRV and TXT records. SRV supplies the target and port; TXT is for a small set of auxiliary key/value attributes ([RFC 6763](https://datatracker.ietf.org/doc/html/rfc6763)). The captain can advertise `_fleet._tcp.local.` with a small, versioned TXT schema such as `txtvers`, protocol version, and public-key fingerprint. Member inventory does not belong in TXT.

Avoid casually embedding a second full mDNS responder in the Fleet process. Avahi explicitly discourages multiple mDNS stacks on a normal desktop and recommends its daemon API for non-C applications ([Avahi API guidance](https://avahi.org/doxygen/html/)). Fleet should put discovery behind a platform abstraction: use the native Bonjour/DNS-SD facility on macOS and the Avahi daemon API on Linux. A self-contained Rust responder such as `mdns-sd` is only a fallback after coexistence and interoperability tests prove it safe; its API can browse, register, resolve hostnames, and report conflicts ([`mdns-sd` crate documentation](https://docs.rs/mdns-sd/latest/mdns_sd/)).

### Discovery is not authentication

mDNS/DNS-SD records are not authenticated. A malicious or merely mistaken LAN peer can advertise the same service type and present its own fingerprint. Showing a fingerprint obtained from that same advertisement and asking “continue?” gives informed consent but not cryptographic proof that the peer is the user's intended captain.

For v0, document the trust model plainly: the user confirms the selected captain on a trusted local network. The captain key must then be pinned in member state. If stronger authentication is later required, the fingerprint must be compared through an independent channel (for example, displayed by `fleet identity` on the captain or encoded in a physical pairing step).

Never render untrusted DNS-SD TXT values directly into a shell command, config file, or agent skill. Validate against a fixed schema and strict length/character limits.

## OpenSSH setup

On macOS, Remote Login is the SSH service. Apple documents both the user-facing switch and `systemsetup -setremotelogin on`; enabling it grants SSH/SFTP access, while the Mac's existing Sharing settings decide which local users may log in ([Apple Remote Login](https://support.apple.com/en-ae/guide/mac-help/mchlp1066/mac), [`systemsetup`](https://support.apple.com/en-lamr/guide/remote-desktop/apd95406b8d/mac)). Fleet should preserve that machine-level access policy. The narrower permission Fleet owns is its passwordless trust: it adds the captain's key only to the account running `fleet join`.

On Ubuntu, the server package is `openssh-server`. Ubuntu recommends validating configuration with `sshd -t` before a restart and supports isolated snippets under `/etc/ssh/sshd_config.d/` ([Ubuntu OpenSSH server guide](https://ubuntu.com/server/docs/how-to/security/openssh-server/)). Fleet should not edit SSH configuration at all when the stock server already accepts public-key authentication.

OpenSSH treats the server host key as the server's identity and supports Ed25519 public keys in `authorized_keys`. It recommends that `~/.ssh` be inaccessible to other users and that `authorized_keys` be writable only by its owner; unsafe ownership or permissions can make sshd reject the file under `StrictModes` ([OpenSSH `sshd(8)`](https://man.openbsd.org/sshd.8)).

The join implementation should:

1. Generate one dedicated Ed25519 captain keypair under `~/.fleet` with the private key mode `0600`.
2. Create the member user's `~/.ssh` as mode `0700` if absent, preserving existing ownership.
3. Lock, rewrite atomically, and set mode `0600` on `authorized_keys`; append a single exact public-key line with a stable Fleet comment marker; preserve all other bytes/lines.
4. Make repeated joins idempotent by matching the public key material, not only the comment.
5. On leave, remove only the exact Fleet-managed public key.
6. Verify from the captain with a non-interactive SSH command before declaring join complete.

Fleet should not apply `restrict` to this key because `restrict` disables PTY allocation, while Fleet explicitly needs interactive shells. It can still add `no-agent-forwarding,no-X11-forwarding` if v0 does not need those features; local and remote TCP forwarding should be a deliberate product decision rather than an accidental default.

Host authenticity is separate from captain user authentication. The captain must pin each member's SSH host key after the join channel establishes it; it must fail closed on later host-key changes. `ssh-keyscan` alone does not authenticate a key when used over the same untrusted network.

## Bash, Zsh, and tmux

Bash reads `~/.bashrc` for interactive non-login shells. It may also read `~/.bashrc` when invoked non-interactively by `sshd`, which makes an explicit interactive guard essential ([Bash startup files](https://www.gnu.org/software/bash/manual/html_node/Bash-Startup-Files)). Zsh reads `~/.zshrc` for interactive shells ([Zsh startup files](https://zsh.sourceforge.io/Intro/intro_3.html)).

The least surprising idempotent integration is a marked source line in the applicable rc file, pointing to a Fleet-owned shell fragment. The fragment may theme the prompt and attach tmux, while the user's rc file stays mostly untouched. Even though `fleet leave` intentionally preserves the experience, repeated `join` runs must not duplicate the source line.

tmux's `new-session -A` attaches to the named session if it exists or creates it otherwise. Detaching leaves programs alive, and a tmux session may have more than one attached client ([tmux getting started](https://github.com/tmux/tmux/wiki/Getting-Started)). A safe shell-level shape is:

```sh
if [ -n "${SSH_CONNECTION:-}" ] \
  && [ -t 0 ] && [ -t 1 ] \
  && [ -z "${TMUX:-}" ] \
  && [ -z "${NO_TMUX:-}" ] \
  && command -v tmux >/dev/null 2>&1; then
  exec tmux new-session -A -s fleet
fi
```

This code must live behind the shell's own interactive check as well (`case $- in *i*)` for Bash and `[[ -o interactive ]]` for Zsh). Test all of these paths:

- `ssh emerald.local` attaches/creates the persistent session.
- disconnect and reconnect resumes it.
- `NO_TMUX=1 ssh emerald.local` yields an ordinary shell.
- `ssh emerald.local -- uname -a` produces only command output and does not start tmux.
- nested shells and shells opened inside tmux do not attach recursively.
- `scp` and `sftp` still work.

tmux reads `~/.tmux.conf` when the server starts, not each time a session is created. Fleet should source a Fleet-owned tmux fragment from a marked line and explicitly reload it when color/theme changes.

## Captain background service

A per-user macOS LaunchAgent belongs in `~/Library/LaunchAgents`. Apple documents that per-user launchd starts when the user logs in and loads jobs from the user's LaunchAgents directory; `Label` and `ProgramArguments` are core plist keys, while `KeepAlive` controls continuous operation ([Apple launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)). Use modern `launchctl bootstrap gui/$UID …` and `bootout` behavior, and keep logs under `~/.fleet/logs`.

On systemd Linux, install a user unit under `~/.config/systemd/user/`, then run `systemctl --user daemon-reload` and `systemctl --user enable --now fleet-captain.service`. A user manager normally follows login sessions. `loginctl enable-linger USER` is what makes the user manager start at boot and survive logout ([systemd `loginctl`](https://www.freedesktop.org/software/systemd/man/252/loginctl.html)).

V0 should promise captain discovery while the captain's user session is active. Enabling linger changes system policy and is unnecessary unless pre-login/after-logout availability becomes a product requirement.

The service should bind its registration endpoint only to LAN-capable interfaces or an explicitly selected wildcard address, use an unprivileged random/stable port, cap request sizes, validate every field, and perform no shell interpolation. mDNS advertises where the service is; it does not make the registration protocol safe.

## Standalone binary installer

The temporary v0 entry point should be a checked-in POSIX `sh` file run locally, not a placeholder public domain. It should:

1. use `set -eu`, create a private temporary directory, and remove it with a trap;
2. map `uname -s` and `uname -m` to an explicit allowlist of release targets;
3. download a versioned archive and its published SHA-256 value over HTTPS;
4. verify the digest before extraction or execution, using an available verifier such as `sha256sum`, `shasum -a 256`, or `openssl dgst -sha256`;
5. install via an atomic rename to a user-writable directory such as `~/.local/bin`;
6. never invoke `sudo` merely to place the Fleet binary; and
7. fail with a useful message when the install directory is not on `PATH` rather than silently editing unrelated shell configuration.

GNU documents `sha256sum` verification via its SHA-2 utilities ([GNU Coreutils](https://www.gnu.org/software/coreutils/manual/html_node/sha2-utilities.html)). A checksum fetched from the same compromised origin as the artifact detects corruption but not compromise of that origin. Signed manifests or GitHub immutable-release/asset attestations can strengthen this later; GitHub documents asset verification for immutable releases ([GitHub release integrity](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity)).

Do not mix installing Fleet with `fleet init`: the shell script should install the binary only. The Rust CLI should own the explicit, previewed system changes.

## Codex and Claude Code

### Codex

Detect Codex with `command -v codex` and confirm with `codex --version`. OpenAI's upstream repository currently documents the first-party native installer for macOS/Linux as:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

It also documents npm and Homebrew alternatives ([OpenAI Codex repository](https://github.com/openai/codex)). Fleet should prefer the native path so joining a machine does not first require Node, npm, or Homebrew.

Authentication remains Codex-owned. `codex login` launches the ChatGPT browser flow, `codex login --device-auth` supports remote/headless situations, and `codex login status` reports current authentication ([OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)). Fleet should launch the official login flow only after a fresh installation and only in the interactive join session; it must never copy `~/.codex/auth.json` or manage API keys.

### Claude Code

Detect Claude Code with `command -v claude` and confirm with `claude --version`. Anthropic's current native macOS/Linux installer is:

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

Anthropic also publishes signed package repositories and a signed manifest containing SHA-256 checksums for platform binaries ([Claude Code installation](https://code.claude.com/docs/en/installation)). Fleet should prefer the native installer rather than introducing a Node dependency.

`claude auth status` exits zero when authenticated and one when not; `claude auth login` starts the official sign-in flow ([Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)). As with Codex, Fleet installs and optionally launches the tool's login, but owns no credentials or tool configuration.

The join UI should always show both tools and distinguish at least:

```text
Codex        already installed
Claude Code install
```

Detection must happen before selection. “Already installed” should never imply “authenticated”; authentication status may be shown separately without blocking join.

## Test implications

Use at most two Multipass VMs, each configured with 2 CPUs, 2 GiB RAM, and 10 GiB storage, for the Ubuntu path. The high-value two-node test is:

1. initialize VM A as captain and verify its systemd user service and `_fleet._tcp.local` advertisement;
2. join VM B with a selected name and color;
3. verify the real hostname, Avahi resolution, SSH server, exact authorized key, passwordless command execution, and captain inventory;
4. verify interactive tmux attach/resume and non-interactive SSH/scp bypass;
5. run `fleet leave` on B and prove only Fleet trust/membership is removed while hostname, shell/tmux setup, and installed tools remain.

Multipass networking may not forward multicast exactly like two physical LAN machines. Multipass supports explicit network/bridged attachment, while its macOS default creates a shared virtual switch ([Multipass networking](https://documentation.ubuntu.com/multipass/latest/how-to-guides/troubleshoot/troubleshoot-networking/)). A failed mDNS test inside Multipass must be diagnosed as either Fleet behavior or hypervisor networking, not papered over with IP addresses. The canonical acceptance test still needs one real macOS-to-Linux or macOS-to-macOS LAN run because Multipass cannot validate `scutil`, Bonjour, LaunchAgents, or macOS Remote Login.

## Decisions to carry into the v0 spec

- Define a strict Fleet machine-name grammar and reserve it as both the real hostname and the `.local` label.
- Treat public keys as identity and `.local` names as current network locations.
- State the v0 trust assumption: explicit confirmation on a trusted LAN, not cryptographically authenticated pairing.
- Narrow the first tested Linux target to Ubuntu/systemd/apt unless additional adapters and CI/test environments are added.
- Promise discovery while the captain account is logged in; do not silently enable Linux lingering.
- Make every system edit idempotent, marked, atomic where practical, and non-destructive to unrelated user configuration.
- Keep tool installation and authentication delegated to the tools' current first-party flows.
