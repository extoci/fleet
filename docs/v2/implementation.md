# Fleet v2 implementation plan

Status: superseded historical proposal. Do not implement this plan. The [current product direction](README.md) and [mobile setup decision](mobile-setup.md) replace it. The text below predates the personal-app runtime and phone requirements.

Base inspected: `7350c80`, Fleet 0.7.5. This document scopes the first private-app release. Existing v1 specifications remain authoritative for v1 behavior.

## Success condition

On machine A, run an HTTP app bound to `127.0.0.1:3000`, then `fleet register notes --port 3000`. On enrolled machine B, open `https://notes.fleet`. The app works with streaming responses and WebSockets. No public app listener, manual hosts entry, browser extension, or certificate bypass is necessary after client setup.

On a second tailnet, a recipient imports an app invitation after the owner shares the captain through Tailscale. The recipient opens `https://notes.alice.fleet`. Other apps remain inaccessible. Revocation terminates access.

The local service and captain are trusted with plaintext app traffic. This version does not promise end-to-end encryption through an untrusted captain. HTTP between the publisher and its localhost app is allowed. Every connection between machines uses authenticated TLS.

## What the repo already provides

- `src/cli.rs` and `src/commands.rs` define and dispatch the current CLI. Startup reconciliation can modify terminal files. New experimental app commands must bypass that reconciliation.
- `src/state.rs` provides machine UUIDs, Fleet membership, name validation, and atomic writes. Keep app state separate from state version 1 until migration is designed.
- `src/identity.rs` signs and verifies with OpenSSH identities. Reuse the pinned identity for enrollment proofs, not as an undocumented TLS key conversion.
- `src/service.rs` runs the captain's synchronous `tiny_http` service on port 42170. It supports signed join, leave, and usage operations with bounded bodies. Join deliberately requires a directly connected LAN. It has no v2 app registry or streaming relay.
- `src/ssh_client.rs` selects a LAN or Tailscale route for the captain's pinned SSH connection to a member. It transports SSH bytes. It does not give browsers DNS, route arbitrary app ports, or authorize member-to-member access.
- `src/remote.rs` runs bounded SSH subprocesses. Its collected-output interface is unsuitable for indefinite app streams.
- `src/tailscale.rs` maps known members to live peer addresses. Reuse its validation rules where applicable. Being a visible peer must never imply an app grant.
- `src/platform.rs` installs captain launchd and systemd user services. Add separate app services, with their own lifecycle and repair checks.
- CI runs formatting, Clippy with warnings denied, and tests on Linux and macOS. Preserve existing SSH and membership tests.

Do not add streaming app traffic to the single v1 request worker. Do not weaken LAN admission to obtain remote app enrollment.

## Architecture

The following is a proposed routing sequence, not a performance measurement.

1. The client's suffix resolver answers an authorized app name with loopback addresses.
2. The browser connects to the local HTTPS gateway on port 443. That gateway owns the certificate for the app name.
3. The gateway maps the exact name to a pinned captain identity, app UUID, and grant.
4. The gateway opens an authenticated stream to that captain.
5. The captain checks access and asks the registered publisher for a data connection.
6. The publisher connects outward to the captain, then connects to its explicitly registered localhost port.
7. The captain relays bounded byte streams until completion, timeout, disconnect, or revocation.

Both clients and publishers initiate connections to the captain. This works with the direction of ordinary Tailscale node sharing, provided policy permits the captain port. A Fleet invitation supplies authorization, not network reachability.

Use one configurable, dedicated captain TLS port, proposed 42171. Bind to explicitly selected private interfaces. Public listen addresses require a deliberate configuration. Never auto-open firewall rules. Existing port 42170 remains the v1 service.

Start with a separate foreground `fleet apps serve` process. Production installation adds supervision after transport tests pass. Do not require a root process to parse remote app traffic.

## Proposed commands

```sh
fleet apps setup --dry-run
fleet apps setup
fleet register notes --port 3000
fleet apps list --json
fleet apps inspect notes
fleet unregister notes
fleet apps doctor
fleet apps uninstall --dry-run
fleet apps uninstall

# Later sharing milestone. These commands do not exist yet.
fleet apps share notes --expires 7d
fleet apps import <invitation-file> --as alice
fleet apps revoke <grant-id>
```

