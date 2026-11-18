# Fleet v2 private app networking

Historical research. Its sharing model and client-local proxy recommendation are superseded by the [current product direction](../v2/README.md). Use the [mobile setup research](fleet-v2-mobile-setup.md) for the phone flow.

Research date: 2026-11-04. Scope: `fleet register app` followed by private browser access at `https://app.fleet`, across machines, Fleet memberships, and Tailscale tailnets. This is research and a proposed architecture, not an implemented or qualified contract.

## Verified facts

### MagicDNS and split DNS

- MagicDNS assigns device names; it does not accept arbitrary DNS records. Fleet cannot create `app.fleet` by adding a MagicDNS record. Tailscale supports restricted nameservers, which forward queries for a configured suffix to a DNS server you operate. Those settings require clients to accept Tailscale DNS configuration. [Tailscale DNS](https://tailscale.com/docs/reference/dns-in-tailscale)
- Split DNS selects a resolver; Fleet must still supply its records, availability, and authorization. A restricted nameserver is separate from MagicDNS. Tailscale documents routing internal-service queries to a private nameserver through the tailnet. [Tailscale DNS](https://tailscale.com/docs/reference/dns-in-tailscale), [DNS rebinding guidance](https://tailscale.com/docs/reference/faq/dns-rebinding)
- MagicDNS is a tailnet setting. Shared machines require their full `host.owner-tailnet.ts.net` name, rather than the bare hostname. [Sharing and MagicDNS](https://tailscale.com/docs/features/sharing#sharing-and-magicdns)

### `.fleet` and `.internal`

- At this research date, `fleet` appears in neither IANA's root zone database nor its special-use domain registry. This establishes no current delegation or listed special-use reservation; it provides no guarantee against future allocation. [IANA root database](https://www.iana.org/domains/root/db), [IANA special-use registry](https://www.iana.org/assignments/special-use-domain-names/)
- ICANN permanently reserved `.internal` from root delegation on 29 July 2024 for private applications. That is an ICANN reservation, distinct from assuming an entry in the IETF special-use registry. It does not supply a resolver, certificates, or uniqueness between private networks. [ICANN resolution 2024.07.29.06](https://www.icann.org/en/board-activities-and-meetings/materials/approved-resolutions-special-meeting-of-the-icann-board-29-07-2024-en)

### TLS choices

- Publicly trusted CAs cannot issue certificates containing internal names. Therefore today's undelegated `app.fleet`, and reserved names such as `app.fleet.internal`, cannot use ordinary public WebPKI issuance. [CA/Browser Forum requirements, sections 4.2.2 and 7.1.2.7.12](https://cabforum.org/working-groups/server/baseline-requirements/requirements/)
- A private CA can support local browser HTTPS after its root is trusted. The mkcert project demonstrates separate system/browser trust stores and warns that its CA private key permits interception. It explicitly targets development, not production deployment to end users. Treat it as evidence and a prototype tool, not Fleet's production CA implementation. [mkcert upstream](https://github.com/FiloSottile/mkcert)
- Tailscale HTTPS provisioning requires MagicDNS and HTTPS certificates enabled. `tailscale cert` obtains certificates for the machine's eligible tailnet DNS name using Let's Encrypt DNS-01. Certificates disclose the issued names in certificate transparency logs; network access remains private. A bare hostname is not covered. [Tailscale HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates)
- The CLI presents the daemon's `CertDomains` as valid domain choices. This is not an arbitrary-domain certificate API. A certificate for `publisher.tailnet.ts.net` does not authenticate browser requests for `app.fleet`; changing DNS or adding a CNAME does not change the certificate's names. [Tailscale cert source](https://raw.githubusercontent.com/tailscale/tailscale/main/cmd/tailscale/cli/cert.go), [TLS service identity, RFC 9525 section 6](https://www.rfc-editor.org/rfc/rfc9525.html#section-6)
- An owned public domain is another option. DNS-01 can validate a name whose web server has no public exposure; public validation TXT records are required. Thus private app routing and public TLS can coexist under an owned public domain, but that produces a different browser hostname. [Let's Encrypt DNS-01](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge)

### Sharing, quarantine, and connection direction

- Node sharing exposes one machine to the invited user, not every user in the recipient tailnet. Policies in both tailnets apply. Sharing does not export subnet routes or the node's tags. [Tailscale sharing](https://tailscale.com/docs/features/sharing)
- A shared node is quarantined by default. Recipient machines can initiate connections to it; it can return traffic but cannot initiate connections into the recipient's machines. Mutual node sharing can permit initiation in both directions. [Quarantine and access policies](https://tailscale.com/docs/features/sharing#quarantine)
- A share invitation needs acceptance; the documentation currently requires a recipient Owner, Admin, or IT admin. Tailnet Lock can add signing requirements. Sharing is therefore a separate network prerequisite, not something Fleet registration alone establishes. [Tailscale sharing](https://tailscale.com/docs/features/sharing)

### macOS local DNS

- Apple documents `/etc/resolver/<domain>` as a per-domain resolver configuration. The filename supplies the domain; `nameserver` and `port` select the local DNS server. The resolver chooses the longest matching domain suffix and uses `search_order` for multiple clients of the same domain. Apple says not to manually edit its managed `/etc/resolv.conf`. [Apple resolver(5) source](https://raw.githubusercontent.com/apple-oss-distributions/libresolv/main/resolver.5)
- The open-source `tailscaled` macOS DNS adapter itself writes `/etc/resolver/<suffix>` files for split DNS and removes files bearing its own header. This is evidence for that distribution, not proof of identical behavior in macOS Network Extension/App Store clients. A Fleet file must have its own ownership marker, and a suffix conflict requires detection. [Tailscale Darwin DNS adapter](https://github.com/tailscale/tailscale/blob/main/net/dns/manager_darwin.go)
- Some macOS CLI tools, including `host` and `nslookup`, bypass normal system resolution. A successful direct DNS query alone does not prove that browser/system resolution works. [MagicDNS documentation](https://tailscale.com/docs/features/magicdns)

### Linux local DNS and Tailscale

- `systemd-resolved` routes queries to the longest matching routing domain. Equal matches on multiple links cause parallel queries. A route-only suffix such as `~fleet` selects DNS without adding a search suffix; `~.` instead matches all domains. `DNSDefaultRoute=false` excludes unmatched queries from that link. [systemd-resolved routing](https://www.freedesktop.org/software/systemd/man/latest/systemd-resolved.service.html)
- `resolvectl dns`, `domain`, and `default-route` configure per-link DNS. DNS server addresses can include a port. Settings disappear when the interface disappears; `revert` clears that link's configuration. [resolvectl manual](https://www.freedesktop.org/software/systemd/man/latest/resolvectl.html)
- Tailscale recommends the resolved stub arrangement for NetworkManager plus resolved, with `/etc/resolv.conf` pointing to `/run/systemd/resolve/stub-resolv.conf`. Without a cooperating DNS manager, DHCP and Tailscale can fight over that file. [Tailscale Linux DNS](https://tailscale.com/docs/reference/linux-dns)
- Tailscale may overwrite `/etc/resolv.conf` when accepting DNS without a detected DNS manager. `--accept-dns=false` disables its automatic DNS configuration, but its local MagicDNS resolver can still answer on `100.100.100.100` when MagicDNS is enabled. Disabling acceptance is a tradeoff, not a necessary Fleet default. [Tailscale resolv.conf FAQ](https://tailscale.com/docs/reference/faq/dns-resolv-conf)

## Design inference and recommendation

These recommendations follow from the constraints above; they still require implementation and platform qualification.

### Client DNS plus HTTPS proxy

1. `fleet register app` records a stable app ID, Fleet ID, publisher identity, approved local backend address/port, and access policy. Registration is authorized against the publishing Fleet. Do not equate a tailnet peer name with a Fleet or app identity.
2. Each browsing machine runs Fleet's local DNS responder and HTTPS proxy. DNS answers authorized local aliases with loopback addresses. The browser connects to the local proxy on port 443; Fleet routes the selected app over an authenticated connection to its publisher. Keep DNS and browser listeners on loopback, including deliberate IPv6 handling.
3. The client resolves the publisher through an independently authenticated registry and the available transport. Same-tailnet and shared-node connections use locally visible Tailscale endpoints; LAN transport must authenticate the same publisher identity. Never resolve the publisher through `app.fleet`, which would loop back into the client proxy.
4. The publisher authenticates the client, authorizes the requested app ID, and forwards only to that app's registered backend. It can serve multiple apps over one network port. It must not accept arbitrary destinations, filesystem paths, or client-supplied forwarding identities.
5. The publisher normally runs on the app machine, allowing a backend bound to loopback. A gateway elsewhere in the publishing Fleet is optional and needs explicit backend reachability and authentication.
6. A client initiates the connection to a publisher shared from the owner's tailnet. Publisher responses, streams, and WebSocket traffic use that established connection. A design requiring the shared publisher to dial the client's callback listener conflicts with quarantine. If a captain is shared instead, it must actually proxy to the backend; sharing it does not make other app machines reachable.

This keeps app aliases independent of machine names and avoids requiring every tailnet administrator to install a Fleet split-DNS zone. Tailnet-wide restricted DNS remains an optional managed deployment mode. It does not replace client TLS setup or Fleet authorization.

### Names, origins, and certificates

- Prefer `app.<fleet-id>.fleet.internal` as the canonical private name. Offer `app.fleet` only as a documented convenience alias if that exact experience is required. Its future collision risk remains even when local DNS intercepts it.
- An alias must map unambiguously. Reject collisions across fleets and require a qualified name. Do not silently retarget an existing browser origin when Fleet selection changes; cookies, service workers, and stored application data could otherwise cross trust boundaries. Keep a persistent alias binding or require an explicit migration/reset.
- Create a CA per browsing installation and issue local proxy certificates only for approved Fleet names. Keep the CA key local, separate from publisher keys, with restrictive access; never copy a shared Fleet-wide root private key between machines. Provide trust installation/removal and renewal as explicit setup behavior. DNS and certificates are required on every browsing client, including clients in another fleet.
- The local proxy terminates browser TLS. It separately verifies the remote publisher, for example through Fleet-pinned keys with mutual TLS and an app-scoped client credential. Tailscale-issued publisher TLS is optional, with its documented naming, setup, and transparency consequences. A locally valid browser certificate does not prove that the remote publisher is authentic.
- If avoiding client CA installation is the priority, use an owned public hostname with DNS-01 and private routing. Do not promise public trust for the literal `app.fleet` URL.

### Authorization beyond tailnet reachability

- Tailscale grants restrict access to the publisher's port. All apps sharing that port need Fleet app-level authorization at the publisher. Tailnet membership or a shared-node invitation alone must not authorize every registered app.
- Authenticate Fleet clients and check Fleet ID, app ID, audience, expiry, and revocation on each request or bounded session. Authorize registry reads separately so a reachable publisher cannot enumerate private apps.
- A trusted local proxy can carry the authenticated user's app credential. Reject unknown Host/SNI values, validate browser origins for state-changing requests, and preserve app authentication/CSRF defenses. Loopback binding alone does not authorize arbitrary local processes or browser requests.
- Revoke Fleet credentials and registry access independently of Tailscale shares. Stop new sessions promptly and define termination rules for existing streams. Never accept an unverified identity merely because a connection arrived through Tailscale.

### Platform adapters

- On macOS, prototype a Fleet-owned `/etc/resolver/fleet` pointing to a loopback DNS listener, plus `/etc/resolver/fleet.internal` for canonical names. Preserve unrelated entries; reject conflicting ownership. Leave the default resolver and Tailscale suffixes to their existing managers.
- On supported Linux systems, prototype resolved route-only domains `~fleet` and `~fleet.internal` on a Fleet-owned link with a loopback DNS server and `default-route=no`. Qualify the loopback-server/link association before adopting it. Do not attach Fleet settings to `tailscale0`, whose DNS configuration Tailscale owns, or replace the machine's default DNS.
- Own only these suffixes. Unknown aliases should return a negative answer locally rather than be forwarded to public DNS. Document unsupported resolver configurations instead of assuming all Linux installations run resolved.

## Experiments still required

No DNS, certificate, or cross-tailnet runtime experiments were performed for this note.

1. On supported macOS releases, test standalone, Network Extension, and App Store Tailscale clients with DNS acceptance on/off, MagicDNS, split DNS, exit nodes, sleep/wake, upgrades, and reconnects. Inspect `scutil --dns` and test native resolution plus browsers. Confirm Fleet files survive Tailscale cleanup and are removed by Fleet uninstall.
2. On Ubuntu/systemd-resolved plus NetworkManager and networkd, prove the Fleet-owned link can route to the loopback DNS listener. Verify longest-suffix behavior against Tailscale's `~.`/restricted domains, duplicate suffixes, DHCP renewals, daemon restarts, boot, and uninstall. Inspect `resolvectl status`, `resolvectl query`, and libc resolution.
3. Test browser secure DNS/DoH, macOS Private Relay, explicit HTTP proxies, browser DNS caches, A/AAAA, UDP/TCP DNS, and packet capture. Demonstrate that private suffixes stay local in supported configurations and diagnose bypasses. Check address-bar handling of `app.fleet` without an explicit scheme.
4. Qualify local port 443 ownership, port conflicts, privilege separation, CA installation/removal, renewal, and Firefox/system/runtime trust stores. Verify unsupported clients fail visibly rather than instructing users to bypass certificate checks.
5. With two independent tailnets, share only the publisher to the intended recipient and test client initiation, return traffic, blocked unsolicited reverse initiation, FQDN lookup, policy denial, share revocation, and Tailnet Lock. Confirm another user in the recipient tailnet gains no access. Test mutual sharing separately.
6. Register apps in two fleets with the same short name. Verify collision rejection, stable canonical origins, pinned publisher identity across LAN/Tailscale changes, expired/revoked credentials, and denial to a reachable but unauthorized tailnet peer.
7. Exercise redirects, absolute URLs, cookies, OAuth callbacks, Host/Origin checks, WebSockets, server-sent events, uploads, and streaming. Determine which apps need an external-base-URL setting rather than fragile response rewriting.
