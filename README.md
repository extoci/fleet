# Fleet

**Personal apps on your own computers, open from every device on your tailnet.**

Your coding agent writes the app. Fleet builds and updates it automatically with Bun, serves it over private HTTPS at addresses like `https://notes.fleet`, protects it behind Fleet Gate, and stops idle app workers when you're not using them.

Docs and guides live at **[fleet.extoci.lol](https://fleet.extoci.lol)**.

---

## Install

Make sure [Tailscale](https://tailscale.com/download) is installed and connected. The installer verifies the release checksum and installs [Bun](https://bun.com) 1.4+ automatically if it isn't already installed.

**macOS and Linux:**

```sh
curl -fsSL https://fleet.extoci.lol/install | bash
```

**Windows (PowerShell):**

```powershell
irm https://fleet.extoci.lol/install.ps1 | iex
```

To install directly from the `main` branch instead of a tagged release:

```sh
curl -fsSL https://fleet.extoci.lol/install | FLEET_VERSION=main bash
```

Or from a local checkout with Bun:

```sh
git clone https://github.com/extoci/fleet.git
cd fleet
bun install
bun link
```

## Quickstart

1. Set up your first computer as the gateway:

   ```sh
   fleet setup --install
   ```

2. Add the restricted **`fleet`** nameserver printed by setup in [Tailscale DNS settings](https://login.tailscale.com/admin/dns) (one-time rule for your tailnet).

3. Create and open your first app:

   ```sh
   fleet init notes
   fleet open notes
   ```

4. Connect your iPhone once with a QR code:

   ```sh
   fleet phone
   ```

5. Point your coding agent at `notes/AGENTS.md` and ask it to change the app. Fleet rebuilds on save and reloads open browsers automatically — no separate dev server or deploy step.

## How an app works

Each checkout created by `fleet init` contains:

- `fleet.json` — app ID, name, optional `jobs` schedule, and HTML head metadata (`title`, `themeColor`, `icon`, `manifest`)
- `client/index.tsx` & `client/style.css` — Preact frontend using `useQuery`, `useMutation`, and `call` from `fleet/client`
- `server/index.ts` — server `queries`, `mutations`, and scheduled `jobs` backed by SQLite JSON storage (`ctx.db`)
- `public/` — optional static assets served from the app root
- `.env.fleet.server` — server-only secrets read via `ctx.env` (ignored by Git)
- `fleet.d.ts` & `AGENTS.md` — types and instructions for coding agents

Useful commands for you and your agent:

```sh
fleet list --json
fleet inspect notes
fleet logs notes
fleet call notes queries notes
fleet call notes mutations addNote '{"text":"A note from my agent"}'
fleet backup notes --output notes.sqlite
```

See the full [CLI reference](https://fleet.extoci.lol/docs/cli), [app format](https://fleet.extoci.lol/docs/apps), and [security model](https://fleet.extoci.lol/docs/security).

## Development

Fleet uses **Bun** across the entire repository — runtime, bundler, package manager, test runner, type checker (`bun check`), formatter (`bun fmt`), and linter (`bun lint`):

```sh
bun install --frozen-lockfile
bun run typecheck     # bun check --no-script
bun run format:check  # bun fmt --no-script --check
bun run lint          # bun lint --no-script (Bun 1.4.6+ / canary)
bun test
```

The documentation website (`fleet.extoci.lol`) lives in [`web/`](web/README.md):

```sh
cd web
bun install --frozen-lockfile
bun run dev
```

Release packaging and installer publishing are documented in [`docs/releasing.md`](docs/releasing.md).