Registration without `--port` reads an explicit project configuration. Otherwise it prompts only on a terminal. In noninteractive mode it fails with the required argument. Do not inspect unrelated processes and silently select one. Keep app configuration free of secrets and require an explicit save action before writing into a repository.

Registration prints the URL, owner, target port, audience, and whether the app is reachable. A failed health check preserves the requested registration with an offline status. The user can register before starting the app.

`unregister` disables routing and terminates connections before releasing its name. It does not stop the app process. Changing owners requires an explicit transfer. Repeating the same registration by its owner is idempotent. Registering the same name from a different machine returns a conflict.

## Names and state

Persist versioned app records under `~/.fleet/apps/`, with a dedicated advisory lock and atomic file replacement. Use separate stores for registry records, grants, enrolled certificates, client imports, and local aliases. Never serialize private keys into list output.

An app record contains schema version, fleet UUID, app UUID, normalized name, owner machine UUID, loopback target port, audience, and revision. It has no arbitrary upstream URL, shell command, or recipient-supplied destination. Support only IPv4 and IPv6 loopback HTTP targets initially.

Use the existing lowercase DNS label grammar for app names, with independent error messages. Reject IP literals, URLs, separators, wildcard labels, and reserved administrative names. Match names on DNS label boundaries. Normalize ASCII case and one trailing DNS dot consistently in DNS, SNI, and HTTP authority handling.

The captain owns unique names within a fleet. The client owns the merged namespace across imports. Qualified imported names are stable under a locally selected fleet alias. Short aliases require an explicit, conflict-free assignment. Disconnection never lets a different app claim an offline app's name.

Browser origins outlive registrations. Tombstone removed names locally and at the captain. Reassigning a name to a different app UUID requires an explicit origin-reset flow that explains cookies, service workers, and browser storage. An ownership transfer of the same app keeps its UUID. Renaming a foreign fleet alias also changes browser origins and requires an explicit action. Never switch an alias just because another fleet becomes active.

Registration persists across restarts. Online status does not. Publishers heartbeat every 10 seconds and expire after 30 seconds without contact. Reconnecting increments a session generation so a stale session cannot take over the current publisher. Cap reconnect backoff at 30 seconds with jitter.

Use durable revisions for writes. An expected revision prevents stale updates. A removed device loses its grants and publisher registrations, and active streams close. A captain restart invalidates outstanding stream tickets and requires fresh sessions.

## Enrollment and authorization

Keep browser certificate trust separate from network identity.

Each client has its own local browser CA. Its private key never leaves the client. Each fleet has a separate transport CA on the captain. Client and publisher TLS certificates bind a new transport key to a pinned Fleet machine UUID and a role. Create those keys locally and enroll through an authenticated channel.

For the first same-fleet experiment, provision temporary transport certificates into isolated test directories. The next milestone uses a one-time captain challenge signed by an existing pinned Fleet identity. Bind the signature to protocol version, fleet UUID, captain identity, device UUID, requested role, new key digest, challenge, and expiry. Consume the challenge once. A v1 signature envelope alone supplies no freshness guarantee.

The enrollment response must authenticate the captain through an already pinned channel, such as the existing captain-to-member SSH connection or an out-of-band verified invitation. Do not fetch a root over unauthenticated HTTP and trust it because the request was signed. Certificate issuance, renewal, expiry, key loss, and revocation need tests before production setup.

For foreign clients, use an owner-generated invitation file with a random one-time secret, captain transport fingerprint, endpoint, selected app UUIDs, and expiry. The recipient verifies the captain pin, proves possession of the secret, and enrolls its own transport public key. Persist a device-bound grant and discard the enrollment secret. Do not put reusable invitation secrets in URLs or logs. A Tailscale share and Fleet invitation are separate operations.

The broker checks the live device enrollment and app grant on every open. It checks the owner on every publisher operation. Revocation invalidates sessions and closes streams immediately on a connected broker. Partitioned clients cannot continue through an unreachable broker. Do not offer offline authorization caches in the first version.

A client can request only an authorized app UUID. The broker obtains its publisher from registry state. A publisher can attach only to a ticket issued for its own app and current session. Never accept a caller's arbitrary host or port as the destination.

## Transport experiment

Use Tokio, rustls, Hyper, and an established WebSocket implementation. Confirm current APIs and supported versions when implementing. Add dependencies only in the experimental transport change. Do not write a new HTTP parser, TLS stack, or HTTP multiplexing protocol.

