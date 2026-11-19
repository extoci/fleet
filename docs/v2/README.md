# Fleet v2

Status: the [v0 app runtime](../../v2/README.md) is implemented and has Linux integration and browser tests. Native Windows/macOS installation and iPhone qualification are pending device tests.

Fleet runs your personal apps on your own computers. Your agents build and change them. Your Tailscale devices open them at names such as `https://notes.fleet`, including on your phone.

Fleet must be installable by anyone on their own machines. Each installation owns its state, app data, and certificate keys.

## App experience

- `fleet init` creates a new app in the current project checkout. This is a proposed v2 change, not the current command behavior.
- The app runs on the machine with that checkout.
- Apps use a defined full-stack format inspired by Lakebed, with persistent data and tools for agents to inspect the app. Fleet does not inherit every Lakebed restriction.
- An agent's edits update the app across the owner's devices. Routine changes need no manual publish step.
- A failed build keeps the last successful build available and gives the agent the error.
- Fleet caches builds and stops development work when there are no edits. It loads app code when needed instead of requiring a permanent development server for every app.
- Scheduled tasks continue without a browser open, provided the host is running. App data survives unload, rebuild, and daemon restart.
- Fleet Gate is the login and identity provider for all Fleet apps.
- Opening an app can show a small Fleet loading page while it wakes. Startup failure must produce a useful error.

Resource efficiency is a requirement to measure. A cached build alone does not prove it. Saved builds also do not protect against a successful edit that damages app data. Data recovery needs a separate design.

## Networking

Tailscale provides private connectivity. Fleet provides app names, DNS answers, reverse proxy routing, Gate, and app lifecycle management.

Literal `.fleet` URLs must work on phones. A long `.ts.net` app URL does not meet this requirement. An exit node is not required for the proposed split DNS setup.

There are no guest invitations or public app links in this product direction. App host selection follows the checkout. Fleet does not move apps between machines automatically.

## Simplest proposed setup

Fleet prepares the DNS service, private certificates, and a phone setup page. The owner completes one guided tailnet DNS step. On the phone, they scan a QR code, download a certificate profile, install it in Settings, and enable trust once. Future apps use the same setup.

A temporary `.ts.net` address may deliver the setup page over already trusted HTTPS. It is not the app address. After setup, Safari uses `https://notes.fleet`.

The iPhone profile contains only the installation's public root certificate. The private signing key stays on its Fleet gateway. Fleet must never ship a shared signing key. The owner can remove the profile to remove trust.

See the [mobile setup decision](mobile-setup.md), the [mobile research](../research/fleet-v2-mobile-setup.md), and the [earlier networking sources](../research/fleet-v2-networking.md). The phone flow still needs testing on an actual iPhone.

## Next proof

First, open `https://notes.fleet` in Safari over both Wi-Fi and cellular with Tailscale connected. Verify HTTPS trust, Gate login, and the setup flow. Then use an agent to create and live-edit a real app, verify data survives restart, and measure idle resource use and first-open delay. Add a scheduled task with no browser open.

The previous [implementation plan](implementation.md) is retained as historical context. Its client-local proxy, guest sharing, and transport work are superseded. Do not use it as the v2 implementation brief.
