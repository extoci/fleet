# Test Fleet v2

This is the first installable v0. Use Node.js 22.16 or later and a connected Tailscale client. Start with the computer that will serve as your Fleet gateway.

Download `extoci-fleet-v2-2.0.0-alpha.1.tgz` from the `v2` directory. In the download directory, run these commands in a normal terminal on Linux, Windows, or macOS:

```sh
npm install -g ./extoci-fleet-v2-2.0.0-alpha.1.tgz
fleet --version
fleet setup --install
```

The version must say `Fleet 2.0.0-alpha.1`. If another `fleet` command appears first on your PATH, use the npm installation's command. The `fleet` command runs the first `node` on your PATH, so with two Node.js installations, put the one you installed Fleet with first. On macOS, use Node.js from nodejs.org, nvm, or fnm: setup refuses Homebrew's Node.js because its shared libraries cannot run from Fleet's boot helper. This v0 keeps its state under `~/.fleet/v2`; it does not migrate Fleet v1 machines.

Approve the OS installation prompt. Setup prints the exact nameserver and `fleet` suffix to add in the Tailscale DNS page. Add that rule once, and enable **Use with exit node** if you use one. An existing API credential with DNS access can do this automatically.

Create and open the first app:

```sh
fleet init notes
fleet open notes
```

Save a note. Ask your agent to change the heading in `notes/client/index.tsx`. The browser should update without a publish command. Notes should remain after a daemon restart.

For your iPhone, run on the same computer:

```sh
fleet phone
```

Keep Tailscale connected on the phone and scan the QR code in Safari. Install the downloaded profile in Settings. Enable **Fleet private apps** under General, About, Certificate Trust Settings. Return to the setup page and tap **Open Fleet**. Open `https://notes.fleet` and check the same note over Wi-Fi and cellular. There is no separate login code to type during this phone flow.

If Tailscale asks you to enable HTTPS for the temporary setup page, approve it in the Tailscale page. The `.ts.net` address is used only to deliver setup. App addresses remain `.fleet`.

If a step fails, return the command's error and the output of:

```sh
fleet doctor --json
fleet list --json
fleet logs notes
```

Use `fleet phone off` when finished with the setup link. Use `fleet uninstall` to remove the background installation and computer trust. App source and data stay available. Remove the `fleet` DNS rule and the iPhone profile if you retire this Fleet.

## What has passed

On Linux with Node 22, nine tests pass, including a Chromium browser with an isolated, trusted root certificate. They cover sign-in, live edits, DNS over UDP/TCP, private HTTPS, durable data, idle worker unloading, scheduled work, backup and restore, remote checkout routing, and the phone download/sign-in flow. No certificate bypass was used. A separately installed production package also built an app and saved data successfully.

The Windows/macOS installation paths are implemented. Their native startup, firewall, and trust steps have not run here. Safari profile installation and iPhone connectivity also need this device test. CI is prepared for Linux, Windows, and macOS, but has not run from this unpushed worktree.