Use a persistent authenticated WebSocket control connection per publisher. Use one pair of authenticated data WebSockets per proxied connection. The captain relays binary frames with bounded queues and backpressure. This avoids inventing multiplexed stream flow control for the first release.

An authorized client open creates a random single-use ticket bound to app UUID, grant UUID, client certificate, publisher certificate, session generation, and a five-second expiry. The captain sends a connect instruction to the publisher. Both endpoints attach through their authenticated connections. Tickets have distinct client and publisher attach permissions and are consumed atomically. Reject replay, wrong role, duplicate attachment, and expired tickets. Cap pending opens per device.

Define explicit end-of-stream and abort messages. WebSocket close alone does not model TCP half-close. Test request EOF while a response is still arriving, cancellation, publisher failure, and broker shutdown. Cap frames at 64 KiB and queued payload per stream at 256 KiB. Start with a limit of 64 active streams per app and 256 per captain. Make limits configurable after measuring real apps.

Use five-second connect deadlines and a 15-second header deadline. Do not impose a short total request deadline on SSE, uploads, or WebSockets. Connection liveness and idle policy must distinguish a healthy idle stream from a dead transport.

The local gateway accepts HTTP/1.1 initially. It terminates TLS, validates SNI against the HTTP authority, authorizes the exact app route, then forwards through the tunnel with Hyper. Support normal responses, streaming bodies, and HTTP upgrades. Remove hop-by-hop headers as required, preserve the upgrade path, reject ambiguous framing, and never retry a request after sending upstream bytes.

The client device is the initial browsing principal. Its local user and other processes running as that user can use its app grants. This version does not isolate hostile local users. Require exact Host and SNI checks to resist DNS rebinding. Reject cross-origin browser requests with an unrelated Origin by default, including WebSocket upgrades, while retaining the app's own authentication and CSRF checks. Put local administrative APIs on an owner-only Unix socket, never on the browser listener.

Preserve the external app Host and Origin. Set forwarded host and scheme to the actual local request values. Discard client-supplied forwarding headers before adding Fleet's own. Apps that reject the new hostname need an explicit allowed-host setting. Do not rewrite HTML, cookie domains, redirects, or OAuth callback URLs to conceal app configuration problems.

Unknown names fail closed. Missing grants return 403, offline publishers return 503, failed app connections return 502, and connect deadlines return 504. Browser errors must identify the failed layer without exposing remote keys, addresses, or other app names.

## DNS, TLS, and installation

The first transport experiment has no DNS or trust-store mutation. Exercise it with a temporary CA file and an explicit resolver override. This is an engineering milestone, not completion of the product contract.

For installed clients, serve only the configured private suffix over UDP and TCP DNS. Known routes return loopback A and AAAA records only when the corresponding listener exists. Unknown names return NXDOMAIN. Do not act as a recursive resolver. Use a short TTL, proposed five seconds, with bounded negative caching. Test EDNS, malformed input, TCP fallback, IPv6, and label-boundary checks with a maintained DNS library.

On macOS, investigate a dedicated `/etc/resolver/fleet` entry. On Linux with systemd-resolved, investigate a dedicated route-only DNS configuration. The precise persistent configuration is a qualification task, not settled by this plan. Do not overwrite `/etc/resolv.conf` or change global Tailscale DNS. Test resolver ordering with Tailscale enabled, disabled, restarting, and with other VPNs. Test browsers with secure DNS separately. Do not claim suffix queries never leak until packet capture verifies daemon-down behavior too.

Binding 443 and installing DNS or certificate trust require system integration. Prefer a small root-owned socket or forwarding configuration that sends traffic to an unprivileged local process. Select the mechanism after the OS experiment. Refuse an existing listener conflict rather than replacing it. Bind the browser gateway only to loopback. Prevent symlink attacks and cross-user ownership changes in privileged setup.

Generate local leaf certificates only for exact configured Fleet names. Root trust is broad even if our issuer restricts its own names. Investigate certificate name constraints and application compatibility, and state the actual trust scope in setup. Do not distribute a captain's browser CA key or import a friend's browser CA. Test Safari, Chromium, Firefox, system curl, and a Node client before documenting support.

