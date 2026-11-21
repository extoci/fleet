# Releasing Fleet

GitHub Releases is Fleet's artifact origin, and `fleet.extoci.lol` serves the installer scripts directly from [`web/public/`](../web/public/).

Each GitHub Release publishes:

- `fleet.tar.gz` — self-contained Fleet source, templates, and pre-installed pure-JS production dependencies (no native addons)
- `fleet.tar.gz.sha256` — SHA-256 checksum verified by the installer
- `install.sh` (and a copy named `fleet.sh` for legacy redirect compatibility)
- `install.ps1` — Windows PowerShell installer

## Installing Fleet

**macOS and Linux:**

```sh
curl -fsSL https://fleet.extoci.lol/install | bash
```

**Windows (PowerShell):**

```powershell
irm https://fleet.extoci.lol/install.ps1 | iex
```

The installer ensures Bun 1.4+ is installed, downloads `fleet.tar.gz` and `fleet.tar.gz.sha256` from the latest GitHub Release, verifies the SHA-256 digest, unpacks Fleet atomically into `~/.fleet/runtime`, and installs the `fleet` command on your `PATH`.

To install a specific release or roll back:

```sh
curl -fsSL https://fleet.extoci.lol/install | FLEET_VERSION=v2.0.0 bash
```

To install directly from the `main` branch (for testing unreleased changes):

```sh
curl -fsSL https://fleet.extoci.lol/install | FLEET_VERSION=main bash
```

## Publishing a release

Start from a clean `main` branch with green CI:

1. Update `"version"` in [`package.json`](../package.json).
2. If [`install.sh`](../install.sh) or [`install.ps1`](../install.ps1) changed, sync the copies in `web/public/`:

   ```sh
   cp install.sh web/public/install
   cp install.sh web/public/install.sh
   cp install.ps1 web/public/install.ps1
   ```

3. Run all checks locally:

   ```sh
   bun run typecheck
   bun run format:check
   bun test
   ```

4. Commit, tag, and push:

   ```sh
   git add package.json
   git commit -m "release: fleet 2.0.0"
   git push origin main

   git tag -a v2.0.0 -m "Fleet 2.0.0"
   git push origin v2.0.0
   ```

Pushing a `v*` tag triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml):

1. Confirms the tag matches `package.json`'s `version`.
2. Runs typechecking (`bun check`), formatting (`bun fmt --check`), linting (`bun lint`), and the full test suite (`bun test`).
3. Builds `fleet.tar.gz` with production dependencies (`bun install --production --frozen-lockfile`) and generates `fleet.tar.gz.sha256`.
4. Smoke-tests `install.sh` against the packaged archive and checksum in an isolated `HOME`.
5. Publishes the GitHub Release with generated release notes and all assets.

Treat releases and tags as immutable — if a release has a bug, cut a new patch version rather than replacing published assets.
