# Fleet v2 alpha

Fleet runs your personal apps on your own computers. Your agent edits the source. Fleet builds it, updates it across your devices, and stops idle app workers. Open your apps at `https://notes.fleet` through Fleet Gate.

This package is the v2 test build. The Rust binary at the repository root is Fleet v1. The two versions keep separate state. This package installs the new `fleet` command.

## First test

Install Node.js 22.16 or later and connect Tailscale on the computer. In this directory:

```sh
npm install
npm install -g .
fleet setup --install
fleet init notes
fleet open notes
```

The setup command installs background startup and certificate trust. Linux and macOS request administrator access for installation. The app runtime runs as your normal user. Windows uses a scheduled task under your user account and requests administrator access to register startup and tailnet firewall rules.

On the first computer, add the exact restricted nameserver shown by setup to your Tailscale DNS settings. Its domain is `fleet`. This is one rule for the entire tailnet. Fleet can add it with an existing `FLEET_TAILSCALE_TOKEN` credential that has the `dns` scope. It will not overwrite a conflicting rule. If you use an exit node, enable **Use with exit node** for that nameserver.

`fleet init notes` creates a directory named `notes`. Inside an existing checkout, use `fleet init --name notes` instead. Source files that already exist are never overwritten.

On Linux, this installer currently uses systemd and `update-ca-certificates`, as provided by Debian and Ubuntu. It leaves `resolv.conf` and the Tailscale interface configuration alone. macOS gets a suffix resolver for `.fleet`. Linux and Windows use the tailnet DNS rule. Each device must accept Tailscale DNS settings.

## Connect an iPhone

On the Fleet gateway computer:

```sh
fleet phone
```

Scan the QR code in Safari with Tailscale connected. The private setup page explains the steps:

1. Download the profile. Open Settings and install the downloaded profile.
2. Open General, About, Certificate Trust Settings. Enable **Fleet private apps**.
3. Return to the setup page and tap **Open Fleet**. This also signs the browser in through Gate.

Then open `https://notes.fleet`. Later apps need no extra certificate profile. The download contains only your installation's public root certificate. Its private key stays on the gateway. You do not need an Apple Developer account.

The setup page uses Tailscale Serve on a private `.ts.net` address at port 8444. This address is only for setup. Tailscale may ask you to enable HTTPS once. Fleet refuses to replace an existing Serve route on that port. The profile URL expires after fifteen minutes. Run `fleet phone off` to remove Fleet's setup route when finished.

No public Funnel is configured. No exit node is required.

## Agent workflow

Each app has `fleet.json`, `client/index.tsx`, `client/style.css`, `server/index.ts`, and generated instructions in `AGENTS.md`.

```sh
fleet list --json
fleet inspect notes
fleet logs notes
fleet call notes queries notes
fleet call notes mutations addNote '{"text":"A note from my agent"}'
```

An agent changes the source without running Vite or another app server. Successful builds update open browsers. A failed build keeps the previous build running and records the error for `fleet logs`. The browser reloads on a successful update. This v0 does not preserve unsaved form state through a reload.

The client uses Preact and imports `useQuery` and `useMutation` from `fleet/client`. `useQuery` returns `{ data, error }`. Queries refresh after mutations and while a visible page is open.

The server exports an object with `queries`, `mutations`, and `jobs`. A handler receives `ctx` and its JSON input. `ctx.user.id` is the owner identity. `ctx.db.get`, `set`, `delete`, and `list` provide persistent JSON documents. Queries cannot write. Operations are serialized per app, and mutations use SQLite transactions. Keep external calls short. Request operations time out after fifteen seconds; job operations after thirty seconds. Timed-out operations are not automatically replayed as browser requests.

Put server-only API keys in `.env.fleet.server`. Handlers read them through `ctx.env`. The generated Git ignore rule excludes that file. Fleet does not inject those values into the client bundle.

App workers start on demand and stop after thirty seconds without app operations. Cached frontends remain available. Fleet shares one build service and one scheduler across the registered apps. App code runs with the owner's OS permissions. It is trusted personal code, not an untrusted-code sandbox.

## Scheduled work and data

Add a job declaration to `fleet.json`:

```json
"jobs": [{ "name": "dailyCheck", "everySeconds": 86400 }]
```

The corresponding function is `jobs.dailyCheck` in the server definition. It runs with no browser open. Schedules and app data persist outside the checkout under `~/.fleet/v2`. A host that is asleep or off cannot run a job. On restart, an overdue job gets one catch-up occurrence. An interrupted occurrence retries with the same `ctx.runId`; use that ID as an external service's idempotency key. Failures appear in app logs and inspect output.

```sh
fleet backup notes --output notes.sqlite
```

This makes a consistent SQLite snapshot while the app is running. `fleet restore notes notes.sqlite` requires Fleet to be stopped and preserves a backup of the data it replaces. Build rollback does not roll back app data. A change that compiles can still have a bug. There is no automatic data history in this v0.

## Add another app computer

Keep one Fleet computer as the gateway for DNS, HTTPS, and Gate. It must be running for phone access. Apps and data remain on their checkout computers.

On the gateway:

```sh
fleet invite --output computer-invite.json
```

Have your agent transfer this private file to the other computer, then run there:

```sh
fleet setup --join computer-invite.json --install
fleet init another-app
```

The invitation expires in ten minutes and can enroll one computer. Fleet pins the gateway's certificate root from the invitation. The gateway pins the new computer's root and verifies its private app listener before accepting registration. App names must be unique. The node listener uses Tailscale TCP port 42174. Existing tailnet policy must allow it from the gateway. Fleet does not change tailnet policy.

Gate and the phone setup commands run on the gateway. Other computers can inspect and call their local apps through the CLI. Registering a new checkout does not move it to the gateway.

## Diagnostics and removal

`fleet doctor` checks the daemon, Tailscale, and name resolution. After `fleet setup --local`, doctor still checks the daemon but skips Tailscale and system DNS. In JSON, skipped checks have `"skipped": true` and `"ok": null`. `fleet phone off` succeeds without contacting Tailscale if Fleet has no recorded phone setup route.

`fleet gate` prints a short-lived device code for another browser. `fleet gate reset` revokes all browser sessions. `fleet open` signs in the local browser using the owner-only control endpoint. App cookies are host-specific, Secure, and HttpOnly; an app does not receive the Gate session.

`fleet unregister notes` removes its route but preserves source and data. Names stay bound to their app IDs to avoid silently reusing a browser origin for a different app.

`fleet uninstall` removes background startup and computer trust while retaining apps and data. Remove the tailnet's `fleet` DNS rule and the phone's Fleet profile if you retire the installation. The installer does not modify the existing Fleet v1 state.

## Validation status

Linux end-to-end tests cover real TLS, UDP/TCP DNS, Gate sign-in and revocation, builds, last-build fallback, persistent data, idle unloading, scheduled jobs, remote checkout routing, and phone profile delivery. A Chromium test with a temporary NSS trust store checks sign-in, saving notes, secure browser context, a phone-size layout, and live edits. It does not bypass certificate verification or change system trust.

CI is configured for Linux, Windows, and macOS with Node 22 and 24. Those CI jobs have not run from this local worktree. Native service installation on Windows and macOS, and Safari/profile installation on an iPhone, still need device tests. This is the first v0 for those tests, not a claim of completed platform qualification.

For local test runs:

```sh
npm ci
npm test
```

The browser test additionally needs `FLEET_BROWSER_EXECUTABLE` and `FLEET_CERTUTIL`, pointing to a Chromium executable and NSS `certutil`. It creates and removes an isolated browser home. Without those variables only that test is skipped.