Record every managed file and its previous state in a setup manifest. Validate the rendered configuration before activation. Roll back partial setup. Re-running setup is idempotent. Uninstall removes only Fleet-owned DNS rules, services, forwarding rules, and its specific local root certificate. It leaves app processes and unrelated DNS and trust entries alone.

## Implementation sequence and release gates

### 1. Prove the transport

Add `src/apps/mod.rs`, `transport.rs`, and `broker.rs` behind experimental commands that skip terminal reconciliation. Run a broker, publisher, local gateway, and test HTTP server with generated temporary certificates on random loopback ports. No v1 topology is required for this test fixture.

Acceptance: a second process sends an authorized request through the broker to the publisher's loopback app. Wrong certificates and wrong app IDs fail. Streaming bytes arrive before the response completes. All tasks exit after cancellation. This stage can proceed before product feedback.

### 2. Register and authorize

Add `registry.rs`, `grants.rs`, versioned state, CLI arguments, and `tests/apps_registry.rs`. Add enrollment proofs after isolated certificate fixtures work. Connect machine removal to enrollment and app revocation. Keep v1 join behavior unchanged.

Acceptance: register, list, inspect, unregister, restart, concurrent writers, stale revisions, ownership conflicts, invitation replay, expired certificates, and device removal behave as specified. Run all existing membership and SSH tests.

### 3. Make development apps work

Add `gateway.rs` and transport fault tests. Exercise a real WebSocket echo server, SSE server, large upload, cookie session, redirect, and an app with a Host allowlist. Add slow readers and a publisher that disappears halfway through a POST.

Acceptance: no full-body buffering, unbounded queue, duplicate POST, hung task, open proxy, or cross-app route exists. Record memory under the configured connection limit. Verify revocation closes existing WebSockets.

### 4. Qualify one Linux client and one Mac

Add `dns.rs`, `tls.rs`, and OS-specific setup support in `platform.rs`. Prove the resolver and low-port mechanism before implementing unattended installation. Use disposable test machines for privileged work.

Acceptance: the literal browser URL `https://notes.fleet` works without warnings across machines; ordinary DNS and v1 SSH still work; sleep, reboot, Tailscale reconnect, listener conflicts, partial setup, repair, and uninstall have recorded results. Check both IPv4 and IPv6. This is the first same-fleet v0 release gate.

### 5. Prove cross-tailnet sharing

Add invitations, imported namespaces, short aliases, and app-specific grants. Test with two actual tailnets and an explicitly shared captain. Keep the remote app machine unshared to the recipient.

Acceptance: the recipient opens only the invited app; duplicate names remain distinct; an uninvited device and a revoked device fail; changing Tailscale policy produces a reachability error without Fleet changing policy. This is the cross-tailnet release gate.

### 6. Package and migrate

Keep v2 opt-in while the gates are incomplete. Add supervision, repair diagnostics, documentation, and setup rollback. Preserve existing `.local` SSH, inventory, themes, and v1 service behavior. Decide separately whether a later v2 product removes the captain/member terminology or v1 commands.

Run the repository's `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`, and `cargo test` for implementation changes. OS qualification results must identify OS, browser, Tailscale distribution, and versions. Passing loopback integration tests cannot substitute for those results.

## Deferred work

Direct client-to-publisher connections, peer election, multi-captain availability, mobile clients, public links, non-HTTP services, process supervision, app deployment, and transparent multi-user OS support are outside the first release. The broker protocol uses app and fleet UUIDs so direct connections can be added without changing names or grants.

If an always-on captain or local certificate trust is unacceptable, revisit the architecture before production setup. A domain the user owns can change the DNS and certificate strategy. It does not remove the need for app authorization or private connectivity.

## First implementation handoff

Implement only stage 1 first. Read `src/cli.rs`, `src/commands.rs`, and the existing integration-test conventions. Add an opt-in transport experiment with temporary certificates and ephemeral loopback ports. Keep it independent of production Fleet state, privileged setup, DNS, and Tailscale. Prove request forwarding, progressive streaming, authorization failure, and task cleanup. Report the exact command that reproduces the demo and which release gates remain. Do not call it a working `.fleet` release.

See the [primary-source networking research](../research/fleet-v2-networking.md) for constraints and a direct-to-publisher alternative. This plan deliberately chooses a captain relay so a recipient needs network access to only one shared node. Direct routing can follow after the centralized version proves its authorization and lifecycle behavior.
