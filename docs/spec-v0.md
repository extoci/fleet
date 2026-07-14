# Fleet v0 Product and Engineering Specification

**Status:** Implemented and verified for v0  
**Implementation language:** Rust  
**Supported roles:** Captain and member on macOS and Linux

## 1. Purpose

Fleet v0 converts already-running macOS and Linux machines on one local network into a personal AI-coding device fabric. It automates stable naming, captain discovery, captain-to-member SSH trust, persistent themed terminal sessions, selected coding-tool installation, and captain-side agent context.

Fleet does not execute, delegate, schedule, or monitor coding work.

The normative product context and decision record are in [product-vision.md](product-vision.md).

## 2. Normative language

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** describe v0 requirements.

## 3. v0 success criterion

Given two supported machines on the same LAN, each with a user-accessible shell:

1. Fleet can initialize either machine as captain.
2. Fleet can join the other machine without the user supplying an IP address.
3. The captain can run `ssh <member-name>.local` without a password.
4. Interactive SSH opens or reattaches a machine-colored tmux session.
5. Selected missing coding tools are installed on the member.
6. The captain's inventory and Fleet skill contain the member.
7. Leaving removes captain access but preserves machine customization and user data.

## 4. Preconditions and platform contract

### 4.1 General

Before Fleet begins, the machine MUST:

- Be running macOS or Linux.
- Be connected to the same local network as the intended captain for joining.
- Have a normal non-root user account.
- Allow the user to open a shell locally or through an existing remote method.
- Permit privilege escalation when system changes require it.

Fleet MUST NOT install an operating system, configure a router, partition disks, create users, or operate a network KVM.

### 4.2 Shells

Fleet v0 MUST support Bash and Zsh. Other shells MUST fail with a clear unsupported-shell message before destructive changes occur.

### 4.3 Linux compatibility

The implementation MUST isolate platform operations behind explicit adapters. The initial Linux implementation and support claim MUST cover Debian/Ubuntu-family distributions using systemd and apt. Additional distributions qualify as supported only after their package, init, hostname, mDNS, and SSH adapters have end-to-end tests. Unsupported init systems or package managers MUST produce a clear error rather than falling back to unverified commands.

### 4.4 External downloads

Fleet MAY contact official software and operating-system package sources to download Fleet, OpenSSH, tmux, Codex, and Claude Code. Fleet state, discovery, registration, and coordination MUST NOT require a Fleet-hosted service.

## 5. Roles and invariants

### 5.1 Membership

A machine MUST be in exactly one of these states:

- Uninitialized
- Captain
- Member

A machine MUST NOT be captain or member of more than one fleet. `fleet init` and `fleet join` MUST refuse when incompatible Fleet state already exists and direct the user to `fleet leave` when appropriate.

### 5.2 Fleet naming

A fleet MUST NOT have a separate user-visible name. The captain identifies the topology.

### 5.3 Network identity

Fleet MUST NOT use an IP address as durable identity. Each machine MUST have:

- A stable Fleet cryptographic identity
- A mutable human-facing machine name
- A dynamically resolved `<name>.local` address

Persisted IP addresses MAY be used as short-lived diagnostic cache entries but MUST NOT be authoritative and SHOULD be avoided in v0.

Machine names MUST use a conservative cross-platform grammar: 1–63 lowercase ASCII letters, digits, and interior hyphens. A name MUST begin and end with a letter or digit.

### 5.4 Trust topology

The captain MUST have a dedicated SSH key used for Fleet access. Joining MUST authorize that public key only for the user who runs `fleet join`.

Fleet MUST NOT automatically establish:

- Member-to-member SSH trust
- Member-to-captain SSH trust
- Root SSH access
- Shared passwords or private keys

## 6. Filesystem layout

Fleet SHOULD use the following conceptual layout. Platform conventions MAY require small path differences, but the logical separation is normative.

```text
~/.fleet/
├── config.toml              # role and local, human-readable configuration
├── identity/                # private identity material, mode 0700
├── inventory/               # captain-only, human-readable machine records
├── shell/                   # prompt and tmux integration
└── skill/                   # captain-only managed Fleet skill
    ├── SKILL.md
    └── references/
        └── machines.md

~/.agents/skills/fleet -> ~/.fleet/skill
```

