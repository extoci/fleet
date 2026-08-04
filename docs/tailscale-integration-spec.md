# Fleet + Tailscale Integration Specification

**Status:** Proposed after first independent review  
**Audience:** Fleet maintainers and security reviewers  
**Last updated:** 2026-08-01

## 1. Product contract

When Fleet can see that a captain and member already share usable Tailscale connectivity, this command must work unchanged at home and away:

```sh
ssh emerald.local
```

The normal experience has no Fleet-specific Tailscale setup:

1. On a shared LAN, Fleet normally uses the member's LAN/mDNS address.
2. Away from that LAN, Fleet uses the member's live Tailscale address.
3. The user, agent, editor, Git, `scp`, and `sftp` continue using `emerald.local`.
4. Fleet's existing dedicated SSH key and pinned member host key remain authoritative.
5. If Tailscale is absent, Fleet behaves exactly as it does today.

The default is:

> If both machines have a qualified, locally queryable Tailscale installation and Tailnet policy permits TCP/22 to the member's ordinary `sshd`, Fleet quietly uses it. Tailscale SSH need not be enabled.

Fleet does not install Tailscale, initiate login, accept auth keys, change Tailnet policy, rename nodes, apply tags, enable Tailscale SSH, or configure Tailscale Serve. Those actions require wider user or Tailnet-administrator authority.

## 2. Scope

### Included

- Automatic read-only detection of an already-running Tailscale client.
- Correlation of Fleet members with peers visible to the captain's local Tailscale client.
- Transparent LAN-first/Tailnet-fallback routing for `<name>.local` in OpenSSH.
- Reuse of Fleet's existing `.local` SSH host-key pin across both routes.
- Gradual existing-Fleet migration during normal member update/re-registration.
- Route-aware `fleet status --check` and `fleet doctor`.
- A per-invocation recovery escape hatch.
- macOS and supported Debian/Ubuntu Linux qualification.

### Excluded

- Installing or authenticating Tailscale.
- Tailnet API credentials, auth keys, OAuth clients, tags, grants, ACL mutation, DNS mutation, or device approval.
- Tailscale SSH and Tailscale Serve configuration.
- Fleet traffic on port `42170` over the Tailnet.
- Brand-new Fleet joining across different physical networks.
- A Fleet relay, VPN, DNS server, SSH server, or hosted control plane.
- Guaranteed retry after an SSH protocol/authentication failure on a TCP route that already connected.

Remote joining is a separate future product with its own invitation and trust ceremony. It is not necessary for existing Fleet members to become remotely reachable.

## 3. Why a local route selector is necessary

Fleet's name is `emerald.local`. Tailscale exposes a separate MagicDNS name such as `emerald.example.ts.net` and a Tailscale IP. OpenSSH accepts one resolved `HostName`; it does not natively try mDNS and then a different DNS namespace.

The alternatives do not meet the contract:

- Always rewriting `emerald.local` to MagicDNS makes local SSH fail whenever Tailscale is unavailable.
- Editing `/etc/hosts` or system DNS corrupts `.local` semantics for unrelated applications.
- Requiring `fleet ssh emerald` or `ssh fleet-emerald` changes the user interface and breaks generic tools.
- `Match exec` hostname rewriting has fragile first-value/config-order semantics and poor diagnostics.

Fleet therefore adds a narrow local OpenSSH `ProxyCommand`. It selects and opens a TCP connection, then transports opaque bytes. OpenSSH still performs end-to-end SSH encryption, server host-key verification, and user authentication directly with the member's `sshd`.

This is a local transport adapter, not a network relay: no Fleet server sees the traffic, and the helper does not terminate or interpret SSH.

## 4. Architecture

