# Releasing Fleet

GitHub Releases is Fleet's artifact origin. Each release contains native binaries
for the four supported OS/architecture pairs, SHA-256 checksums, and a copy of
the installer. The friendly `extoci.lol/fleet.sh` URL should redirect to the
installer attached to the latest GitHub release.

## One-time setup

1. Keep the repository public. Standard GitHub-hosted macOS, Linux x86-64, and
   Linux ARM64 runners are then free, so a separate runner provider is not
   necessary.
2. In the repository's Actions settings, allow GitHub Actions to create and
   approve pull requests only if desired; the release workflow needs only the
   scoped `contents: write` permission declared on its publish job.
3. Configure an HTTP 302 redirect (for example, with a Cloudflare Redirect Rule)
   from:

       https://extoci.lol/fleet.sh

   to:

       https://github.com/extoci/fleet/releases/latest/download/fleet.sh

   Preserve the query string. Do not cache the redirect permanently: GitHub's
   `latest` target changes after every release.

Users can then install or update Fleet with:

```sh
curl -fsSL https://extoci.lol/fleet.sh | sh
```

The installer detects the platform, downloads the matching archive and checksum
from GitHub Releases, verifies SHA-256, and atomically installs the binary at
`~/.local/bin/fleet`.

## Publish a release

Start from a clean `main` branch whose CI is green:

```sh
# Choose the new version.
cargo install cargo-edit       # once, if cargo-set-version is unavailable
cargo set-version 0.3.0

# Update changelog.md, then commit the version and lockfile.
git add Cargo.toml Cargo.lock changelog.md
git commit -m "release: fleet 0.3.0"
git push origin main

# The tag is the deployment trigger.
git tag -a v0.3.0 -m "Fleet 0.3.0"
git push origin v0.3.0
```

The release workflow first rejects a tag that does not match `Cargo.toml`, then
runs formatting, Clippy, and tests. It builds on native GitHub-hosted runners for:

- `aarch64-apple-darwin`
- `x86_64-apple-darwin`
- `aarch64-unknown-linux-gnu`
- `x86_64-unknown-linux-gnu`

Only after all four builds succeed does one publish job create the GitHub
Release and upload all artifacts. GitHub generates release notes from merged
changes. A failed build therefore cannot produce a partial release.

## Versions, updates, and rollback

Running the installer again updates an existing installation to the latest
release. To install or roll back to an exact release:

```sh
curl -fsSL https://extoci.lol/fleet.sh | FLEET_VERSION=v0.2.0 sh
```

Releases and tags should be treated as immutable. If a release is bad, publish a
new patch version rather than replacing its assets. GitHub's `latest` URL, and
therefore `extoci.lol/fleet.sh`, will move to the new patch automatically.

The CLI currently exposes `fleet update` but does not implement it. Until that
command is implemented, rerunning the installer is the supported update path.
