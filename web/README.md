# Fleet web

Fleet's landing page and v2 alpha documentation, built with [Holocron](https://github.com/remorses/holocron), React, and Vite. All site code and dependencies live in this directory; the Rust CLI and v2 runtime are unchanged.

## Develop

Requires Node.js 22.16 or later in the 22.x line. The major version is pinned to match the Vercel function runtime. From this directory:

```sh
npm ci
npm run dev
```

Vite prints the local development address. The dev command binds to all interfaces for VM previews; do not expose it publicly as a production server.

## Check and build

```sh
npm run check
npm test
npm run build
npm run test:production
```

`check` verifies navigation coverage, page metadata, and local link targets. Unit tests cover those checks. The production smoke test starts the built Node server on an unused loopback port, fetches every page, checks headings and metadata, validates the `/docs` redirect and 404 response, and verifies markdown, sitemap, and agent exports. It shuts the server down afterward. This is HTTP testing, not browser or accessibility qualification.

Holocron also validates internal links and MDX during the build. The lockfile pins the dependency tree. An override keeps Tailwind Typography's selector parser on the patched 6.x release; review it when updating Holocron.

## Serve the production build

```sh
npm run build
npm start
```

The production Node server listens on port 3000 by default; set `PORT` in the environment to change it. This is a server-rendered site, **not** a static `dist/` folder for GitHub Pages. Use a Node-capable host and a reverse proxy for public TLS. No deployment, DNS changes, or hosting account is configured by this project.

## Deploy to Vercel

1. Open [New Project](https://vercel.com/new), import `extoci/fleet`, and use `main` as the production branch.
2. Set **Root Directory** to `web`, **Framework Preset** to **Other**, and **Node.js Version** to **22.x**. The committed `vercel.json` supplies **Install Command** `npm ci` and **Build Command** `npm run build:vercel`. Leave **Output Directory** unset (Override off), not `dist` or `dist/client`. No application secrets or custom environment variables are required.
3. Deploy and check the generated `*.vercel.app` address, including `/docs/quickstart`. The build enables Holocron's bundled Spiceflow Vercel adapter, which emits `.vercel/output/config.json`, CDN assets, and a streaming Node function. Vercel consumes this Build Output API directory automatically; there is no `npm start` command on Vercel.
4. Open the project's **Settings → Domains**, add `fleet.extoci.lol`, and connect it to **Production**.
5. At the DNS provider for `extoci.lol`, add a **CNAME** record with **Name** `fleet` and **Target** equal to the exact project-specific hostname Vercel displays for that domain. Use automatic/default TTL. Replace conflicting records for `fleet` only; do not change the apex or nameservers. If Vercel requests a verification TXT record, add the exact displayed name/value too. If using Cloudflare, start with **DNS only** (proxy off).
6. Wait for Vercel to show **Valid Configuration** and issue HTTPS, then open `https://fleet.extoci.lol` and a deep docs URL. Later pushes to `main` redeploy automatically.

The CNAME target is assigned by Vercel after the domain is added: do not guess a suffix, use a different project's target, or point DNS to the Fleet runtime. See Vercel's [domain guide](https://vercel.com/docs/domains/working-with-domains/add-a-domain) and [Build Output API](https://vercel.com/docs/build-output-api).

To check the deployment bundle locally:

```sh
npm run build:vercel
npm run test:vercel
```

The check validates the output layout and runs the packaged function's fetch handler against every docs page, markdown exports, redirects, missing routes, and agent exports. It does not deploy to Vercel or qualify the hosted function/CDN, custom DNS, or TLS.

## Content and configuration

- `docs.json` owns navigation, branding, search, and footer links.
- `pages/index.mdx` imports `components/landing.tsx`; `pages/docs/` holds the guides. Keep styled landing links in TSX: Holocron's Markdown link renderer does not preserve MDX anchor classes.
- `style.css` is auto-loaded by Holocron and uses its public theme tokens.
- `public/` contains local SVG branding. Fonts are bundled by Holocron, not loaded from a third-party font CDN.

Holocron provides local search, light/dark mode, responsive documentation navigation, markdown page exports, `/llms.txt`, `/llms-full.txt`, and `/docs.zip`. Its hosted AI assistant is deliberately disabled: this site requires no API key and sends no assistant queries to a third party.

## Documentation source and release status

The documentation describes the alpha runtime in [`v2/`](../v2/) on `main`. It intentionally does not import runtime files, so the site can build independently. When runtime behavior changes, update the corresponding guides and installation instructions together.

The root Rust CLI and `fleet.sh` are v1. Do not point v2 onboarding at that installer or claim a published v2 package. Keep the native-installation and real-iPhone qualification warnings until there is device evidence. Landing-page windows are labeled illustrations, not a connected Fleet dashboard.
