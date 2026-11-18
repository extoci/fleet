# Fleet web

Fleet's landing page and v2 alpha documentation, built with [Holocron](https://github.com/remorses/holocron), React, and Vite. All site code and dependencies live in this directory; the Rust CLI and v2 runtime are unchanged.

## Develop

Requires Node.js 22.16 or later. From this directory:

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

## Content and configuration

- `docs.json` owns navigation, branding, search, and footer links.
- `pages/index.mdx` is the custom landing page; `pages/docs/` holds the guides.
- `style.css` is auto-loaded by Holocron and uses its public theme tokens.
- `public/` contains local SVG branding. Fonts are bundled by Holocron, not loaded from a third-party font CDN.

Holocron provides local search, light/dark mode, responsive documentation navigation, markdown page exports, `/llms.txt`, `/llms-full.txt`, and `/docs.zip`. Its hosted AI assistant is deliberately disabled: this site requires no API key and sends no assistant queries to a third party.

## Documentation source and release status

The documentation describes the v2 alpha in [the owner's draft PR](https://github.com/extoci/fleet/pull/2), currently on branch `t3/b5d508c5`. It intentionally does not import files from `v2/`: the site can build independently from main before the runtime PR lands. When runtime behavior changes, update the corresponding guides and installation branch together.

The root Rust CLI and `fleet.sh` are v1. Do not point v2 onboarding at that installer or claim a published v2 package. Keep the native-installation and real-iPhone qualification warnings until there is device evidence. Landing-page windows are labeled illustrations, not a connected Fleet dashboard.
