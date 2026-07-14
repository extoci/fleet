#!/bin/sh
set -eu

REPOSITORY="${FLEET_REPOSITORY:-extoci/fleet}"
VERSION="${FLEET_VERSION:-latest}"
INSTALL_DIR="${FLEET_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  printf 'fleet installer: %s\n' "$*" >&2
  exit 1
}

command -v uname >/dev/null 2>&1 || fail "uname is required"
command -v install >/dev/null 2>&1 || fail "install is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) target="aarch64-apple-darwin" ;;
  Darwin:x86_64) target="x86_64-apple-darwin" ;;
  Linux:aarch64|Linux:arm64) target="aarch64-unknown-linux-gnu" ;;
  Linux:x86_64|Linux:amd64) target="x86_64-unknown-linux-gnu" ;;
  *) fail "unsupported platform: $(uname -s) $(uname -m)" ;;
esac

temporary="$(mktemp -d 2>/dev/null || mktemp -d -t fleet)"
installing=""
cleanup() {
  rm -rf "$temporary"
  if [ -n "$installing" ]; then
    rm -f "$installing"
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if [ -n "${FLEET_BINARY:-}" ]; then
  [ -x "$FLEET_BINARY" ] || fail "FLEET_BINARY is not executable: $FLEET_BINARY"
  source_binary="$FLEET_BINARY"
else
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  archive="fleet-$target.tar.gz"
  if [ "$VERSION" = latest ]; then
    base="https://github.com/$REPOSITORY/releases/latest/download"
  else
    base="https://github.com/$REPOSITORY/releases/download/$VERSION"
  fi
  printf 'Downloading Fleet for %s...\n' "$target"
  curl -fL --proto '=https' --tlsv1.2 "$base/$archive" -o "$temporary/$archive"
  curl -fL --proto '=https' --tlsv1.2 "$base/$archive.sha256" -o "$temporary/$archive.sha256"
  expected="$(awk '{print $1}' "$temporary/$archive.sha256")"
  case "$expected" in
    *[!0-9a-fA-F]*|'') fail "release checksum is invalid" ;;
  esac
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$temporary/$archive" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$temporary/$archive" | awk '{print $1}')"
  elif command -v openssl >/dev/null 2>&1; then
    actual="$(openssl dgst -sha256 "$temporary/$archive" | awk '{print $NF}')"
  else
    fail "sha256sum, shasum, or openssl is required to verify Fleet"
  fi
  [ "$expected" = "$actual" ] || fail "release checksum did not match"
  tar -xzf "$temporary/$archive" -C "$temporary"
  source_binary="$temporary/fleet"
  [ -x "$source_binary" ] || fail "release archive did not contain an executable named fleet"
fi

mkdir -p "$INSTALL_DIR"
installing="$INSTALL_DIR/.fleet.install.$$"
install -m 755 "$source_binary" "$installing"
mv "$installing" "$INSTALL_DIR/fleet"
installing=""

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    case "${SHELL:-}" in
      */zsh) rc="$HOME/.zshrc" ;;
      */bash) rc="$HOME/.bashrc" ;;
      *) rc="" ;;
    esac
    if [ -n "$rc" ]; then
      if [ "$INSTALL_DIR" = "$HOME/.local/bin" ]; then
        line='export PATH="$HOME/.local/bin:$PATH"'
      else
        line="export PATH=\"$INSTALL_DIR:\$PATH\""
      fi
      if ! grep -F "$line" "$rc" >/dev/null 2>&1; then
        {
          printf '\n# Fleet installer\n'
          printf '%s\n' "$line"
        } >>"$rc"
      fi
      printf 'Added %s to PATH in %s.\n' "$INSTALL_DIR" "$rc"
    else
      printf 'Add %s to PATH before running Fleet.\n' "$INSTALL_DIR"
    fi
    ;;
esac

printf 'Fleet installed at %s/fleet\n' "$INSTALL_DIR"
printf 'Run: fleet init   # on the captain\n'
printf ' or: fleet join   # on a member\n'