```text
┌──────────────────────── captain ────────────────────────┐
│                                                        │
│ ssh emerald.local                                      │
│        │                                               │
│        v                                               │
│ generated ~/.fleet/ssh_config                          │
│        │ ProxyCommand                                  │
│        v                                               │
│ fleet transport connect --member <UUID>                │
│        │                                               │
│        ├─ native OS lookup/dial: emerald.local          │
│        │                                               │
│        └─ local tailscaled peer lookup -> 100.x / fd7a │
│                                                        │
│ outer OpenSSH verifies the existing emerald.local pin  │
└───────────────────────────┬────────────────────────────┘
                            │ selected TCP route, SSH E2E
┌───────────────────────────v────────────────────────────┐
│ member sshd :22                                       │
│ existing authorized Fleet captain key                 │
│ existing pinned Ed25519 host key                      │
└────────────────────────────────────────────────────────┘
```

Three layers remain distinct:

| Layer | Authority | Purpose |
|---|---|---|
| Tailnet | Tailscale node identity and grants/ACLs | Whether packets may flow |
| Fleet | Fleet UUID and Ed25519 identity | Which machines are members and which peer mapping they report |
| SSH | Fleet captain key and existing `<name>.local` host-key pin | Login and server authentication |

A route is never membership identity. A Tailscale peer match can select a socket; it cannot replace or rotate the member's SSH host-key pin.

## 5. Seamless discovery and activation

### 5.1 No enable step in the happy path

Fleet performs bounded Tailscale detection during:

- `fleet init` and `fleet join`;
- update/resume flows;
- captain SSH configuration regeneration;
- `fleet update-all` for existing members.

If Tailscale is absent and the user has never had a remote-ready route, Fleet says nothing in normal output. If it is present but logged out, that is informational unless previously working remote access regressed.

Read-only detection of an already-connected client requires no consent prompt. Explicit consent is reserved for mutations, which this feature does not perform.

### 5.2 Member correlation

The captain's local Tailscale client is the live source of Tailnet peer addresses. Fleet does not distribute or persist peer IP observations.

The captain learns the member's self-reported Tailscale identity only through an already authenticated, strict-pinned SSH connection:

```sh
ssh emerald.local fleet network-hint --json
```

`network-hint` is a hidden, read-only command in the member binary. It returns a bounded, versioned response:

```json
{"version":1,"machineId":"<member-uuid>","tailscale":{"dnsName":"emerald.example.ts.net"}}
```

The output needs no new Fleet wire signature: it is collected only after OpenSSH authenticates the pinned member host and the captain's authorized key. It is routing metadata, not permission to change any Fleet or SSH identity.

The captain pulls it:

- immediately after a successful join, after the member has been saved and its host key pinned;
- after each member update in `fleet update-all`;
- after an explicit `fleet update-all` or a member re-registration;
- on a later lifecycle operation after a previous pull failed.

An old member without the command remains LAN-only. Pull failures are bounded and retried only at those lifecycle events, never in a tight background loop.

Mapping rule:

1. Normalize the member-returned FQDN: ASCII lowercase, remove exactly one trailing dot, enforce DNS label/total-length rules, and reject control/NUL/non-ASCII input in v1.
2. Ask the captain's local Tailscale client to resolve that exact full FQDN.
3. Require at least one valid Tailscale-range address and no ambiguous/conflicting result.
4. Store only the normalized full FQDN as the peer mapping.
5. Re-resolve and range-validate it before every Tailnet dial.

Fleet MUST NOT automatically map by Fleet machine name, Tailnet short name, or uniqueness among human-readable names. Those may be displayed as explicit repair candidates only.

Because `tailscale status --json` is explicitly schema-unstable, v1 parses only the member's `Self.DNSName` behind an isolated, version-qualified adapter. Captain-side peer resolution uses the documented `tailscale ip <full-fqdn>` command. Unknown/missing fields degrade to LAN-only.

### 5.3 Live address resolution

At connection time the selector asks the captain's local Tailscale client for the mapped peer's current addresses. It prefers direct Tailscale IPs over relying on application DNS:

- IPv4 must be inside `100.64.0.0/10`.
- IPv6 must be inside Tailscale's documented `fd7a:115c:a1e0::/48` range.
- MagicDNS FQDN is retained for display, mapping, and diagnostics, not required for transport.

This works when MagicDNS or `--accept-dns` is disabled and avoids persisting stale addresses. Fleet uses the supported `tailscale ip <confirmed-full-fqdn>` path on qualified versions; it must never accept arbitrary public/private addresses as Tailnet candidates.

## 6. OpenSSH configuration

For member `emerald`, generate:

```sshconfig
Host emerald.local
  User dev
  Port 22
  IdentityFile "/Users/me/.fleet/identity/id_ed25519"
  IdentitiesOnly yes
  UserKnownHostsFile "/Users/me/.fleet/known_hosts"
  StrictHostKeyChecking yes
  UpdateHostKeys no
  ConnectTimeout 8
  ProxyCommand '/absolute/path/to/fleet' transport connect --member <full-uuid> --via auto
```

Known hosts remains exactly as Fleet manages it today:

```text
emerald.local ssh-ed25519 <pinned-member-host-key>
```

Normative requirements:

- `emerald.local` is the only generated user-facing name.
- `Port 22` is explicit so a later user `Host * Port ...` cannot change helper behavior.
- The internal command accepts only a validated member UUID and always connects to that member's pinned port 22.
- It never accepts an arbitrary hostname/address from SSH arguments.
- ProxyCommand changes the socket, not the host identity OpenSSH checks. The original command-line host remains `emerald.local`, so its existing pin authenticates LAN and Tailnet routes.
- `UpdateHostKeys no` prevents a remote server from mutating Fleet's generator-owned pin set.
- Command-line SSH overrides and earlier user config still follow normal OpenSSH precedence; Fleet guarantees behavior for clients honoring the normal generated user config.
- Embedded SSH libraries that ignore `ProxyCommand` are outside baseline compatibility until explicitly qualified.

### 6.1 Helper path and shell safety

OpenSSH executes `ProxyCommand` through the user's shell. Fleet writes the absolute path of the currently running Fleet executable and shell-quotes it, so installation paths containing spaces or shell metacharacters remain safe. The generated command contains only that local executable path, fixed literal tokens, and a canonical UUID; no Tailnet name, machine name, address, or network-provided value is interpolated. Fleet regenerates this stanza whenever it changes the member inventory and after a Fleet update.

The helper itself accepts only a canonical member UUID and the fixed route enum (`auto`, `lan`, or `tailscale`). It loads the UUID mapping from the captain's local inventory and never accepts an arbitrary hostname or address from SSH arguments.

### 6.2 Safe regeneration

No host-key or state-schema migration is required. Fleet adds/removes the selector in the existing generated SSH block and keeps the existing known-host format.

The current regeneration uses Fleet's existing mode-safe atomic replacement
for the generated files. A missing or corrupt Fleet executable causes the
selector to fail closed.

Those ownership/`ssh -G`/rollback checks are qualification requirements for a
future hardened installer; the current slice keeps the existing Fleet atomic
file writes and validates the helper path before rendering it.

## 7. Route-selection contract

### 7.1 Deterministic algorithm

For `ssh emerald.local`:

1. Load the member strictly by UUID from protected Fleet state.
2. Start the qualified platform `.local` resolution/dial at `t=0`.
3. Accept a resolved LAN address only when OS route/interface evidence says it is directly connected/on-link with no gateway on an eligible UP, non-loopback, non-Tailscale interface. Reject loopback, unspecified, multicast, Tailscale ranges, and routed candidates. Preserve IPv6 scope/interface IDs.
4. If LAN TCP has not connected at `t=150 ms`, resolve the mapped peer through the local Tailscale adapter and begin Tailnet IP dials.
5. Once Tailnet attempts begin, the first TCP connection to succeed wins. LAN has a head start, not an absolute preference.
6. Bound all resolver, dial, and adapter work by the helper deadline; close
   the selected socket's losers when the helper exits.
