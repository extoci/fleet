#!/bin/sh
set -eu

REPOSITORY="${FLEET_REPOSITORY:-extoci/fleet}"
VERSION="${FLEET_VERSION:-latest}"
INSTALL_DIR="${FLEET_INSTALL_DIR:-}"
APP_DIR="${FLEET_APP_DIR:-$HOME/.fleet/runtime}"
NO_INSTALL_BUN="${FLEET_NO_INSTALL_BUN:-0}"

fail() {
  printf 'fleet installer: %s\n' "$*" >&2
  exit 1
}

quote_sh() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

verify_sha256() {
  archive_file="$1"
  checksum_file="$2"
  expected="$(awk '{print $1}' "$checksum_file")"
  case "$expected" in
    *[!0-9a-fA-F]*|'') fail "release checksum is invalid" ;;
  esac
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$archive_file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$archive_file" | awk '{print $1}')"
  elif command -v openssl >/dev/null 2>&1; then
    actual="$(openssl dgst -sha256 "$archive_file" | awk '{print $NF}')"
  else
    fail "sha256sum, shasum, or openssl is required to verify Fleet"
  fi
  [ "$expected" = "$actual" ] || fail "release checksum did not match"
}

find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  if [ -x "$HOME/.bun/bin/bun" ]; then
    printf '%s\n' "$HOME/.bun/bin/bun"
    return 0
  fi
  return 1
}

check_bun_version() {
  bun_exe="$1"
  raw_version="$("$bun_exe" --version 2>/dev/null || true)"
  major="$(printf '%s' "$raw_version" | cut -d. -f1)"
  minor="$(printf '%s' "$raw_version" | cut -d. -f2)"
  case "$major:$minor" in
    ''|*[!0-9:]*) fail "could not determine Bun version from $bun_exe" ;;
  esac
  if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 4 ]; }; then
    fail "Bun 1.4.0 or later is required (found $raw_version). Run: bun upgrade"
  fi
}

command -v uname >/dev/null 2>&1 || fail "uname is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

case "$(uname -s):$(uname -m)" in
  Darwin:arm64|Darwin:x86_64|Linux:aarch64|Linux:arm64|Linux:x86_64|Linux:amd64) ;;
  *) fail "unsupported platform: $(uname -s) $(uname -m)" ;;
esac

