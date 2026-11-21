# AGENTS.md

Instructions for agents working on `extoci/fleet` (Fleet v2). App-level instructions written by `fleet init` live separately in `src/cli.ts` and `templates/`.

## Product Scope & Non-Goals

- **What Fleet is:** A personal app platform that runs small apps on the owner's own computers over their Tailscale tailnet, signed in via Fleet Gate (`https://gate.fleet`). Whichever computer holds the checkout hosts the app.
- **Literal `.fleet` URLs are non-negotiable:** Every supported device, including iPhone Safari, opens apps at `https://<app>.fleet`. Reserve `.ts.net` URLs strictly for temporary setup and certificate bootstrap—never propose `.ts.net` app URLs or public wildcard domains.
- **Hard non-goals (do not propose or add):** Public app hosting, Tailscale Funnel, guest invites, teams/organizations, a hosted control plane, a custom VPN fabric, automatic host placement, or separate dev/prod deploy modes.
- **Core runtime behavior:** Rebuild on save, keep serving the last good build when a rebuild fails, idle-unload workers, and run scheduled jobs without an open browser.
- **Self-guiding UX:** Automate setup wherever permissions allow and hide DNS/CA/proxy internals unless needed. Never alter unrelated Tailscale DNS or Serve config. When an external step can prompt or requires manual action (e.g., `tailscale serve`, `tailscale set --operator`, iOS profile install + full certificate trust), stream subprocess output and print the exact command or steps instead of swallowing prompts or failing vaguely.

## Isolated Development & Live Daemon Safety

- **Never touch the user's running Fleet daemon**—do not start, stop, restart, or upgrade it, mutate live app data, or change host trust, DNS, or Tailscale settings without explicit authorization.
- Run tests and previews against a temporary `FLEET_V2_HOME`, loopback, and ephemeral ports (and temporary `HOME` / cert DB for installer and browser tests).
- State lookup order is `FLEET_V2_HOME` → `FLEET_HOME` → `~/.fleet/v2`. Set `FLEET_V2_HOME` explicitly before running any command that may write state.
- When authorized to debug a live upgrade, inspect the running process's actual entrypoint and invoke a real API op—a stale daemon after an entrypoint move can still serve static app HTML while 500ing every operation.

## Packages, Tooling & Checks

Root (`@extoci/fleet`) and `web/` (`@extoci/fleet-web`, `fleet.extoci.lol`) are **separate packages with separate lockfiles**, not a Bun workspace. Both pin **Bun 1.4.5** (`packageManager`); run `bun install --frozen-lockfile` in whichever package you work on.

### Root package (`/`)

```sh
bun run typecheck
bun run format:check
bun run lint -- --max-warnings 0
bun test ./test
```

- `src/cli.ts` runs directly under Bun. Keep explicit `.ts` import extensions, use `with { type: "json" }` for JSON imports, and keep runtime dependencies free of native addons.
- Always run lint via `bun run lint -- --max-warnings 0` (`scripts/lint.ts` probes native `bun lint` and falls back to `bunx bun@canary lint` on 1.4.5; calling `bun lint` directly can recurse into the package script).
- Run `bun run format` from the package you edited. Root `bunfig.toml` uses double quotes, width 100, and excludes `web/` and `templates/`. `web/bunfig.toml` uses single quotes and omits semicolons in TS/TSX—**never run root formatting on `web/`**. Keep `embeddedLanguageFormatting: "off"` so MDX frontmatter and fenced examples are untouched.

### Website (`web/`, requires Node `^22.16.0`)

```sh
bun run check
bun run typecheck
bun run format:check
bun run lint -- --max-warnings 0
bun test
bun run build
bun run test:production
bun run build:vercel
bun run test:vercel
```

- Keep Vite for Holocron/React/Spiceflow; `bun build` cannot replace its plugin hooks and SSR dependency tracing.
- Serve production with `bun run start` (`node dist/rsc/index.js`). Spiceflow's generated entrypoint double-binds under Bun.
- `bun run dev` clears `web/dist/`—always rebuild before testing production output.
- Keep `scheduler` bundled into SSR (the tracer misses its generated require). Always run `test:vercel` after `build:vercel`: it executes the packaged function outside the checkout where local `node_modules` cannot mask a missing dependency.
- Update `web/scripts/check-production.mjs` whenever landing markup changes, and never commit `web/dist/` or `web/.vercel/`.

## Runtime Contracts

