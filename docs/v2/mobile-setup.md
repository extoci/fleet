# Mobile setup decision

Status: the [v0 runtime](../../v2/README.md) implements DNS, private HTTPS, Gate, profile download, and a QR setup command. This document records the earlier design decision. The v0 uses a maintained JavaScript certificate library rather than a separate Caddy process. No iPhone test has run yet.

## User experience

The owner installs Fleet on their computer and connects it to their existing Tailscale network. Fleet prepares the private app gateway and gives the owner a guided setup page.

On first setup, the owner adds one tailnet DNS rule using the exact values Fleet supplies. Reuse existing API access to do this automatically when available. Do not make creating an API key the default onboarding task. Do not claim Fleet can change tailnet DNS with the local Tailscale login alone.

For the iPhone, the computer shows a QR code for a private, normally trusted HTTPS setup page. The owner scans it, downloads the generated Fleet profile, installs it in Settings, and enables certificate trust. The page then opens `https://notes.fleet` to check the result.

The phone steps occur once per Fleet installation. New apps need no new profile. iOS requires owner action to install a downloaded profile and enable root trust on an unmanaged phone. Fleet should explain those actions at the point of use. See [Apple profile installation](https://support.apple.com/en-us/102400) and [certificate trust](https://support.apple.com/en-us/102390).

No native Fleet phone app, exit node, public app exposure, or long app URL is required by this proposed flow. Keep the long Tailscale address confined to the temporary setup link and diagnostics.

## Engineering choices

- Use Tailscale's restricted nameserver setting for the `fleet` suffix. The nameserver is the Fleet DNS service's stable Tailscale IP. Keep all other DNS settings intact. Detect an existing rule for `fleet` before replacing anything. See [Tailscale DNS](https://tailscale.com/docs/reference/dns-in-tailscale).
- Answer only registered app names. Return the Fleet gateway's reachable private address, not phone loopback. Unknown `.fleet` names get a negative answer. Support UDP and TCP DNS plus A, AAAA, and HTTPS-type queries without confusing a browser's resolver.
- Keep app processes on their checkout hosts. The gateway routes to those hosts over existing Tailscale connectivity. This does not imply automatic app relocation.
- Use a maintained reverse proxy and certificate implementation for the first end-to-end proof. Caddy with explicit `tls internal` provides a private CA and certificate renewal. Disable automatic host trust installation during isolated tests. See [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https).
- Deliver the setup page through Tailscale Serve with an ordinary `.ts.net` certificate. Check HTTPS enablement and existing Serve routes before activation. Never replace unrelated routes or enable public Funnel as a setup shortcut. See [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).
- Generate one private CA per Fleet installation. Keep the signing key on its gateway and distribute only the public root. Persist this state across upgrades so phones do not need to trust a new root after every restart. Gateway recovery or CA replacement needs an explicit re-enrollment flow.
- The Apple profile contains a single `com.apple.security.root` certificate payload. It grants no device management, VPN, or global DNS control. Certificate trust is still broad system trust, not an app permission. See [Apple's payload schema](https://github.com/apple/device-management/blob/release/mdm/profiles/com.apple.security.root.yaml).
- Gate runs after HTTPS works. A certificate profile does not identify the owner. Restrict the setup endpoint to an authorized owner session or a short-lived pairing session and serve no private keys. Do not build an arbitrary public certificate/profile download service.

Tailnet DNS configuration requires tailnet administration authority. If API access is already available, change only the `fleet` mapping and verify read-back. Otherwise open the DNS admin page and show the one rule to enter. Avoid credentials solely to save a short, one-time admin step. Changing DNS is not necessary during research.

The independent [DeepSeek research](../research/fleet-v2-mobile-setup.md) confirms the same approach. The split DNS API offers a per-domain `PATCH`; it replaces the nameserver list for that domain. Read first, reject a conflicting `fleet` rule, update only that mapping, and verify. Avoid the whole-map `PUT`. Do not claim the QR flow is the entire first-use setup if the owner still needs to enable Tailscale HTTPS or add the DNS rule.

An exit node changes traffic and DNS routing. It does not make a private root trusted. If the owner already uses an exit node, test the restricted resolver's "Use with exit node" option. Do not force all internet traffic through a Fleet computer. See [Tailscale nameservers and exit nodes](https://tailscale.com/docs/reference/dns-in-tailscale#nameservers-and-exit-nodes).

## Local proof

Run the isolated fixture:

```sh
python3 docs/prototypes/mobile-https-proof.py
```

The fixture creates a temporary private root and a leaf for `notes.fleet`. It encodes and reads back a standard Apple root certificate payload. It runs a temporary loopback HTTPS server, verifies that default trust rejects the leaf, verifies that trusting the root still rejects the wrong app hostname, and completes a verified HTTPS request for `notes.fleet`.

The fixture uses an explicit socket address while retaining `notes.fleet` for TLS name verification. It does not test DNS. All temporary keys and the profile are deleted after the run. No trust store, tailnet policy, DNS setting, or system service changes.

This is evidence for certificate generation, profile encoding, and TLS host validation. It is not evidence that iOS accepts the profile, that Safari uses the tailnet DNS rule, or that Gate works. The proof is not a production certificate service.

## Device test still required

Use one real iPhone connected to the owner's Tailscale network. Test profile installation and full trust, the literal URL, Gate sign-in, Wi-Fi and cellular, a second registered app without another profile, and reconnect after sleep. Repeat with an exit node if the owner uses one. Check Private Relay or another DNS profile when present instead of changing them silently.

Remove the profile and confirm certificate validation fails. Restore it and confirm it works again. Remove the tailnet DNS mapping and confirm the setup check identifies DNS as the problem. Never treat a certificate bypass as a pass.

Record the iOS and Tailscale versions, manual taps, and failure messages. That is the release gate for claiming phone support. Do not ask the owner to choose a DNS architecture or a different app hostname.