7. Copy stdin to the socket and the socket to stdout without interpreting data.
8. On stdin EOF, half-close the TCP write side and continue copying server output until remote EOF.
9. Send diagnostics only to stderr; stdout is exclusively the SSH byte stream.
10. Respect an internal deadline shorter than the generated OpenSSH `ConnectTimeout`.

The current slice bounds the OS `.local` lookup in a short-lived worker and
keeps each dial deadline bounded. Platform qualification should replace that
worker with a killable native DNS-SD/Avahi helper or asynchronous API before
claiming resolver cancellation on every supported platform.

IPv4/IPv6 attempts use a bounded Happy-Eyeballs-style stagger. All subprocesses, DNS work, sockets, output, and stderr are bounded. Signals close outstanding resources promptly.

The 150 ms head start is an initial internal constant, not a user-facing tuning knob. Real-network qualification may change it.

### 7.2 Honest fallback boundary

The helper selects on TCP connectivity. It cannot see whether the subsequent SSH banner, key exchange, host-key check, or authentication will succeed without becoming an SSH implementation.

If a stale/spoofed LAN endpoint accepts TCP first but then fails SSH, outer OpenSSH fails closed. That invocation cannot restart its SSH state over Tailscale. This applies to:

- banner stalls;
- pre-auth disconnects;
- key-exchange failure;
- host-key mismatch;
- authentication failure.

Fleet MUST NOT weaken host-key checking or claim “first authenticated route wins.” Normal conditions remain seamless; adversarial or stale-route failures are explicit and recoverable.

### 7.3 Recovery escape hatch

The normal command remains `ssh emerald.local`. For diagnosis or a poisoned/broken preferred route:

```sh
fleet connect emerald --via tailscale
fleet connect emerald --via lan
```

These commands invoke OpenSSH with a private generated `-F` configuration that forces the Fleet identity, known-hosts file, `emerald.local` pin, port 22, strict checking, `UpdateHostKeys no`, and the helper's forced mode. They set `ControlMaster=no` and disable control-socket reuse so an existing master cannot defeat `--via`. They do not introduce a second normal hostname or ask users to delete known-host entries. `--via` is a per-invocation recovery tool, not persistent configuration.

### 7.4 OpenSSH multiplexing

`ControlMaster` may reuse an existing connection without invoking the selector. Across a network move, an alive master continues on its existing route; after it dies, OpenSSH normally creates a connection and runs selection again. Fleet must test common `ControlMaster auto` settings and document that route selection occurs per new TCP master, not per logical SSH command.

## 8. State model

This feature does not add distributed endpoint inventories.

Captain-local network state is a separate, versioned, unknown-field-tolerant file and needs only:

```toml
version = 1

[members]
"<fleet-member-uuid>" = "emerald.example.ts.net"
```

Do not persist peer IPs. Resolve and revalidate the FQDN through local Tailscale before every use. The mapping cannot mutate member name, SSH user, Fleet identity, SSH host key, or SSH port.

There is no persistent Fleet-wide Tailscale preference. A missing mapping is
LAN-only, while `fleet connect --via lan|tailscale` provides an explicit
per-invocation recovery choice.

Fleet keeps the mapping file under its existing private state root with a
`0600` atomic replacement. Owner/type/symlink rejection is part of the
hardened installer qualification pass.

## 9. Protocol and join safety

### 9.1 Authenticated correlation pull

Keep discovery and Fleet HTTP protocol 1 unchanged. Correlation is pulled by running the hidden `fleet network-hint --json` command over the existing pinned SSH channel. There is no new join field, HTTP endpoint, signed observation, replay state, timestamp, tombstone, or Tailnet control port.

A new captain treats an old member without the command as LAN-only. `fleet update-all` updates members first and pulls the hint after each successful update; the captain updates last. Removal/leave deletes the captain-local mapping along with member inventory.

### 9.2 Current join must remain technically LAN-only