- **Single Preact instance:** Resolve app imports of `preact`, `react`/`react-dom` (`preact/compat`), JSX runtimes, and `fleet/client` through Fleet's pinned Preact. A duplicate Preact bundle silently crashes hooks (`__H`) into a blank page while builds and logs look green.
- **Database & transactions:** Preserve `ctx.db.get` returning `T | null`, `ctx.db.delete` returning `boolean`, and `ctx.db.list(prefix)` capping at 1,000 entries. Mutations and jobs run serialized inside `BEGIN IMMEDIATE` and roll back all writes if they throw; read-only queries run on a second WAL connection so reads stay concurrent with active writes.
- **Worker lifecycle:** Track `worker.terminate()` by `app.id`. Clear `app.worker` immediately on unload so pending calls reject right away, but await the old worker's exit before opening the replacement's SQLite connections and verify the worker is still current before `postMessage`.
- **Jobs:** Preserve `ctx.runId` when retrying an interrupted job so apps can use it as an idempotency key.
- **Backups & restore:** Export via SQLite's backup API and switch the snapshot to `journal_mode=DELETE` before publishing a single-file backup (WAL files break macOS restores with `SQLITE_CANTOPEN`). Stage inputs before restore, leave the caller's backup untouched, and reject restores while the daemon can still write.
- **Template & docs sync:** When runtime or client APIs change (including `useQuery`/`useMutation`/`call` options such as `pollMs`, `invalidate`, `keepalive`), update `templates/fleet.d.ts`, scaffold files, the app instructions in `src/cli.ts`, and `web/` docs in the same change.
- **Permissions:** Create scaffolded project files with standard permissions, private state/secrets with `0600` (files) and `0700` (dirs) on POSIX, and keep `.env.fleet.server` server-only.
- **CLI ergonomics:** Keep stdout scannable and within terminal width; keep `--json` and single-line `--version` machine-readable; strip ANSI when piped or under `NO_COLOR`/`TERM=dumb`; route verbose diagnostics to `fleet logs`; enforce deadlines on subprocesses and network calls so commands never hang.

## Verification & Cross-Platform CI

- Verify changes through the real path—run the actual CLI, sign in through Gate in a browser, or run the packaged release/Vercel artifact—not mocks alone. Assert both HTTP status and response body in tests so failures aren't masked.
- For app boot, client hook, or Gate sign-in changes, run `bun test ./test/browser.test.ts` with both `FLEET_BROWSER_EXECUTABLE` and `FLEET_CERTUTIL` set (it skips silently if either is unset).
- Never claim mobile DNS, cert, or Safari sign-in works without testing on a real iPhone in Safari—a mobile-sized Chromium viewport only checks layout.
- Reproduce bugs before fixing them and add a focused regression test whenever the existing suite would have missed the failure.
- CI runs on **Linux, macOS, and Windows**: enforce LF line endings (`.gitattributes`), use `path.posix` for generated Linux/systemd paths, guard POSIX mode assertions with `process.platform !== "win32"`, and drive runtime ticks/timers directly in tests instead of racing `fs.watch` latency (especially macOS FSEvents).

## Interface, Brand & Copy

- **Brand:** Purple Bayer 8×8 dithered Plumbob (`#33175c → #6d3fd1 → #a873fa → #e6d1ff`). Preserve the `1.28×` optical icon scale and `viewBox="2 3.5 75 25"` on wordmark SVGs.
- **Typography:** Geist for wordmark and body, Geist Pixel Square for display headings. Keep vendored `.woff2` files and SIL OFL notices alongside assets (`src/assets/`, `web/licenses/`); source from the `geist` npm package (not Google Fonts).
- **Minimalism:** Dark-first `#090909` / light `#fafafa`, monochrome buttons, violet reserved for focus rings and dither. If a badge, heading, or line of muted copy can be removed without making the page worse, remove it. Keep copy direct and free of marketing fluff.
- **Accessibility & motion:** Minimum `16px` for body copy and form inputs (existing small secondary labels excepted unless redesigned), WCAG AA contrast, `:focus-visible` parity with hover, and a single static frame for `prefers-reduced-motion`. Gate guide-row WebGL loops on visibility plus hover/focus, and skip row canvases entirely on `(hover: none)` devices.

## Git, PRs & Releases

- Work on branches and open focused PRs—do not leave large changes uncommitted on `main`. Push completed commits early on long runs so interruptions don't strand work.
- Use `area: description` commit subjects (`cli:`, `gate:`, `web:`, `fix(v2):`, `feat:`, `ci:`). Squash-merge only when all CI checks are green.
- **Stacked PRs:** Retarget dependent PRs _before_ deleting a merged base branch, or GitHub will auto-close them.
- **Zero PII in public GitHub:** Never put private app names, personal hostnames, tailnet domains, credentials, or personal data in public PRs, tests, fixtures, or screenshots. Host PR screenshots on the `swf-pr-assets` branch under `pr-<n>/`.
- **Installer parity:** `test/installer.test.ts` enforces that `web/public/install` and `web/public/install.sh` are byte-identical to `install.sh`, and `web/public/install.ps1` is byte-identical to `install.ps1`. Keep the `fleet.sh` release asset alias for legacy redirects.
- **Releases:** Follow [docs/releasing.md](docs/releasing.md)—bump `package.json`, sync `web/public/` installers, run all checks, commit `release: fleet X.Y.Z` on green `main`, push the commit and annotated `vX.Y.Z` tag, and verify published assets. Never rewrite a published tag; fix mistakes with a new patch release.
- **Parallel agents & cleanup:** Use separate worktrees (or explicitly disjoint file scopes in a shared checkout) when running parallel agents, and remove temporary processes, scratch files, backups, and ignored outputs before handoff.

## Working Style & Handoff

- Lead with a tight TL;DR, followed by short bullets for what ran, what wasn't tested, and any decisions needed (≤4 concrete options). Avoid walls of text.
- Infer sensible, reversible defaults rather than asking low-level questions; surface real tradeoffs and explain large deletions clearly before acting.