Requirements:

- Non-secret state MUST be human-readable and portable.
- Private directories MUST be accessible only to the owning user.
- Private key files MUST use mode `0600` or a stricter platform-equivalent ACL.
- Writes MUST be atomic where partial files could corrupt membership or identity.
- Generated files MUST clearly state that Fleet manages them.
- Re-running a completed operation MUST NOT duplicate shell blocks, keys, services, or skill links.

## 7. Installation

### 7.1 v0 installer

The repository MUST include a POSIX-compatible shell installer, provisionally `fleet.sh`. A dedicated installer domain is out of scope.

The installer MUST:

- Detect supported operating system and CPU architecture.
- Download or select the corresponding prebuilt Fleet binary.
- Verify a published checksum before installing a downloaded binary.
- Install without requiring Rust, Bun, Node.js, or another language runtime.
- Prefer a user-writable binary directory such as `~/.local/bin`.
- Ensure the chosen directory is available on future Bash/Zsh PATHs without duplicating configuration.
- Explain how to invoke Fleet immediately in the current shell.
- Fail without leaving a truncated or unverified executable in place.

The installer MUST NOT collect telemetry or credentials.

### 7.2 Upgrades

Automatic updates are not required for v0. Re-running the installer MAY replace the binary after successful verification.

## 8. `fleet init`

### 8.1 Intent

`fleet init` turns the current machine into a captain.

### 8.2 Required flow

`fleet init` MUST:

1. Verify supported OS, shell, permissions, and absence of incompatible Fleet state.
2. Ask for or confirm the captain's machine name.
3. Ask for a machine color.
4. Validate that `<name>.local` does not conflict with a discovered device before committing the rename.
5. Change the real operating-system hostname when the chosen name differs. On macOS, this includes the system hostname, computer name, and Bonjour local hostname. On Linux, this includes the static hostname plus working mDNS advertisement and normal resolver integration.
6. Create the captain's stable Fleet identity and dedicated SSH key.
7. Install tmux if absent.
8. Configure the supported shell and themed tmux experience idempotently.
9. Install and start the captain background service using the native user-service mechanism.
10. Create the captain inventory and Fleet skill.
11. Verify that the background service is advertising the captain over mDNS.
12. Print a concise completion message explaining that another machine can now run `fleet join`.

`fleet init` MUST NOT offer to install Codex or Claude Code.

### 8.3 Failure behavior

Before changing the hostname or trust state, Fleet SHOULD complete all checks that can fail without side effects. If a later step fails, Fleet MUST report completed and incomplete work precisely and MUST be safe to rerun.

## 9. Captain service

### 9.1 Responsibilities

The captain service MUST:

- Run as the user who initialized Fleet.
- Advertise a DNS-SD/mDNS service on the local network.
- Provide the captain's display name and public identity to joining clients.
- Accept member registration initiated by `fleet join`.
- Persist member records atomically.
- Regenerate the captain's machine inventory and Fleet skill after a membership change.

The captain service MUST NOT:

- Execute coding tasks.
- Monitor agent sessions.
- Relay general traffic.
- Listen on non-local interfaces intentionally exposed to the internet.
- Contact a Fleet-hosted service.

The v0 service lifecycle guarantee applies while the captain user's login session is active. `fleet init` MUST NOT silently enable Linux user lingering or install a system-wide always-on service. Fleet MUST explain this limitation after initialization.

### 9.2 Discovery

The provisional DNS-SD service type is `_fleet._tcp.local`. The final implementation MAY choose another unregistered development name if required, but discovery MUST be DNS-SD/mDNS based and MUST NOT require the user to enter an IP address.

Fleet SHOULD integrate with native mDNS facilities—Bonjour/DNS-SD on macOS and the Avahi daemon API on Linux—rather than running a second competing responder. On supported Linux, Fleet MUST install/enable the required Avahi and normal name-service integration when absent.