Today's `/v1/join` accepts a key self-signed by the new member. That proves possession but not authorization to join. A documentation statement that joining is LAN-only is insufficient once the service listens on all interfaces.

Before shipping Tailnet routing, harden ordinary join admission with a supported-platform topology gate. Inspect the actual accepted socket peer; never trust forwarding headers. Normalize IPv4-mapped IPv6, reject loopback except explicit self-tests, unspecified/multicast, Tailscale ranges/interfaces, tunnel/utun interfaces, and sources whose OS route uses a gateway. Accept only a source whose route scope is link/direct on an eligible UP physical/LAN interface, preserving IPv6 scope IDs. Perform the cheap admission check before parsing the request body.

Implement this through explicit macOS and Linux interface/route adapters and test VPNs, Docker/VM bridges, subnet routes, IPv4-mapped IPv6, and link-local IPv6. Binding to eligible LAN addresses is preferable where lifecycle/address changes can be handled safely.

This is exposure reduction, not cryptographic LAN authorization: a same-LAN attacker remains inside v0's documented trusted-LAN TOFU boundary.

Tailnet policy is defense in depth, not the enrollment gate. Port `42170` is not required or recommended over Tailscale in this release.

### 9.3 Remote join is separate

Future remote join requires at least a short-lived, single-use, >=128-bit random invitation secret, hashed at rest, bounded attempts, atomic consumption, explicit expiry, secure delivery, and captain-visible joining-key confirmation. It also needs replay-resistant existing operations and rate/concurrency hardening of the captain service.

Those requirements are recorded here only to prevent accidental exposure. They are not part of this feature's implementation plan.

## 10. Status, onboarding, and recovery UX

### 10.1 Join output

Keep join's existing outcome promise truthful and compact:

```text
Joined. From the captain, run `ssh emerald.local`.
```

The captain may pull the mapping after registration, but join must not claim remote readiness until a strict-pinned remote SSH check has actually succeeded. Readiness appears in later checked status. Do not front-load implementation/security disclaimers.

### 10.2 Status

Plain `fleet status` remains nonblocking and shows only persisted facts:

```text
NAME       ROLE     REMOTE SETUP
obsidian   captain  -
emerald    member   mapped
ruby       member   mapped
opal       member   pending
jade       member   unavailable
```

The design vocabulary is `mapped` (a peer FQDN is stored), `pending` (no
usable hint yet), and `unavailable` (the local adapter cannot use a stored
mapping). The current CLI keeps plain status intentionally small; `status
--check` reports only TCP `reachable`/`unreachable`, while richer mapping
states belong in doctor and the qualification pass.

`fleet status --check` performs a bounded live selector probe and reports `reachable` or `unreachable`. This is a TCP reachability signal, not proof that SSH authentication succeeded and not a claim about which route a later connection will win. Detailed route timing and strict SSH readiness remain doctor/qualification work.

### 10.3 Doctor

`fleet doctor` checks:

1. Fleet state, ownership, identities, generated config, and pins.
2. Native LAN resolution and bounded TCP/SSH probe.
3. Supported local Tailscale CLI/daemon/authentication state.
4. Member-to-visible-peer correlation and ambiguity.
5. Live Tailnet IP validity.
6. Bounded `tailscale ping` for network-layer evidence only.
7. TCP 22.
8. A non-interactive, strict-pinned SSH no-op probe when safe.

It must not claim to distinguish Tailnet policy from host firewall, stopped `sshd`, or packet loss unless authoritative evidence exists. Preferred phrasing:

```text
Tailscale can see emerald, but TCP 22 is not reachable.
This can be caused by Tailnet policy, the host firewall, or sshd.
```

Only after observing this failure should doctor show contextual policy guidance. The normal path needs only TCP 22. Tags are not recommended for user-owned laptops; applying a tag replaces user identity. Grants are additive, and Fleet cannot always synthesize a captain-device-only selector without administrator-created identity structure.

