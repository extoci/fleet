# Fleet web

Fleet's landing page and v2 alpha documentation use Holocron, React, and Vite. Run the website commands in `web/`. [Holocron](https://github.com/remorses/holocron)

## Develop

Use Bun 1.4.5 for installs, checks, formatting, tests, and Vite. Use Node.js 22.16 or later in the 22.x line to serve and smoke-test the production builds.

```sh
bun install --frozen-lockfile
bun run dev
```

Vite prints the local development address. The dev command binds to all interfaces for VM previews; do not expose it publicly as a production server.

## Check and build

```sh
bun run check
bun run check:types
bun run format:check
bun test
bun run build
bun run test:production
```

`bun run check` validates navigation coverage, page metadata, and local links. `bun run check:types` runs Bun's native TypeScript checker on `vite.config.ts` and `components/`. Bun 1.4.0 has no native type checker or formatter. Bun added `bun check` in 1.4.3 and `bun fmt` in 1.4.4. `bun format` runs the `format` script in `package.json`. [Bun 1.4.3](https://bun.com/blog/release-notes/bun-v1.4.3) · [Bun 1.4.4](https://bun.com/blog/release-notes/bun-v1.4.4)

Run `bun run format` to apply formatting. The formatter leaves embedded languages alone to preserve the quoted MDX frontmatter and code examples. `bun test` runs the content tests. The production smoke test starts the built Node server on loopback and checks all pages, redirects, missing routes, assets, and exports over HTTP.

`bun.lock` pins the dependency tree. The Tailwind Typography override pins `postcss-selector-parser` to 6.1.5. Review it when you update Holocron.

### Build requirements

