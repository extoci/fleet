# Fleet Product Vision

## One-sentence definition

Fleet is the local device fabric for AI-assisted software development: it turns a user's macOS and Linux computers into a coherent set of named, recognizable, passwordlessly accessible machines on which tools such as Codex and Claude Code can run.

Fleet is "YAMS for AI coding." It makes the machines feel like parts of one computer without owning the work performed on them.

## The problem

AI coding work is becoming longer-running, more parallel, and more resource-intensive. Keeping that work on a daily laptop has predictable costs:

- The laptop must remain awake and open.
- Agent processes compete with interactive work for CPU, memory, and disk I/O.
- Long-running terminal sessions are easy to lose.
- Spare desktops, mini PCs, and Linux boxes have useful capacity but are tedious to make consistent.
- Each machine accumulates a different hostname, SSH setup, prompt, terminal behavior, and set of coding tools.
- Agents need an accurate explanation of which machines exist and how to reach them.

The individual solutions already exist: SSH, mDNS, tmux, shell configuration, package managers, and coding agents. The missing product is the opinionated setup that makes those pieces become one understandable personal fleet.

## The product promise

Starting with a macOS or Linux machine on which the user can open a shell once, Fleet makes that machine part of their development environment.

After joining a machine as `emerald`, the user can return to the captain and run:

```sh
ssh emerald.local
```

That connection:

- Requires no password.
- Opens or reattaches to a persistent tmux session.
- Is visibly themed with emerald's assigned color.
- Runs on a machine with the coding tools selected during onboarding.
- Is known to the Fleet skill used by agents on the captain.

The desired emotional result is: **this machine just became part of my computer.**

## Inspiration

Fleet is inspired by a workflow in which one laptop acts as the brain for several local machines. The laptop knows their names and characteristics, has passwordless SSH access, and gives its coding agent enough context to operate on the other machines. Each remote terminal is persistent and visually distinct.

Fleet productizes the repeated, fragile setup behind that workflow. It does not productize the delegation layer.

## Vocabulary

### Fleet

The set of machines controlled from one captain. A fleet has no separate user-visible name. The captain is its anchor.

The local network is the discovery boundary, not the membership boundary. Printers, televisions, guest devices, and unrelated servers do not become members merely because they are reachable.

### Captain

The single machine initialized with `fleet init`. It is the source of truth for membership, owns the SSH key authorized by members, advertises itself for local discovery, and holds the Fleet skill and machine inventory.

A captain may run macOS or Linux.

### Member

A macOS or Linux machine onboarded with `fleet join`. It authorizes its captain to SSH into the user account that performed the join.

### Machine identity

A stable cryptographic identity created by Fleet. It is not an IP address and is not the machine's human-facing name.

### Machine name

The real operating-system hostname chosen during initialization or joining, such as `emerald`. It produces the local address `emerald.local`. The name may change; the cryptographic identity remains the durable identity.

### Machine color

A user-selected visual identity applied to the shell prompt and tmux theme so remote terminals remain immediately recognizable.

### Tool

Third-party software that does the actual AI-assisted work. The v0 tool catalog contains Codex and Claude Code. T3 Code is not installed by Fleet because it can be launched with `npx t3@latest`.

## The topology

```text
                         local network

                 +------------------------+
                 | captain: obsidian      |
                 |                        |
                 | Fleet inventory        |
                 | Fleet skill            |
                 | Fleet identity/key     |
                 | discovery service      |
                 +-----------+------------+
                             |
                 passwordless SSH from captain
                    +--------+--------+
                    |                 |
           +--------v--------+ +------v----------+
           | emerald.local   | | ruby.local      |
           | Linux member    | | macOS member    |
           | green terminal  | | red terminal    |
           | Codex           | | Claude Code     |
           +-----------------+ +-----------------+
```

The topology is intentionally asymmetric. The captain can access members. Fleet does not create member-to-member trust, schedule work, or decide where a task runs.

## Core principles

### Local first

Fleet state and Fleet protocol traffic stay on the user's network. Fleet has no hosted control plane, account system, relay, or telemetry. Core operations remain useful without internet connectivity after required software has been installed.

Fleet may download Fleet releases, operating-system packages, and selected tools from their official sources. "Local first" applies to state and coordination, not to ordinary software downloads.

The v0 trust boundary is also local: discovery and fingerprint confirmation assume a trusted LAN. Because mDNS announcements are not authenticated, confirmation is informed trust-on-first-use rather than proof obtained through an independent channel.

### User-directed work

Fleet never chooses a machine or delegates a task. The user says what should happen and where:

> Update my Git configuration on emerald based on this machine, and clone my website repository on ruby.

Codex, Claude Code, T3 Code, or another service interprets and performs that work. Fleet supplies names, connectivity, durable sessions, and agent-readable context.

### Real names instead of aliases

Choosing `emerald` changes the operating system's hostname. Fleet does not maintain a private alias that disagrees with the name shown by the operating system, shell, logs, or other devices.

The address `emerald.local` is resolved dynamically through mDNS. An IP address is an ephemeral routing detail and is never the machine's identity.

### Opinionated terminal experience

Persistent, recognizable terminal sessions are part of the product, not optional polish. Fleet configures Bash or Zsh, automatically launches or reattaches tmux for interactive SSH sessions, and applies the assigned color to the prompt and tmux theme.

Fleet uses the correct native mechanism to produce that experience. The exact prompt implementation is an engineering decision, not part of the product contract.

### Transparent ownership

Fleet may modify the user's real `.bashrc` or `.zshrc`, as ordinary developer tools do. Changes must be idempotent and understandable. Fleet state lives in human-readable, portable files under `~/.fleet`; private key material is stored separately with restrictive permissions.

### Safe departure

