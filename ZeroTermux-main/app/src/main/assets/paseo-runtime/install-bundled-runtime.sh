#!/system/bin/sh
set -eu

APP_DIR="$HOME/.paseo-app"
MARKER="$APP_DIR/runtime-version"
RUNTIME_DIR="$APP_DIR/runtime"
PACKAGES_DIR="$RUNTIME_DIR/packages"
RUNTIME_VERSION="paseo-0.3.1-arm64-v6"
TOYBOX="/system/bin/toybox"

if [ "$("$TOYBOX" cat "$MARKER" 2>/dev/null || true)" = "$RUNTIME_VERSION" ] && \
    [ "$("$PREFIX/bin/node" --version 2>/dev/null || true)" = "v24.18.0" ] && \
    [ "$("$PREFIX/bin/node" -p "require('$PREFIX/lib/node_modules/@getpaseo/cli/package.json').version" 2>/dev/null || true)" = "0.3.1" ]; then
    exit 0
fi

while read -r expected relative; do
    [ -z "$expected" ] && continue
    relative="$(printf '%s' "$relative" | "$TOYBOX" tr -d '\r')"
    payload="$PACKAGES_DIR/$relative"
    [ -f "$payload" ] || { echo "Missing bundled runtime payload: $relative" >&2; exit 1; }
    hash_output="$("$TOYBOX" sha256sum "$payload")" || { echo "Unable to hash bundled runtime payload: $relative" >&2; exit 1; }
    actual="${hash_output%% *}"
    [ "$actual" = "$expected" ] || { echo "Invalid bundled runtime payload: $relative" >&2; exit 1; }
done < "$PACKAGES_DIR/manifest.txt"

"$TOYBOX" mkdir -p "$PREFIX"
"$TOYBOX" tar -xzf "$PACKAGES_DIR/termux-node-runtime-arm64.tgz" -C "$PREFIX"
"$TOYBOX" chmod 755 "$PREFIX/bin/node"
"$TOYBOX" mkdir -p "$PREFIX/lib/node_modules"
"$TOYBOX" tar -xzf "$PACKAGES_DIR/paseo-node-modules-arm64.tgz" -C "$PREFIX/lib"
"$TOYBOX" chmod 755 "$PREFIX/lib/node_modules/@getpaseo/cli/bin/paseo"
"$TOYBOX" rm -f "$PREFIX/bin/paseo"
printf '%s\n' \
    '#!/system/bin/sh' \
    'PREFIX="${PREFIX:-/data/data/com.paseoe/files/usr}"' \
    'exec "$PREFIX/bin/node" --disable-warning=DEP0040 "$PREFIX/lib/node_modules/@getpaseo/cli/bin/paseo" "$@"' \
    > "$PREFIX/bin/paseo"
"$TOYBOX" chmod 755 "$PREFIX/bin/paseo"

if ! NODE_VERSION="$("$PREFIX/bin/node" --version)"; then
    echo "Bundled Node.js is unavailable" >&2
    exit 1
fi
[ "$NODE_VERSION" = "v24.18.0" ] || { echo "Unexpected bundled Node.js version: $NODE_VERSION" >&2; exit 1; }
if ! PASEO_VERSION="$("$PREFIX/bin/node" -p "require('$PREFIX/lib/node_modules/@getpaseo/cli/package.json').version")"; then
    echo "Bundled Paseo CLI is unavailable" >&2
    exit 1
fi
[ "$PASEO_VERSION" = "0.3.1" ] || { echo "Unexpected bundled Paseo CLI version: $PASEO_VERSION" >&2; exit 1; }

printf '%s\n' "$RUNTIME_VERSION" > "$MARKER"
