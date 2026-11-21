# Fleet web

Fleet's website and documentation at **[fleet.extoci.lol](https://fleet.extoci.lol)** use [Holocron](https://github.com/remorses/holocron), React, and Vite on Bun. Run website commands inside `web/`.

## Develop

Use Bun 1.4.5+ for installs, checks, formatting, tests, and Vite. Node.js 22.x is used to serve and smoke-test the Spiceflow production and Vercel builds.

```sh
bun install --frozen-lockfile
bun run dev
```

Vite prints the local development URL. The dev script binds to `0.0.0.0` for preview environments; do not expose it publicly as a production server.

## Check, lint, format, and build

```sh
bun run check
bun run typecheck
bun run format:check
bun run lint          # Bun 1.4.6+ / canary
bun test
bun run build
bun run test:production
```

- `bun run check` validates navigation coverage, page metadata, and local link targets.
- `bun run typecheck` runs Bun's native TypeScript checker (`bun check --no-script`) on `vite.config.ts` and `components/`.
- `bun run format` / `bun run format:check` runs Bun's native formatter (`bun fmt`). Embedded language formatting is off to preserve quoted MDX frontmatter and fenced examples.
- `bun run lint` runs Bun's native linter (`bun lint`, shipping in Bun 1.4.6 / `bun upgrade --canary`).
- `bun test` runs the content verification unit tests.
- `bun run test:production` starts the built server on loopback and checks every page, redirect, missing route, static asset, installer script (`/install`, `/install.sh`, `/install.ps1`), and markdown/llms export over HTTP.

## Installer scripts

`public/install`, `public/install.sh`, and `public/install.ps1` are served directly from `https://fleet.extoci.lol/` via Vercel's static CDN. They are exact copies of the root [`install.sh`](../install.sh) and [`install.ps1`](../install.ps1) scripts — verified automatically by `test/installer.test.ts` at the repository root. Whenever you update a root installer script, sync the matching file(s) in `web/public/`.

## Serve the production build

```sh
bun run build
bun run start
```

The production server runs on Node.js on port 3000 by default (`PORT` overrides it). Spiceflow's generated entry point starts a Node HTTP server and exports a fetch handler, which triggers a double-bind if executed directly with `bun`, so Node.js serves the built bundle.

## Deploy to Vercel

1. Import `extoci/fleet` in Vercel with `main` as the production branch.
2. Set **Root Directory** to `web`, **Framework Preset** to **Other**, and **Node.js Version** to **22.x** (leave **Output Directory** unset). `vercel.json` pins Bun 1.4.5 via `bunx` for both install and build.
3. Attach `fleet.extoci.lol` to **Production** in **Settings → Domains** and configure the CNAME record shown by Vercel.

To verify the Vercel Build Output API bundle locally:

```sh
bun run build:vercel
bun run test:vercel
```

## Content and configuration

- `docs.json` owns navigation, branding, search, and footer links.
- `pages/index.mdx` renders `components/landing.tsx`; `pages/docs/` holds all guides.
- `style.css` is auto-loaded by Holocron and uses its public theme tokens.
- `public/` contains local SVG branding and the `/install`, `/install.sh`, and `/install.ps1` installer scripts.