Vite runs on Bun and loads `vite.config.ts` directly with `--configLoader native`. Vite skips the gzip size report. Minification and the generated assets still go through Vite and Rolldown. [Vite config loading](https://vite.dev/config/) · [Vite build options](https://vite.dev/config/build-options.html#build-reportcompressedsize)

Holocron reads `docs.json` and the MDX pages in Vite plugin hooks. It validates content and creates virtual modules for routes, the search index, and exports. Spiceflow and Vite build the RSC, SSR, and browser environments and connect their React references. Spiceflow then traces dependencies for the standalone Node server or the Vercel function. A direct `bun build pages/index.mdx` emits an MDX asset and a JavaScript stub. It does not run those Vite hooks or produce a deployable site. [Holocron source](https://github.com/remorses/holocron) · [Spiceflow source](https://github.com/remorses/spiceflow) · [Bun bundler](https://bun.com/docs/bundler)

### Build and check timings

Measured on Linux x64 with a Ryzen 5 3400G and Node.js 22.23.1. The baseline is commit `687b859` with npm 10.9.8. The updated commands use Bun 1.4.5. Dependencies were already installed, and Holocron could reuse its content cache. These are median wall times from four measured runs per build command and 15 runs per check or test command after a warm-up. Each before-and-after pair alternated order.

| Task                             |  Before |  After | Less time |
| -------------------------------- | ------: | -----: | --------: |
| Local build                      | 10.37 s | 7.16 s |       31% |
| Vercel build on the same machine | 10.16 s | 7.31 s |       28% |
| Content check                    |  282 ms |  50 ms |       82% |
| Content tests                    |  408 ms |  88 ms |       78% |

The added TypeScript check took 78 ms. The formatting check took 25 ms. Vercel reported 31 seconds for each of the two hosted builds, with install included. The first used npm and had no build cache. The second used Bun and Vercel skipped the npm cache because the package manager changed.

## Serve the production build

```sh
bun run build
bun run start
```

The production server runs on Node.js and listens on port 3000 by default. Set `PORT` in the environment to change it. The generated entry point starts a Node HTTP server and exports a fetch handler. Bun also tries to serve the export when it runs the entry point directly, which causes a port conflict. Use a Node-capable host to serve this build.

## Deploy to Vercel

1. Open [New Project](https://vercel.com/new), import `extoci/fleet`, and use `main` as the production branch.
2. Set **Root Directory** to `web`, **Framework Preset** to **Other**, and **Node.js Version** to **22.x**. Leave **Output Directory** unset. `vercel.json` pins Bun 1.4.5 with `bunx` for both install and build. The install uses `--frozen-lockfile`. Bun 1.3.14 rejects version 3 of `bun.lock`. [Vercel package managers](https://vercel.com/docs/package-managers#pinning-a-bun-version)
3. Deploy and check the generated `*.vercel.app` address, including `/docs/quickstart`. `build:vercel` sets `VERCEL=1` to enable the Spiceflow adapter. Vercel reads `.vercel/output/config.json` for routing, serves `.vercel/output/static` through its CDN, and sends other requests to the streaming Node.js 22 function at `.vercel/output/functions/index.func`. [Vercel Build Output API](https://vercel.com/docs/build-output-api) · [Vercel function layout](https://vercel.com/docs/build-output-api/primitives)
4. Open the project's **Settings → Domains**, add `fleet.extoci.lol`, and connect it to **Production**.
5. At the DNS provider for `extoci.lol`, add a **CNAME** record with **Name** `fleet` and **Target** equal to the exact project-specific hostname Vercel displays for that domain. Use automatic/default TTL. Replace conflicting records for `fleet` only; do not change the apex or nameservers. If Vercel requests a verification TXT record, add the exact displayed name/value too. If using Cloudflare, start with **DNS only** (proxy off).
6. Wait for Vercel to show **Valid Configuration** and issue HTTPS, then open `https://fleet.extoci.lol` and a deep docs URL. Later pushes to `main` redeploy automatically.

The CNAME target is assigned by Vercel after the domain is added: do not guess a suffix, use a different project's target, or point DNS to the Fleet runtime. See Vercel's [domain guide](https://vercel.com/docs/domains/working-with-domains/add-a-domain) and [Build Output API](https://vercel.com/docs/build-output-api).

To check the deployment bundle locally:

```sh
bun run build:vercel
bun run test:vercel
```

The smoke test checks the Build Output API layout and copies the function to a temporary directory before calling its fetch handler under Node.js. This limits dependency resolution to the packaged function. Spiceflow's tracer missed Rolldown's `__require('scheduler')` call, which caused HTTP 500 on the hosted HTML routes. The Vite config bundles `scheduler` into SSR so the function can render with its own files.

After you deploy, check the landing page, a deep docs route, and their assets at the production `*.vercel.app` address. `vercel inspect <deployment> --logs` shows the build log. Use `vercel logs --environment production` for request errors. [Vercel CLI inspect](https://vercel.com/docs/cli/inspect) · [Vercel runtime logs](https://vercel.com/docs/logs/runtime)

## Content and configuration

- `docs.json` owns navigation, branding, search, and footer links.
- `pages/index.mdx` imports `components/landing.tsx`; `pages/docs/` holds the guides. Keep styled landing links in TSX: Holocron's Markdown link renderer does not preserve MDX anchor classes.
- `style.css` is auto-loaded by Holocron and uses its public theme tokens.
- `public/` contains local SVG branding. Fonts are bundled by Holocron, not loaded from a third-party font CDN.

Holocron provides local search, light/dark mode, responsive documentation navigation, markdown page exports, `/llms.txt`, `/llms-full.txt`, and `/docs.zip`. Its hosted AI assistant is deliberately disabled: this site requires no API key and sends no assistant queries to a third party.

## Documentation source and release status

The documentation describes the alpha runtime in [`v2/`](../v2/) on `main`. It intentionally does not import runtime files, so the site can build independently. When runtime behavior changes, update the corresponding guides and installation instructions together.

The root Rust CLI and `fleet.sh` are v1. Do not point v2 onboarding at that installer or claim a published v2 package. Keep the native-installation and real-iPhone qualification warnings until there is device evidence. Landing-page windows are labeled illustrations, not a connected Fleet dashboard.
