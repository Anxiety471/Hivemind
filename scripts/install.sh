#!/bin/sh
set -eu

REPO="${HIVEMIND_REPO:-Anxiety471/Hivemind}"
INSTALL_DIR="${HIVEMIND_INSTALL_DIR:-${HOME}/.local/bin}"
VERSION="${HIVEMIND_VERSION:-latest}"

fail() {
  printf 'hivemind installer: %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

os="$(uname -s)"
arch="$(uname -m)"

case "$os:$arch" in
  Linux:x86_64|Linux:amd64)
    target="x86_64-unknown-linux-gnu"
    ;;
  *)
    fail "unsupported platform: $os $arch (currently supported: Linux x86_64)"
    ;;
esac

asset="hivemind-${target}.tar.gz"

if [ "$VERSION" = "latest" ]; then
  base_url="https://github.com/${REPO}/releases/latest/download"
else
  base_url="https://github.com/${REPO}/releases/download/${VERSION}"
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

printf 'Downloading Hivemind (%s)...\n' "$target"
curl -fL --retry 3 --retry-delay 1   -o "$tmp_dir/$asset"   "$base_url/$asset"
curl -fL --retry 3 --retry-delay 1   -o "$tmp_dir/$asset.sha256"   "$base_url/$asset.sha256"

expected="$(awk '{print $1}' "$tmp_dir/$asset.sha256")"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp_dir/$asset" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp_dir/$asset" | awk '{print $1}')"
else
  fail "sha256sum or shasum is required to verify the download"
fi

[ "$expected" = "$actual" ] || fail "checksum verification failed"

tar -xzf "$tmp_dir/$asset" -C "$tmp_dir"

mkdir -p "$INSTALL_DIR"
cp "$tmp_dir/hivemind" "$INSTALL_DIR/hivemind"
chmod 0755 "$INSTALL_DIR/hivemind"

printf 'Installed Hivemind to %s/hivemind\n' "$INSTALL_DIR"

case ":${PATH:-}:" in
  *":$INSTALL_DIR:"*)
    printf 'Run: hivemind --version\n'
    ;;
  *)
    printf '\n%s is not currently on PATH. Add this to your shell profile:\n' "$INSTALL_DIR"
    printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    ;;
esac
