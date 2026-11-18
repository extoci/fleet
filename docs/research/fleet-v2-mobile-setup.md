# Fleet v2 mobile setup research

Research date: 2026-11-16. Status: research and proposal. No iPhone, Safari, or iOS Tailscale test was performed. Vendor documentation facts are cited inline. Design choices and unverified expectations are labeled as proposals.

Scope: the simplest distributable Fleet onboarding that makes the literal URL `https://notes.fleet` work in Safari on an unmanaged iPhone with Tailscale connected. Long `.ts.net` app URLs, owned public domains, guest hosting, native phone apps, and runtime architecture are out of scope.

## Answer

The literal name needs two independent things:

1. DNS that resolves `notes.fleet` inside the tailnet to the Fleet gateway.
2. A TLS certificate naming `notes.fleet` that the phone trusts.

Tailscale can supply the first through a restricted nameserver for the `fleet` suffix. It cannot supply the second for an arbitrary name. No public certificate authority can issue for `.fleet`, so the phone must trust a private Fleet root. On an unmanaged iPhone that means one Apple configuration profile install and one manual trust toggle. This is the minimum, not a choice among architectures.

## Verified facts

### DNS and iOS

- MagicDNS assigns names to tailnet devices. It does not accept arbitrary DNS records, so Fleet cannot create `notes.fleet` by adding a MagicDNS record. [Tailscale DNS](https://tailscale.com/docs/reference/dns-in-tailscale)
- A restricted nameserver applies only to queries matching a suffix. Configuring `fleet` to point at Fleet's DNS server makes `*.fleet` resolve through Fleet. Tailscale does not provide that DNS server or its records. [Tailscale DNS](https://tailscale.com/docs/reference/dns-in-tailscale)
- Clients must accept tailnet DNS. The iOS app exposes "Use Tailscale DNS Settings"; the CLI equivalent is `tailscale set --accept-dns`. There is no Tailscale CLI on iOS. [Client preferences](https://tailscale.com/docs/features/client/manage-preferences), [Tailscale CLI](https://tailscale.com/docs/reference/tailscale-cli)
- Tailscale's iOS client has a battery optimization that can skip a split DNS configuration when it contains routes but no custom resolvers. The `fleet` rule points at a custom resolver, so the optimization should not apply, but this needs device verification. [Tailscale nodecap source](https://github.com/tailscale/tailscale/blob/main/tailcfg/nodecap/nodecap.go)
- By default an exit node becomes the DNS resolver for all domains, regardless of global and restricted nameserver settings. An exit node is therefore unnecessary and can break `fleet` resolution. If the owner uses one, enable "Use with exit node" on the `fleet` nameserver. [Tailscale DNS](https://tailscale.com/docs/reference/dns-in-tailscale), [Client preferences](https://tailscale.com/docs/features/client/manage-preferences)
- At this date `fleet` is not delegated in the IANA root zone, and public CAs are prohibited from issuing certificates for internal names. Fleet cannot obtain a publicly trusted certificate for `notes.fleet`, and changing DNS or adding a CNAME does not change a certificate's names. [IANA root database](https://www.iana.org/domains/root/db), [CA/Browser Forum baseline requirements, sections 4.2.2 and 7.1.2.7.12](https://cabforum.org/working-groups/server/baseline-requirements/requirements/)
- Tailscale HTTPS certificates cover only `device.tailnet.ts.net`, not a bare hostname and not `notes.fleet`. [Tailscale HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates)

### Tailnet DNS API

- The split DNS endpoints are `GET`, `PATCH`, and `PUT /api/v2/tailnet/{tailnet}/dns/split-dns`. `PATCH` modifies only the domains named in the body and leaves other domains unchanged. A `null` value unsets a domain. `PUT` replaces all split DNS, and an empty object clears every domain. [Tailscale API](https://tailscale.com/api)
- `PATCH` is partial per domain, not per nameserver. Sending `{"fleet": ["100.x.y.z"]}` replaces any existing nameserver list for `fleet`. Fleet must `GET` first and refuse if `fleet` already points elsewhere. Never overwrite an unrelated rule. Never use `PUT` for onboarding. [Tailscale API](https://tailscale.com/api)
- The `dns` scope allows `GET`, `PATCH`, and `PUT` on split DNS. `dns:read` allows only `GET`. Authentication is an API key or OAuth bearer token at `https://api.tailscale.com/api/v2/`. The `{tailnet}` path segment is the organization name, and `-` selects the default tailnet. [Trust credentials](https://tailscale.com/docs/reference/trust-credentials), [Tailscale API](https://tailscale.com/api)
- No documented local-client command sets tailnet-wide split DNS. The write paths are the admin console and this API. Fleet should use an existing `dns` credential when present and otherwise show the one rule for the owner to enter. Do not make creating an API key the default setup task. [Tailscale API](https://tailscale.com/api)

### iPhone trust

- A certificate profile installed manually from a website or email is not trusted for SSL/TLS until the user opens Settings > General > About > Certificate Trust Settings and enables full trust for the root. [Apple certificate trust](https://support.apple.com/en-us/102390)
- Profiles installed by MDM, Apple Configurator, or an MDM enrollment profile are trusted automatically. That requires a device management service. Fleet is not an MDM and should not become one for this flow. [Apple certificate trust](https://support.apple.com/en-us/102390), [Apple certificate management](https://support.apple.com/guide/deployment/intro-to-certificate-management-depb5eff8914/web)
- Manual install: download the profile, open Settings, tap Profile Downloaded, tap Install, and follow the prompts. A downloaded profile is deleted after 8 minutes if not installed. Only one profile can be pending at a time. Stolen Device Protection may need to be disabled first when the phone is not in a familiar location. [Apple profile install](https://support.apple.com/en-us/102400)
- The root certificate payload type is `com.apple.security.root`. `PayloadContent` is the base64-encoded DER certificate. Manual installation is allowed, and the payload can contain only the public certificate. [Apple root payload schema](https://github.com/apple/device-management/blob/release/mdm/profiles/com.apple.security.root.yaml)
- On an unsupervised iPhone, a manually installed root shows a warning that it will not be trusted for websites until enabled in Certificate Trust Settings. The trust setting is system-wide for TLS, not scoped to `.fleet`. [Apple certificate management](https://support.apple.com/guide/deployment/intro-to-certificate-management-depb5eff8914/web), [Apple certificate trust](https://support.apple.com/en-us/102390)
- Apple requires TLS server certificates to contain the DNS name in the Subject Alternative Name extension, include the serverAuth extended key usage, use SHA-2, use RSA keys of at least 2048 bits when RSA is used, and have a validity period of 825 days or fewer. The separate 398-day limit applies only to certificates issued from roots preinstalled by Apple, not user-added or administrator-added roots. [Apple TLS requirements](https://support.apple.com/en-us/103769), [Apple 398-day limit](https://support.apple.com/en-us/102028)

### Bootstrap page

- Tailscale Serve exposes a local service only at `device-name.tailnet-name.ts.net` and requires HTTPS certificates to be enabled for the tailnet. It is tailnet-only; Funnel is the public alternative and is not appropriate here. [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- Tailscale HTTPS uses Let's Encrypt certificates for `.ts.net` names. Certificates have a 90-day lifetime and are renewed automatically when Tailscale serves them. Machine names and the tailnet DNS name are published in Certificate Transparency logs. [Tailscale HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates)
- A Serve page on the gateway's `.ts.net` name is trusted by Safari before the Fleet root is installed. A trusted page can deliver the profile that establishes trust for `notes.fleet`. Serve's automatic HTTPS certificate does not cover the literal `.fleet` app address. Combining Serve with the profile is a proposal built from verified pieces, not a tested flow. [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [Apple profile install](https://support.apple.com/en-us/102400)

### HTTP fallback

- An HTTP origin is not a secure context. W3C treats `https` and `wss`, loopback addresses, `localhost`, and `file` as potentially trustworthy. `http://notes.fleet` and `http://100.x.y.z` are not. [W3C Secure Contexts](https://w3c.github.io/webappsec-secure-contexts/)
- APIs restricted to secure contexts are unavailable at `http://notes.fleet`. This includes service workers and `crypto.subtle`; not every cryptographic API requires a secure context. Secure cookies also require HTTPS. Tailscale encryption does not change the browser's origin classification. Fleet should use HTTPS for its app platform. [W3C Secure Contexts](https://w3c.github.io/webappsec-secure-contexts/)

### Caddy reference

- Caddy's local HTTPS generates a unique root and intermediate per installation and stores them under `pki/authorities/local`. The root defaults to 3600 days, the intermediate to 7 days, and leaf certificates to 12 hours. The root is trusted only where it is installed. [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https), [Caddy tls internal](https://caddyserver.com/docs/caddyfile/directives/tls#internal)
- `caddy trust` installs a root into local trust stores. It does not install anything on iOS. Caddy also special-cases `.ts.net` names to fetch certificates from the local Tailscale client. [Caddy command line](https://caddyserver.com/docs/command-line#caddy-trust), [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- Caddy `tls internal` can be the production signer if Fleet persists its data directory and treats that root as the Fleet root. It is not a mobile trust mechanism by itself; Fleet still owns enrollment, profile delivery, and rotation.

## Recommendation

Use one private root per Fleet installation, generated locally at first setup. The root must be a CA certificate with the keyCertSign usage. The private key stays on the gateway with restrictive file permissions and is never shipped, uploaded, or shared between Fleets. The profile contains only the public root certificate. Persist the root across upgrades. CA replacement is an explicit re-enrollment, not a silent rotation. There is no Fleet-operated or globally shared CA key.

Run a small DNS responder on the gateway's Tailscale IP, port 53, with the usual privileged bind or capability. Answer only registered app names, return the gateway's reachable Tailscale address, return NXDOMAIN for unknown `.fleet` names, support UDP and TCP, and answer A and AAAA. Return NODATA rather than a confusing answer for HTTPS or SVCB queries that Fleet does not implement. The gateway routes each app to the machine that owns its checkout; DNS always returns the gateway, not the app host. Run the reverse proxy on port 443 with a leaf certificate whose SAN is the app name and whose lifetime is within Apple's limit.

Use a dedicated Tailscale Serve port for onboarding, for example 8443, so it does not conflict with the Fleet proxy on 443. The setup page should be short-lived, owner-only, and served from a tokenized path. Check existing Serve routes before activation and never replace unrelated routes. Do not enable Funnel.

### Onboarding flow

1. The owner installs Fleet on the captain and runs the guided phone setup. Fleet checks that Tailscale is connected, MagicDNS is on, HTTPS certificates are enabled, and Serve is available.
2. Fleet generates or loads the installation root, issues a leaf for the first app, starts the DNS responder and reverse proxy, stores the root key with restrictive permissions, and keeps it out of logs and the profile.
3. Fleet ensures one restricted nameserver for `fleet` points at the gateway's Tailscale IP. If an existing `dns` credential is available, Fleet performs `GET`, refuses if `fleet` already points elsewhere, `PATCH`es only `fleet`, and verifies with `GET`. Otherwise it opens the admin console and shows the exact rule. It never uses `PUT`.
4. Fleet starts a temporary Serve page with a QR code and a Download Profile button. The page explains that the phone must already be on the tailnet and that Tailscale must stay connected.
5. The owner scans the QR code on the iPhone, confirms the page loads, and downloads the profile.
6. The owner installs the profile and enables full trust in Certificate Trust Settings.
7. The page or the owner opens `https://notes.fleet`. Fleet verifies the request arrived with the expected Host and SNI, then reports success.
8. Fleet stops the temporary Serve route. DNS, proxy, and trust remain. Later apps reuse the same root and rules.

### Exact manual steps

On the computer:

- Add or approve the single tailnet DNS rule mapping `fleet` to the gateway's Tailscale IP, or authorize Fleet to do it with an existing `dns` credential.
- Approve enabling Tailscale HTTPS certificates if they are not already enabled. This publishes the captain's `.ts.net` name in Certificate Transparency logs.

On the iPhone:

- Install Tailscale, sign in, connect, and confirm "Use Tailscale DNS Settings" is on.
- Scan the QR code or open the setup URL in Safari.
- Download the Fleet profile.
- Open Settings, tap Profile Downloaded, tap Install, enter the passcode, and confirm.
- Open Settings > General > About > Certificate Trust Settings and enable full trust for the Fleet root.
- Return to Safari and open `https://notes.fleet`.
- Keep Tailscale connected while using Fleet apps.

Conditional steps:

- If an exit node is active, enable "Use with exit node" for the `fleet` nameserver.
- If Stolen Device Protection blocks profile installation, temporarily disable it, install, then re-enable it.
- If the profile was not installed within 8 minutes, download it again. Only one profile can be pending.

### What cannot be automated on an unmanaged iPhone

- Installing the profile requires the user to open Settings and confirm.
- Enabling root trust requires the user to open Certificate Trust Settings and toggle trust.
- Neither step can be silent without MDM, Apple Configurator, or a supervised management flow.
- Fleet cannot force Tailscale to stay connected or keep DNS acceptance enabled.
- Fleet cannot add the tailnet DNS rule from the phone or from the local Tailscale login.
- Receipt of a request alone does not prove how a client validated TLS. The device proof must check Safari's certificate state and secure-context behavior as well as arrival at `https://notes.fleet`.
- Root trust is broad system trust. The owner must consent to that, not just to trusting one app name.

### Rejected alternatives

- A public certificate for literal `notes.fleet` is not possible today because Fleet does not control `.fleet`. Any public-trust option changes the hostname to `.ts.net` or an owned domain and fails the requirement.
- MagicDNS alone cannot add `notes.fleet`.
- An exit node does not make a private root trusted and can bypass split DNS by default.
- HTTP over Tailscale avoids the profile but does not provide a browser secure context or HTTPS cookies at `notes.fleet`.
- A long `.ts.net` app URL is a different origin and is explicitly out of scope.
- An Apple DNS Settings payload for `fleet` could remove the tailnet DNS rule, but it adds device-wide DNS control, may conflict with Tailscale's VPN DNS handling, and still requires the certificate profile and trust toggle. It is not recommended before device testing. [Apple DNS settings payload](https://support.apple.com/guide/deployment/dns-settings-payload-settings-dep86469ba99/web)
- A shared or Fleet-operated CA would violate the no-global-key requirement. A compromise would let one key intercept every trusting phone.

## Recommended first proof

Use one Mac as captain and one real iPhone on the same tailnet. Run Caddy with explicit `tls internal` and `skip_install_trust` on port 443 for `notes.fleet`, a small DNS responder for `fleet`, the tailnet split DNS rule, and a temporary Serve page on port 8443 that offers Caddy's public root as a `.mobileconfig`. Keep the proof isolated from the Mac trust store and from existing Serve routes.

Pass criteria:

- The setup page loads over the captain's `.ts.net` name before the profile is installed.
- The profile installs, the trust toggle appears, and Safari opens `https://notes.fleet` with a valid lock.
- `window.isSecureContext` is true, a service worker registers, `crypto.subtle` works, and a Secure cookie is accepted.
- Fleet Gate login works at the literal origin.
- The app still loads after sleep, after Tailscale reconnect, and on cellular as well as Wi-Fi.
- With an exit node active, verify operation with "Use with exit node" enabled for `fleet`. Record behavior with the option disabled too; do not assume all exit-node resolver configurations behave identically.
- Turning off Tailscale DNS or removing the profile fails visibly with a useful error, not a certificate bypass.
- Removing the tailnet DNS rule produces a DNS-specific error.
- Typing `notes.fleet` without a scheme in Safari either navigates or searches; record which. The required URL includes `https://`.

Record the iOS version, Tailscale version, device model, every manual tap, and every failure message.

## Tests still required

- iOS split DNS behavior for a restricted nameserver on current iOS and Tailscale, including sleep/wake, Wi-Fi and cellular transitions, reconnect, and DNS caching.
- Restrictive tailnet ACLs that block UDP or TCP port 53 or TCP port 443. The default personal tailnet policy allows them; custom policies may not.
- Profile download from Safari over Serve, unsigned-profile warnings, the trust toggle, the 8-minute expiry, and Stolen Device Protection.
- Safari certificate acceptance for a Caddy leaf, including SAN, 12-hour renewal, and chain building from the installed root.
- Safari address-bar handling of `.fleet` names without a scheme.
- iCloud Private Relay or an existing custom DNS profile. Test with them present; do not change them silently.
- Cookie and WebAuthn scope for `fleet`. If Gate needs cross-app sessions, verify whether Safari accepts `Domain=fleet` or whether Gate needs per-app cookies or a redirect flow.
- Multiple Fleets or multiple roots on one phone, CA rotation, root removal, and upgrade persistence.
- Feasibility of signing the profile to reduce warnings. Not verified here.
- A second registered app with no additional profile.

Do not claim iPhone support until this proof passes. The local fixture is not a phone test.

## Local evidence

Ran `python3 docs/prototypes/mobile-https-proof.py` on 2026-11-16. It passed the Apple root payload round-trip, rejection by default trust, rejection of a wrong app hostname after trusting the root, and a verified HTTPS request for `notes.fleet`. It does not test DNS, Safari, iOS profile installation, Tailscale, or Gate. No system trust or network settings were changed.
