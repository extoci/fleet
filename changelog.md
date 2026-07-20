# Changelog

## 0.6.6 — 2026-07-20

### Fleet-wide usage reports

- Make `fleet usage` combine structured ccusage totals from every registered
  machine, with `all` as an explicit equivalent and support for selecting one
  or more named machines.
- Keep reachable machines in the report when another machine is offline or
  lacks Bun/Node, and show the failed machine as unavailable with its cause.
- Allow members to request fleet-wide reports through the authenticated captain
  service instead of limiting cross-machine usage queries to the captain.

## 0.6.5 — 2026-07-19

### Captain connectivity

- Configure the host firewall for Fleet's captain control port during setup,
  preventing mDNS advertisements from pointing to an unreachable service.
- Keep the concrete, identity-verified DNS-SD transport for registration and
  later requests instead of discarding it and resolving the advertised
  `.local` hostname again.
- Rediscover existing captains by their pinned identity for resume, leave, and
  health checks, so those paths use the same reliable connection seam as join.

## 0.6.3 — 2026-07-19

### Network registration reliability

- Apply resolved IPv4 and IPv6 endpoint fallback to join and leave requests,
  completing the fix for `.local` address-family failures during registration.

## 0.6.2 — 2026-07-19

### Network discovery reliability

- Use native service-discovery addresses when verifying captain advertisements,
  avoiding unusable `.local` IPv6 resolutions.
- Retry captain identity verification across resolved IPv4 and IPv6 endpoints
  with actionable per-endpoint diagnostics.

## 0.6.1 — 2026-07-19

### Captain service reliability

- Stop the managed captain service before reinstalling it and wait for its
  local port to become available, preventing stale daemons from masking a
  failed service restart.
- Report the expected and observed captain identities with actionable recovery
  guidance when another Fleet daemon owns the local service port.

## 0.6.0 — 2026-07-19

### Remote usage reports

- Added `fleet usage <machine>` to run the latest ccusage report on the local
  machine or a registered member and stream the result back to the caller.
- Prefer Bun for direct execution, including its standard user installation
  path, with automatic fallbacks to Bun, pnpm, or npx when `bunx` is unavailable.

## 0.5.3 — 2026-07-18

### Linux compatibility

- Ship statically linked Linux executables so Fleet does not depend on the
  release runner's glibc version.
- Reject dynamically linked Linux executables during the release workflow
  before they can reach end users.

## 0.5.2 — 2026-07-18

### Fleet membership integrity

- Reject registrations that collide with the captain's name, machine ID, or
  Fleet identity.
- Reject reuse of another member's Fleet identity or SSH host key under a new
  machine ID.
- Compare pinned SSH keys by canonical key material so comment-only changes do
  not look like identity rotation, while real key changes remain blocked.

## 0.5.1 — 2026-07-18

### Hostname collision detection

- Allow `fleet init` and `fleet join` to keep the machine's current hostname
  when its own cached or alternate mDNS address appears non-local.
- Preserve collision detection when choosing a different hostname on both macOS
  and Linux.

## 0.5.0 — 2026-07-18

### Fleet-wide updates

- Added `fleet update-all` and its `fleet updateall` alias to update every
  registered member over the captain's pinned SSH connections before updating
  the captain itself.
- Missing and older Fleet installations are bootstrapped through the public
  installer, and failures are collected while updates continue across the fleet.

### Installation and networking

- The installer now prefers a writable user directory already on `PATH` and
  gives clearer guidance when a new shell is needed.
- Fixed false hostname-conflict detection for scoped IPv6 link-local addresses
  returned by macOS.

## 0.4.0 — 2026-07-18

### Self-update

- Implemented `fleet update` against the latest published GitHub Release.
- Updates select the native macOS or Linux artifact, verify its SHA-256 checksum,
  and atomically replace the installed executable.
- Fleet refuses to downgrade when the published release is older than the
  running semantic version.
- Captains automatically restart their background service after a successful
  update so the daemon and CLI run the same version.

## 0.3.0 — 2026-07-18

### Status experience

- Reworked `fleet status` into a compact, colored table that adapts to narrow terminals.
- Hid internal architecture and color metadata from human-readable status while preserving it in JSON output.
- Added `fleet ls` as an alias for `fleet status`.

### Lifecycle commands

- Added `fleet restart` for restarting the captain background service, including a dry-run mode.
- Added conventional `-v`, `-V`, and `--version` flags.

### Distribution

- Added native release builds for macOS and Linux on ARM64 and x86-64.
- Added checksummed archives, an atomic GitHub Release publish step, and the standalone installer as a release asset.
- Documented the public install, update, rollback, and release procedures.

## 0.2.0 — 2026-07-16

### Membership recovery

- Added `fleet remove <name-or-id>` for stale captain inventory and SSH entries.
- Added `fleet leave --force` for intentionally leaving as captain with remaining members.
- Failed member leave notifications now show the exact captain-side recovery command.

### Request authentication

- Join and leave requests are signed with each member's existing Ed25519 Fleet identity.
- Captains verify join signatures against the submitted identity and leave signatures against the pinned identity.
- Altered or incorrectly signed requests are rejected before inventory changes.

### Diagnostics and logs

- Added `fleet doctor` for readable state, identity, service, inventory, and reachability checks.
- Added `fleet logs`, with `--lines`, for detailed Fleet and setup diagnostics.
- User-facing failures are concise; complete error chains are stored under `~/.fleet/logs/`.
- Discovery distinguishes an empty network from advertisements that could not be verified.

### Join and status UX

- Join presents one final review containing the captain, fingerprint, member hostname, and color.
- Resumed `fleet join --dry-run` no longer requires an online captain.
- Added `fleet status --check` for current reachability and `fleet status --watch` for a refreshed view.
- Optional tool failures are reported immediately even if registration later fails.

### Verification

- Added request-signature ownership and tamper-detection tests.
- Added CLI coverage for force-leave, member removal, and diagnostic logs.