If one captain is discovered, `fleet join` MUST show it. If several are discovered, `fleet join` MUST let the user select one. Names are informational; the confirmed public-key fingerprint is the pinned identity.

### 9.3 Registration

A registration MUST include at least:

- Member Fleet identity/public key
- Machine name and `.local` hostname
- SSH username authorized during join
- Machine color
- Operating system and architecture
- Detected installed-tool state
- SSH host-key fingerprint or equivalent data needed for captain-side pinning

The captain MUST treat the network source address as transport metadata, not member identity.

The captain SHOULD validate the completed SSH path before considering the join successful. Host-key verification MUST NOT be disabled globally.

## 10. `fleet join`

### 10.1 Intent

`fleet join` turns the current uninitialized machine into a member of a locally discovered captain.

### 10.2 Required flow

`fleet join` MUST:

1. Verify supported OS, Bash/Zsh availability, permissions, and absence of incompatible Fleet state.
2. Discover captains using mDNS.
3. Show the selected captain's machine name and cryptographic fingerprint.
4. Require a local confirmation before trusting the captain.
5. Ask for or confirm the member's machine name.
6. Ask for a machine color.
7. Validate that `<name>.local` does not conflict before committing the rename.
8. Change the real operating-system hostname when needed. The platform-specific rename and mDNS requirements from `fleet init` also apply here.
9. Install and enable the system SSH server when absent or disabled.
10. Install the captain's dedicated public key in the current user's SSH authorization idempotently.
11. Install tmux when absent.
12. Configure the supported shell, automatic interactive-SSH tmux attachment, prompt, and tmux theme.
13. Detect Codex and Claude Code.
14. Display both tools and clearly mark already-installed tools.
15. Install only missing tools explicitly selected by the user.
16. Offer or launch the official login flow for a newly installed tool when appropriate.
17. Create the member's Fleet identity and local membership record.
18. Register the member with the captain.
19. Allow the captain to verify pinned, passwordless SSH access at `<name>.local`.
20. Print a concise completion message containing the exact SSH command.

Invoking and confirming `fleet join` constitutes member consent. A second interactive approval on the captain MUST NOT be required.

### 10.3 Tool UI

The join UI SHOULD communicate detection and selection without implying that Fleet owns the tools. For example:

```text
Tools to install:
  ✓ Codex        already installed
  ◉ Claude Code  install
```

Fleet MUST NOT:

- Modify tool configuration or defaults.
- Copy tool credentials between machines.
- Store authentication tokens.
- Install or configure T3 Code.

### 10.4 Hostname behavior

The selected Fleet name MUST become the actual system hostname. Fleet MUST configure the platform's native local-host naming mechanism so `<name>.local` resolves on the LAN.

Changing the hostname during an existing SSH session MUST NOT intentionally terminate that session. The completion message MUST tell the user to reconnect using the new name.

## 11. SSH behavior

Fleet MUST use the platform's standard OpenSSH server and client behavior.

When enabling SSH, Fleet MUST NOT:

- Enable root login.
- Enable password authentication when it was previously disabled.
- Replace the user's unrelated `authorized_keys` entries.
- Disable host-key verification.
- Change router or broad firewall policy.

Fleet MUST make its `authorized_keys` entry identifiable so `fleet leave` can remove only the captain's Fleet key.

Fleet MUST preserve unrelated `authorized_keys` content, enforce safe `.ssh` and key-file permissions, and update the file atomically. Idempotency MUST compare the actual public key material rather than relying only on a comment marker.

The captain MUST pin the member's SSH host identity during registration or first verified connection. A changed host key MUST surface as an explicit trust error.

## 12. Shell, prompt, and tmux behavior

### 12.1 Shell configuration

Fleet MUST configure the active Bash or Zsh startup file using an idempotent, clearly labeled Fleet block or source line. It MUST preserve unrelated user configuration.

Fleet MAY own the resulting prompt and tmux appearance. The implementation SHOULD keep Fleet-owned logic under `~/.fleet/shell` and source it from the real shell rc file.

### 12.2 Automatic tmux

For an interactive SSH login when tmux is not already active, Fleet MUST create or attach a persistent default tmux session.

Fleet MUST NOT hijack:

- Non-interactive `ssh host command` execution
- SCP/SFTP or other SSH subsystems
- An existing tmux session
- A local non-SSH shell solely because Fleet is installed

The attachment guard MUST require an interactive SSH session with terminal input/output, MUST skip when `$TMUX` is already set, and MUST provide a documented `NO_TMUX=1` bypass.

Disconnecting SSH MUST leave the tmux session and its processes running. Reconnecting MUST reattach to that session by default.

### 12.3 Theming

The selected machine color MUST be visible in both the shell prompt and tmux status UI. Fleet MUST NOT depend on a specific terminal emulator or rewrite terminal-emulator profiles.

The theme MUST preserve readable contrast in common light and dark terminals and SHOULD degrade safely when advanced color support is unavailable.

## 13. Fleet skill

### 13.1 Location

The skill MUST exist only on the captain in v0. Fleet SHOULD manage its canonical files at `~/.fleet/skill` and expose them through `~/.agents/skills/fleet` using a symlink or equivalent standards-compatible installation.

### 13.2 Ownership

- The product author supplies `SKILL.md` and its stable operating instructions.
- Fleet generates the current machine inventory reference.
- Membership changes MUST update the generated inventory.
- Generated content MUST NOT contain private keys, credentials, tokens, or persisted IP addresses.
- Fleet MUST NOT create Codex-specific, Claude-specific, or T3-specific skill variants.

### 13.3 Inventory content

The generated inventory SHOULD contain only facts Fleet owns, including:

- Captain and member names
- `.local` addresses
- Colors
- Operating systems and architectures
- SSH usernames
- Detected tool installation state

Fleet MUST NOT assign workload roles, recommend machines, or claim that a machine is currently free or busy.

## 14. `fleet status`

`fleet status` MUST provide a concise view of the locally persisted Fleet topology.

On a captain, it MUST identify the captain and list known members. On a member, it MUST identify the member and its captain. Network liveness checks and continuous monitoring are not required for v0 and MUST NOT block local status output.

The exact table layout and any internal health operation are non-normative v0 details.

## 15. `fleet leave`

### 15.1 Member leave

On a member, `fleet leave` MUST:

- Remove local membership state.
- Remove only the captain's Fleet-managed SSH authorization.
- Notify the captain and remove the inventory entry when the captain is reachable.
- Complete locally even when the captain cannot be reached, while warning that the captain may retain a stale record.

It MUST preserve:

- Current hostname and `.local` name
- Shell and prompt configuration
- tmux installation, configuration, and sessions
- Codex and Claude Code installations and credentials
- Repositories, files, and all other user data

### 15.2 Captain leave

Automatic migration or election is out of scope. For safety, v0 SHOULD refuse to dismantle a captain while registered members remain and explain that those members must leave or be removed first. Once empty, leaving MAY stop the service and remove captain role state while preserving hostname and terminal customization.

## 16. Privacy and security requirements

Fleet MUST NOT include:

- Accounts or sign-in to Fleet
- Telemetry or analytics
- A Fleet-hosted API, database, relay, or control plane
- Automatic port forwarding or internet exposure
- Credential synchronization
- Shared private keys

Sensitive values MUST never be printed in normal logs. Public fingerprints MAY be printed for trust confirmation.

Discovery data MUST be treated as untrusted until the user confirms the captain fingerprint. A human-facing name MUST NOT substitute for cryptographic identity.

The v0 confirmation is trust-on-first-use on a trusted LAN. Because the displayed fingerprint arrives through the same unauthenticated discovery channel, Fleet MUST NOT describe it as independently authenticated pairing. After confirmation, Fleet MUST pin the identity and fail explicitly if it changes.

## 17. Error handling and idempotency

Every mutating command MUST:

- Validate as much as possible before mutation.
- Explain when `sudo` is required and why.
- Use explicit timeouts for discovery and network operations.
- Return non-zero on incomplete required work.
- Be safe to rerun after interruption.
- Avoid duplicate rc blocks, SSH keys, service definitions, and inventory records.
- Preserve unrelated existing configuration.
- Print actionable recovery instructions.

