# Changelog

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