`fleet leave` removes fleet membership and the captain's SSH authorization. It does not undo the pleasant machine setup or remove user work. The real hostname, installed tools, shell appearance, tmux setup, repositories, and user data remain.

### No vendor lock-in

Fleet is a standalone Rust program built on standard local protocols and tools. The user can inspect and back up its state. Their machines remain ordinary SSH-accessible macOS and Linux computers even if Fleet is removed.

## The v0 lifecycle

### Install Fleet

Fleet is delivered as a standalone Rust binary through a shell installer. During v0 development, the repository provides the installer as a `.sh` file; a dedicated installer domain can come later.

The target machine does not need Rust, Bun, Node.js, or another application runtime in order to install Fleet itself.

### Initialize the captain

The user runs `fleet init` on one machine. Initialization:

- Establishes that machine as the captain of exactly one fleet.
- Creates its Fleet identity and dedicated SSH key.
- Gives it a real hostname and color.
- Configures its Bash or Zsh and themed tmux experience.
- Installs a small user-level background service for mDNS discovery and join registration.
- Installs and manages the standards-compatible Fleet skill on the captain.
- Does not offer to install Codex or Claude Code; the captain probably already has its preferred tools.

The v0 captain service is available while the captain user's login session is active. Boot-time operation before that user logs in is not part of the v0 promise.

### Join a member

The user installs Fleet on another machine, opens a shell there, and runs `fleet join`. Joining:

- Discovers captains through mDNS without requiring an IP address.
- Shows the discovered captain's hostname and cryptographic fingerprint.
- Requires one confirmation on the member.
- Requires no second approval on the captain; invoking and confirming `fleet join` is the act of consent.
- Asks for a name and color, then changes the real system hostname.
- Installs and enables the SSH server when necessary.
- Authorizes the captain's dedicated key for the current user.
- Installs and configures tmux plus the Bash or Zsh experience.
- Shows Codex and Claude Code as tools, clearly identifies tools already installed, and installs only the selected missing tools.
- May launch a newly installed tool's official interactive login flow, but never stores or synchronizes its credentials.
- Registers the member with the captain, which updates its local inventory and Fleet skill.

### Use the fleet

The user or an agent on the captain accesses a member using ordinary SSH and its `.local` hostname. Fleet does not wrap every remote command and does not need to remain in the execution path.

`fleet status` exposes the locally known topology and machine metadata. Detailed liveness monitoring, task tracking, and workload telemetry are not part of the product.

### Leave the fleet

A member runs `fleet leave` to remove membership and the captain's SSH access. The machine remains configured and useful. It may subsequently join a new captain.

A machine belongs to exactly one fleet at a time, whether it is a captain or a member. Several captains may technically be discoverable on one LAN, but multi-fleet operation is not a v0 optimization target.

## The Fleet skill

The captain has a skill following the shared agent skills standard. Fleet owns the installation and generated machine inventory; the product author owns the actual instructional content.

The intended layout is:

```text
~/.fleet/skill/
├── SKILL.md
└── references/
    └── machines.md

~/.agents/skills/fleet -> ~/.fleet/skill
```

The skill makes names such as `emerald.local` and `ruby.local` legible to compatible agents. It explains how Fleet works and provides current membership information. It does not contain scheduling logic, target recommendations, agent-specific variants, or T3/Codex/Claude configuration.

For v0, the skill exists only on the captain. File transfer and skill replication to members are future concerns.

## Explicit v0 scope

### Included

- Captain and member roles on macOS and Linux
- A single fleet per machine
- Real hostname changes and `.local` addressing
- Local captain discovery and fingerprint confirmation
- Captain-to-member passwordless SSH for the joining user
- SSH server installation and enablement when necessary
- Bash and Zsh support
- Persistent automatic tmux sessions over interactive SSH
- Machine-specific prompt and tmux colors
- Codex and Claude Code detection and optional installation during join
- Official login handoff after a new tool installation
- Captain-side human-readable inventory
- Captain-side Fleet skill generation
- Local status information
- Non-destructive leave behavior
- Standalone Rust binaries and a shell installer

### Excluded

- Delegation, orchestration, scheduling, or task tracking
- Machine recommendations, descriptions, or workload roles
- Tailscale or other remote-network integration
- Fleet-owned relay, cloud API, accounts, or telemetry
- File transfer, synchronization, or repository distribution
- Member-to-member SSH trust
- Agent-specific skills or configuration
- T3 Code installation or configuration
- Operating-system installation, disk partitioning, routers, firewalls, or KVM control
- User creation, root SSH, or weakened SSH policy
- Windows, WSL, Fish, and other shells
- Multiple fleets per machine
- Multi-user permissions and shared-fleet administration
- Automatic captain election, promotion, or recovery
- Continuous monitoring

## Deferred possibilities, not commitments

- Tailscale as an additional transport while preserving Fleet identity
- `fleet sync` or `fleet transfer` for explicit file movement
- Skills on members after synchronization exists
- Additional installable tools
- More shells and operating-system variants
- Backup and restore helpers

These ideas must not distort the v0 architecture unless a small choice would otherwise make them needlessly impossible.

## Product test

Fleet v0 is successful when a user can take two reachable macOS/Linux machines and, without manually editing SSH, mDNS, tmux, or shell configuration:

1. Initialize one machine as captain.
2. Join the other as `emerald`.
3. Return to the captain and run `ssh emerald.local`.
4. Connect without a password.
5. Land in a persistent, visibly emerald tmux session.
6. Find the selected coding tools installed.
7. See emerald represented in the captain's Fleet skill and status.
8. Disconnect, reconnect, and recover the same tmux session.
9. Leave the fleet without losing the hostname, terminal setup, tools, repositories, or user data.

Anything that does not make this path safer, clearer, or more delightful is secondary in v0.