At minimum, v0 MUST handle these errors deliberately:

- No captain discovered
- Multiple captains discovered
- Fingerprint rejected
- Hostname collision
- Unsupported OS, shell, init system, or package manager
- Privilege escalation denied
- SSH server installation or enablement failure
- mDNS unavailable
- Captain registration timeout
- Captain-to-member SSH verification failure
- Tool already installed
- Tool download or login failure
- Existing incompatible Fleet role
- Partially completed prior init/join

Tool installation or login failure SHOULD be reportable separately from core Fleet membership. The final result MUST make clear whether the machine successfully joined even when an optional tool did not.

## 18. Testing strategy

### 18.1 Automated tests

The Rust project MUST include:

- Unit tests for state transitions, serialization, name validation, fingerprint presentation, rc-file editing, authorized-key editing, inventory generation, and command planning.
- Integration tests using temporary homes, dry-run command paths, and inspectable platform command plans for idempotency and failure recovery.
- CLI tests for exit codes and user-visible errors.
- Tests proving non-interactive SSH commands are not intercepted by tmux startup logic.

Platform-changing operations SHOULD be represented as inspectable plans before execution so most behavior can be tested without modifying the test host.

### 18.2 Real-machine matrix

The macOS binary, native Bonjour integration, generated LaunchAgent, shell/tmux rendering, and inspectable system-mutation plans MUST be verified on a macOS host without requiring that a developer's daily-use Mac be renamed or have Remote Login enabled. Linux behavior MAY be tested with Multipass using at most two concurrent virtual machines, each limited to:

- 2 CPUs
- 2 GiB memory
- 10 GiB storage

The minimum v0 end-to-end matrix is:

1. Linux captain to Linux member using two Multipass VMs.

Mixed macOS/Linux end-to-end runs are valuable post-v0 confidence checks when a suitable Mac is available, but they MUST NOT require destructive reconfiguration of a developer's only Mac and are not a v0 completion gate.

Tests MUST account for VM networking modes that may prevent multicast discovery. A test-only injected discovery adapter MAY validate protocol behavior, but at least one real LAN mDNS join MUST be demonstrated before v0 is considered complete.

### 18.3 End-to-end acceptance test

On two clean supported machines:

1. Install Fleet from `fleet.sh` without a language runtime.
2. Run `fleet init` on the captain and choose a name/color.
3. Run `fleet join` on the member.
4. Confirm the correct captain fingerprint.
5. Name the member `emerald` and choose an emerald-compatible color.
6. Confirm existing tools are shown accurately.
7. Select at least one missing tool and complete or deliberately skip its official login.
8. From the captain, resolve `emerald.local` without an entered IP.
9. Run `ssh emerald.local` without a password.
10. Confirm automatic attachment to a themed tmux session.
11. Start a long-running process, disconnect, reconnect, and confirm it survived.
12. Confirm the captain inventory and Fleet skill include emerald.
13. Run `fleet leave` on emerald.
14. Confirm captain SSH access is removed.
15. Confirm emerald's hostname, terminal theme, tmux setup, tools, and user files remain.

## 19. v0 deliverables

Implementation is complete only when the repository contains:

- A Rust CLI implementing `fleet init`, `fleet join`, `fleet status`, and `fleet leave`
- A captain background service installable on supported macOS/Linux systems
- mDNS discovery and registration
- Cross-platform hostname, SSH, Bash/Zsh, and tmux configuration
- Codex and Claude Code detection/install flows during join
- Captain-side inventory and Fleet skill generation
- A standalone shell installer
- Automated tests and documented Multipass/manual verification
- User documentation describing installation, initialization, joining, daily use, leaving, privacy, and v0 limitations

## 20. Explicitly deferred

The following MUST NOT be required to complete v0:

- Tailscale
- Remote access outside the LAN
- `fleet sync` or `fleet transfer`
- Skills on members
- Task delegation or scheduling
- T3 Code installation/configuration
- Additional shells
- Windows/WSL
- Multi-user fleets
- Multiple fleets per machine
- Captain backup, recovery, promotion, or election
- Continuous health monitoring
- A hosted installer domain
