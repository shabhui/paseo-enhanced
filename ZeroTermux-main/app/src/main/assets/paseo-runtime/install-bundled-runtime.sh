#!/data/data/com.paseoe/files/usr/bin/bash
set -eu

APP_DIR="$HOME/.paseo-app"
MARKER="$APP_DIR/runtime-version"
RUNTIME_DIR="$APP_DIR/runtime"
PACKAGES_DIR="$RUNTIME_DIR/packages"
RUNTIME_VERSION="paseo-0.3.1-arm64-v2"

if [ "$(cat "$MARKER" 2>/dev/null || true)" = "$RUNTIME_VERSION" ] && command -v node >/dev/null 2>&1 && command -v paseo >/dev/null 2>&1; then
    exit 0
fi

while read -r expected relative; do
    [ -z "$expected" ] && continue
    payload="$PACKAGES_DIR/$relative"
    [ -f "$payload" ] || { echo "Missing bundled runtime payload: $relative" >&2; exit 1; }
    actual="$(sha256sum "$payload" | cut -d ' ' -f 1)"
    [ "$actual" = "$expected" ] || { echo "Invalid bundled runtime payload: $relative" >&2; exit 1; }
done < "$PACKAGES_DIR/manifest.txt"

tar -xzf "$PACKAGES_DIR/termux-node-runtime-arm64.tgz" -C "$PREFIX"
chmod 755 "$PREFIX/bin/node"
mkdir -p "$PREFIX/lib/node_modules"
tar -xzf "$PACKAGES_DIR/paseo-node-modules-arm64.tgz" -C "$PREFIX/lib"
chmod 755 "$PREFIX/lib/node_modules/@getpaseo/cli/bin/paseo"
ln -sf "$PREFIX/lib/node_modules/@getpaseo/cli/bin/paseo" "$PREFIX/bin/paseo"

command -v node >/dev/null 2>&1 || { echo "Bundled Node.js is unavailable" >&2; exit 1; }
[ "$(paseo --version 2>/dev/null || true)" = "0.3.1" ] || { echo "Bundled Paseo CLI is unavailable" >&2; exit 1; }

printf '%s\n' "$RUNTIME_VERSION" > "$MARKER"