### 10.4 Commands

The baseline command surface is intentionally small:

```text
fleet status --check
fleet doctor
fleet connect <member> --via lan|tailscale
```

There is no required enable, refresh, publish, policy, or separate status command in the happy path. The forced `fleet connect` command is only a recovery/diagnostic escape hatch; ordinary use remains `ssh <name>.local`.

## 11. Tailscale adapter contract

The adapter runs fixed executable paths/arguments without a child shell and applies hard timeouts/output caps. It decodes only required fields and never logs raw peer inventories.

Platform qualification must define:

- supported Tailscale distributions and minimum version;
- fixed executable candidates;
- macOS standalone/App Store behavior and any required documented environment such as `TAILSCALE_BE_CLI=1`;
- Linux daemon/operator permission behavior;
- status/IP/ping command availability and schema fixtures;
- behavior when Tailscale is absent, logged out, stopped, upgrading, or returns partial JSON.

Tailscale connection paths may be direct, DERP-relayed, or peer-relayed. All are healthy. Directness is diagnostic only; Fleet does not wait for a direct path or treat relay as a security failure.

## 12. Security requirements

### Endpoint containment

- Tailnet destinations come only from the captain's local Tailscale client for the confirmed mapped peer.
- Validate all Tailnet IP ranges.
- A member hint alone is never dialed; its exact FQDN must resolve through the captain's local Tailscale client to valid Tailnet addresses.
- LAN destinations come only from qualified `.local` resolution plus on-link route/interface validation.
- Outer OpenSSH always verifies the existing `<name>.local` pin with strict checking.

### Host-key lifecycle

Endpoint metadata never rotates a host key. A reinstall/rekey needs an explicit ceremony with local or out-of-band fingerprint confirmation, or proof authorized by the prior pinned identity with clear compromise caveats. Fleet never recommends deleting known hosts or accepting a changed key automatically.

V1 continues pinning the existing Ed25519 host key. Copying both Fleet identity and SSH host keys creates indistinguishable clones; Fleet should detect simultaneous duplicate observations when possible and require identity reset/rejoin.

### Local state and binary integrity

- `~/.fleet` and managed binary/config parents: `0700`.
- Sensitive files: `0600`.
- Validate owner, type, mode, and symlink status before use/replacement in the
  hardened installer qualification pass.
- Keep inventory/mapping counts and string/output sizes bounded.
- Preserve the prior generated SSH file when regeneration/validation fails in
  the hardened installer qualification pass.
- The local transport executable path is absolute and shell-quoted in generated config; it is never taken from network metadata.
- Never log Fleet/Tailscale private material, application credentials, full peer inventories, or raw peer DNS/IP detail beyond the selected member's diagnostic output.

### Fail closed

An unmapped/ambiguous peer is local-only. A wrong SSH host key fails. A broken proxy fails. Tailscale unavailability falls back to LAN when LAN succeeds. Fleet never silently picks an unconfirmed peer to make the experience look smooth.

## 13. Failure behavior

| Condition | Normal effect | Recovery |
|---|---|---|
| Tailscale absent | v0 LAN behavior, no noise | none required |
| Tailscale logged out/stopped | LAN still works; checked remote route unavailable | restore Tailscale if remote access desired |
| Member not updated/offline | local behavior; mapping pending | automatic next contact or `update-all` |
| Exact authenticated FQDN resolves locally | Tailnet candidate becomes available | none |
| FQDN missing/conflicting | no guessed Tailnet route | doctor and authenticated re-pull |
| MagicDNS disabled | no transport impact when live IP is available | none |
| TCP 22 blocked | LAN may work; remote marked blocked | doctor shows evidence and focused guidance |
| DERP/peer relay | remote works, possibly slower | none required |
| LAN TCP winner fails SSH | command fails closed; no same-invocation retry | `fleet connect emerald --via tailscale` |
| Tailscale peer recreated | mapping revalidation fails or host key refuses | verify and explicitly remap/rejoin |
| SSH host key changes | all routes refused | explicit rekey ceremony |
| Embedded client ignores ProxyCommand | direct `.local` behavior only/unsupported remote | use system OpenSSH integration |
| ControlMaster survives move | existing master keeps prior connection | normal reconnect after master dies |

