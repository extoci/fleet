#!/usr/bin/env sh
set -eu

# Fleet's only shell component: download the native CLI and start setup.
REPOSITORY="${FLEET_GITHUB_REPOSITORY:-extoci/fleet}"
VERSION="${FLEET_VERSION:-latest}"
INSTALL_DIR="${FLEET_INSTALL_DIR:-$HOME/.local/bin}"

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

os=$(uname -s)
arch=$(uname -m)
case "$os/$arch" in
  Darwin/arm64) target=aarch64-apple-darwin ;;
  Darwin/x86_64) target=x86_64-apple-darwin ;;
  Linux/aarch64|Linux/arm64) target=aarch64-unknown-linux-gnu ;;
  Linux/x86_64|Linux/amd64) target=x86_64-unknown-linux-gnu ;;
  *) fail "unsupported platform: $os $arch" ;;
esac

has curl || fail "curl is required"
has tar || fail "tar is required"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

if [ -n "${FLEET_RELEASE_BASE:-}" ]; then
  base="$FLEET_RELEASE_BASE"
elif [ "$VERSION" = latest ]; then
  base="https://github.com/$REPOSITORY/releases/latest/download"
else
  base="https://github.com/$REPOSITORY/releases/download/$VERSION"
fi

printf 'Installing Fleet for %s…\n' "$target"
archive="fleet-$target.tar.gz"
curl -fsSL --retry 3 "$base/$archive" -o "$tmp/$archive"
curl -fsSL --retry 3 "$base/$archive.sha256" -o "$tmp/$archive.sha256"
if has sha256sum; then
  (cd "$tmp" && sha256sum -c "$archive.sha256") >/dev/null
elif has shasum; then
  (cd "$tmp" && shasum -a 256 -c "$archive.sha256") >/dev/null
else
  fail "sha256sum or shasum is required to verify the download"
fi
tar -xzf "$tmp/$archive" -C "$tmp"
mkdir -p "$INSTALL_DIR"
install -m 755 "$tmp/fleet" "$INSTALL_DIR/fleet"
printf 'Installed %s\n' "$INSTALL_DIR/fleet"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf 'Add %s to PATH to use Fleet in future shells.\n' "$INSTALL_DIR" ;;
esac

if [ "${FLEET_NO_INIT:-0}" != 1 ]; then
  "$INSTALL_DIR/fleet" init "$@"
fi