if [ -z "$INSTALL_DIR" ]; then
  preferred="$HOME/.local/bin"
  case ":$PATH:" in
    *":$preferred:"*) INSTALL_DIR="$preferred" ;;
    *)
      old_ifs=$IFS
      IFS=:
      for directory in $PATH; do
        case "$directory" in
          "$HOME"/*|/usr/local/bin|/opt/homebrew/bin)
            if [ -d "$directory" ] && [ -w "$directory" ]; then
              INSTALL_DIR="$directory"
              break
            fi
            ;;
        esac
      done
      IFS=$old_ifs
      INSTALL_DIR="${INSTALL_DIR:-$preferred}"
      ;;
  esac
fi

bun_bin="$(find_bun || true)"
if [ -z "$bun_bin" ]; then
  if [ "$NO_INSTALL_BUN" = "1" ]; then
    fail "Bun 1.4.0 or later is required. Install it from https://bun.com"
  fi
  command -v curl >/dev/null 2>&1 || fail "curl is required to install Bun"
  printf 'Installing Bun...\n'
  curl -fsSL --proto '=https' --tlsv1.2 https://bun.sh/install | bash
  bun_bin="$(find_bun || true)"
  [ -n "$bun_bin" ] || fail "Bun was installed, but the bun executable could not be found"
fi
check_bun_version "$bun_bin"

temporary="$(mktemp -d 2>/dev/null || mktemp -d -t fleet)"
installing=""
staging_dir=""
cleanup() {
  rm -rf "$temporary"
  if [ -n "$installing" ]; then
    rm -f "$installing"
  fi
  if [ -n "$staging_dir" ]; then
    rm -rf "$staging_dir"
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

archive_path="$temporary/fleet.tar.gz"
if [ -n "${FLEET_ARCHIVE:-}" ]; then
  [ -f "$FLEET_ARCHIVE" ] || fail "FLEET_ARCHIVE does not exist: $FLEET_ARCHIVE"
  cp "$FLEET_ARCHIVE" "$archive_path"
  if [ -f "${FLEET_ARCHIVE}.sha256" ]; then
    verify_sha256 "$archive_path" "${FLEET_ARCHIVE}.sha256"
  fi
elif [ "$VERSION" = "main" ]; then
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  printf 'Downloading Fleet from %s (main)...\n' "$REPOSITORY"
  curl -fL --proto '=https' --tlsv1.2 \
    "https://github.com/$REPOSITORY/archive/refs/heads/main.tar.gz" \
    -o "$archive_path"
else
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  if [ "$VERSION" = "latest" ]; then
    base="https://github.com/$REPOSITORY/releases/latest/download"
  else
    base="https://github.com/$REPOSITORY/releases/download/$VERSION"
  fi
  printf 'Downloading Fleet (%s)...\n' "$VERSION"
  if ! curl -fL --proto '=https' --tlsv1.2 "$base/fleet.tar.gz" -o "$archive_path"; then
    if [ "$VERSION" = "latest" ]; then
      fail "could not download the latest Fleet release archive. To install from main instead, run: curl -fsSL https://fleet.extoci.lol/install | FLEET_VERSION=main bash"
    fi
    fail "could not download Fleet release $VERSION"
  fi
  curl -fL --proto '=https' --tlsv1.2 "$base/fleet.tar.gz.sha256" -o "$archive_path.sha256"
  verify_sha256 "$archive_path" "$archive_path.sha256"
fi

unpack_dir="$temporary/unpack"
mkdir -p "$unpack_dir"
tar -xzf "$archive_path" -C "$unpack_dir"

source_root=""
if [ -f "$unpack_dir/package.json" ] && [ -f "$unpack_dir/src/cli.ts" ]; then
  source_root="$unpack_dir"
else
  for candidate in "$unpack_dir"/*; do
    if [ -d "$candidate" ] && [ -f "$candidate/package.json" ] && [ -f "$candidate/src/cli.ts" ]; then
      source_root="$candidate"
      break
    fi
  done
fi
[ -n "$source_root" ] || fail "archive did not contain Fleet (missing package.json or src/cli.ts)"

if [ ! -d "$source_root/node_modules/preact" ]; then
  printf 'Installing Fleet runtime dependencies with Bun...\n'
  (cd "$source_root" && "$bun_bin" install --production --frozen-lockfile)
fi
printf '%s\n' "$REPOSITORY" > "$source_root/.fleet-release"

mkdir -p "$(dirname "$APP_DIR")"
staging_dir="${APP_DIR}.staging.$$"
rm -rf "$staging_dir"
mv "$source_root" "$staging_dir"

backup_dir=""
if [ -e "$APP_DIR" ]; then
  backup_dir="${APP_DIR}.old.$$"
  rm -rf "$backup_dir"
  mv "$APP_DIR" "$backup_dir"
fi

if ! mv "$staging_dir" "$APP_DIR"; then
  if [ -n "$backup_dir" ] && [ -e "$backup_dir" ]; then
    mv "$backup_dir" "$APP_DIR" || true
  fi
  fail "could not install Fleet runtime into $APP_DIR"
fi
staging_dir=""
if [ -n "$backup_dir" ]; then
  rm -rf "$backup_dir"
fi

mkdir -p "$INSTALL_DIR"
installing="$INSTALL_DIR/.fleet.install.$$"
quoted_bun="$(quote_sh "$bun_bin")"
quoted_cli="$(quote_sh "$APP_DIR/src/cli.ts")"
cat >"$installing" <<EOF
#!/bin/sh
set -eu
FLEET_BUN=$quoted_bun
if [ ! -x "\$FLEET_BUN" ]; then
  FLEET_BUN="\$(command -v bun 2>/dev/null || true)"
fi
if [ -z "\$FLEET_BUN" ]; then
  printf 'fleet: Bun is required. Install it from https://bun.com\n' >&2
  exit 1
fi
exec "\$FLEET_BUN" $quoted_cli "\$@"
EOF
chmod 755 "$installing"
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
      printf 'Added %s to PATH in %s for future terminals.\n' "$INSTALL_DIR" "$rc"
      printf 'To use Fleet in this shell right now, run:\n'
      printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    else
      printf 'Add %s to PATH before running Fleet.\n' "$INSTALL_DIR"
    fi
    ;;
esac

installed_version="$("$INSTALL_DIR/fleet" --version 2>/dev/null || printf 'Fleet')"
printf '%s installed at %s/fleet\n' "$installed_version" "$INSTALL_DIR"
printf '\nNext steps:\n'
printf '  fleet setup --install\n'
printf '  fleet init notes\n'
printf '  fleet open notes\n'