## 14. Documentation changes required

Existing documentation currently says Fleet does not do Tailscale, requires one trusted LAN, and has no account/control plane/relay. Update these statements carefully:

- Fleet has no **Fleet-hosted** account, control plane, relay, or telemetry.
- When Tailscale is already present, Fleet can use the user's Tailnet for private remote reachability.
- Tailscale uses its own account/coordination service and may use DERP or peer relays.
- Initial ordinary joining remains restricted to a directly connected trusted LAN.
- Ongoing membership is not the same as current physical-network location.
- Ordinary `ssh <name>.local` remains the product interface.

Move Tailscale from the product vision's excluded list to “optional supported network substrate,” without expanding Fleet into orchestration or application lifecycle.

## 15. Implementation plan

### Phase 0: prerequisite hardening

1. Enforce directly-connected-LAN admission for current join.
2. Add SSH/config/helper ownership, mode, symlink, and atomic-regeneration checks.
3. Generate explicit `Port 22` and `UpdateHostKeys no` without changing current known-host pins.
4. Add the hidden bounded `fleet network-hint --json` command.

Exit: all v0 behavior and tests pass without Tailscale; no state or pin migration is required.

### Phase 1: automatic peer mapping

1. Build isolated macOS/Linux adapters for member `Self.DNSName` and captain `tailscale ip <full-fqdn>`, with minimum versions and fixtures.
2. Pull hints over existing pinned SSH after join/update and explicit lifecycle retries.
3. Persist only exact authenticated FQDN mappings and revalidate live IPs on use.
4. Add automatic retry on update/resume/next contact; old members remain local-only.

Exit: qualified existing fleets acquire mappings without a Tailscale-specific enable command; status does not yet alter normal SSH.

### Phase 2: forced route proving slice

1. Add the restricted, shell-quoted local transport helper to generated OpenSSH configuration.
2. Implement forced Tailnet and LAN modes with live validated addresses.
3. Add `fleet connect <member> --via ...` using private SSH config and no multiplex reuse.
4. Integrate live evidence into `status --check` and doctor without mutating mappings during status rendering.

Exit: forced Tailnet SSH proves adapters, mapping, pins, policy, and recovery with only TCP 22 remotely required.

### Phase 3: transparent default and qualification

1. Add the LAN-head-start/Tailnet-first-success automatic mode and generate it into `<name>.local`.
2. Run the real macOS/Linux matrix across same/different LANs, direct/DERP/peer-relay, IPv4/IPv6, MagicDNS off, policy block, slow/captive resolution, suspend/resume, Tailscale upgrade/restart, and network movement.
3. Qualify `ssh`, `scp`, `sftp`, Git-over-SSH, `ControlMaster`, and named editor/agent system-OpenSSH consumers.
4. Exercise member-first `fleet update-all`; old members remain local-only and complete automatically.
5. Update README/product vision/trust documentation and make auto-use the default only for qualified locally queryable Tailscale installations.

Exit: no manual coordination is required and regression/partial completion is obvious.

## 16. Verification matrix

### Unit

- Tailscale command absence, timeout, nonzero exit, partial/unknown/oversized JSON, version variants, IP-range validation, name normalization, and ambiguity.
- Route timing with a fake clock/dialer: immediate LAN, delayed LAN, Tailnet win, all fail, IPv4/IPv6 stagger, cancellation, global timeout.
- Transparent byte copy, stderr separation, stdin EOF half-close, remote EOF, signals, and child cleanup.
- Hostile helper paths/config values, UUID validation, port pinning, config precedence, and `ssh -G` assertions.
- Transactional generation interruption and old-binary refusal.
- Join-source on-link enforcement including Tailscale ranges and routed/nonlocal sources.

### Integration

- No Tailscale: unchanged init/join/status/SSH/leave/update.
- Both routes healthy: LAN normally wins within head start.
- LAN unavailable: identical `ssh emerald.local` uses Tailnet.
- Tailscale unavailable: LAN succeeds.
- Wrong LAN host key: outer SSH refuses; forced Tailnet recovery succeeds.
- MagicDNS disabled: Tailnet IP succeeds.
- Peer renamed/recreated/ambiguous: no unsafe automatic mapping.
- TCP 22 allowed with `42170` denied: all remote use works.
- Uninstall changes no unrelated Tailscale state.
- Offline member during migration completes on next contact.

### Real platforms and clients

| Captain | Member | Scenario |
|---|---|---|
| macOS | Ubuntu | same LAN, direct local selection |
| macOS | Ubuntu | different LANs, direct Tailnet |
| Ubuntu | macOS | different LANs, DERP/peer relay |
| Ubuntu | Ubuntu | IPv6 and MagicDNS disabled |
| macOS | Ubuntu | TCP 22 policy/firewall denial |
| macOS | Ubuntu | network move with ControlMaster |

Test generic system-OpenSSH clients explicitly. Do not claim embedded-library compatibility without qualification.

## 17. Acceptance criteria

- [ ] On a newly joined Fleet (or after the next normal `fleet update-all`), a
  user with mutually reachable Tailscale performs no Fleet-specific Tailscale
  setup; older members remain safely LAN-only until that lifecycle contact.
- [ ] `ssh emerald.local` uses LAN at home and Tailscale away.
- [ ] `scp`, `sftp`, Git, and qualified system-OpenSSH tools use the same name.
- [ ] LAN-only behavior works with Tailscale absent or stopped.
- [ ] Only TCP 22 is required over the Tailnet.
- [ ] Live Tailnet addresses come from the captain's local Tailscale client, not persisted member endpoints.
- [ ] Ambiguous peer mappings are never guessed.
- [ ] Every route validates the same existing `<name>.local` SSH host pin.
- [ ] Wrong keys and broken routes fail closed with a forced-route recovery path.
- [ ] Partial/offline migration retains last-good mappings, falls back to LAN,
  and is visible through explicit checks/doctor.
- [ ] Current ordinary join is technically restricted to a directly connected LAN.
- [ ] Fleet stores no Tailscale credentials and mutates no Tailnet administration.
- [ ] Uninstall changes no unrelated Tailscale state.
- [ ] Documentation accurately distinguishes Fleet-local infrastructure from Tailscale's coordination/relay services.

## 18. Prior art note

T3 Code was inspected only for ideation. The useful lesson is to treat Tailscale as an optional endpoint provider outside the core machine model. Fleet has no T3-specific API, roadmap, process management, or dependency in this specification.

## 19. References

- [OpenSSH `ssh_config`](https://man.openbsd.org/ssh_config)
- [Tailscale CLI](https://tailscale.com/docs/reference/tailscale-cli)
- [Tailscale MagicDNS](https://tailscale.com/docs/features/magicdns)
- [Tailscale machine names](https://tailscale.com/kb/1098/machine-names)
- [Tailscale connection types](https://tailscale.com/docs/reference/connection-types)
- [Tailscale device sharing](https://tailscale.com/docs/features/sharing)
- [Tailscale grants](https://tailscale.com/docs/reference/syntax/grants)
- [Tailscale tags](https://tailscale.com/docs/features/tags)
- [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh)

## 20. Final recommendation

Ship one small, opinionated capability:

```text
same Fleet name + local peer discovery + tiny route selector + existing SSH pin
```

Do not build a second distributed endpoint protocol or require users to operate a Tailscale subsystem inside Fleet. Detect what already exists, map it safely, use it automatically, and make the single normal command remain:

```sh
ssh emerald.local
```
