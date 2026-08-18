#!/system/bin/sh
set -u

RUN_ID="${1:?Missing Paseo run id}"
APP_DIR="$HOME/.paseo-app"
RUNTIME_DIR="$APP_DIR/runtime"
STATUS_FILE="$APP_DIR/status-$RUN_ID"
LOG_FILE="$APP_DIR/startup.log"
ENHANCED_VERSION="2.3.3"
TOYBOX="/system/bin/toybox"
NODE="$PREFIX/bin/node"
DAEMON_WORKER="$PREFIX/lib/node_modules/@getpaseo/server/dist/server/server/daemon-worker.js"
DAEMON_PID=""

"$TOYBOX" mkdir -p "$APP_DIR"

write_status() {
    printf '%s\n%s\n%s\n' "$RUN_ID" "$1" "$2" > "$STATUS_FILE.tmp"
    "$TOYBOX" mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

fail() {
    write_status error "$1"
    exit 1
}

stop_daemon() {
    if [ -z "$DAEMON_PID" ]; then
        return
    fi
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
    DAEMON_PID=""
}

trap stop_daemon EXIT INT TERM

is_paseo_ready() {
    "$TOYBOX" nc -z -w 1 127.0.0.1 6767 >/dev/null 2>&1
}

wait_for_paseo() {
    attempt=0
    while [ "$attempt" -lt 1200 ]; do
        if is_paseo_ready; then
            return 0
        fi
        attempt=$((attempt + 1))
        "$TOYBOX" sleep 0.5
    done
    return 1
}

exec >>"$LOG_FILE" 2>&1
write_status installing "Preparing the bundled Paseo runtime"

"$RUNTIME_DIR/install-bundled-runtime.sh" || fail "Runtime installation failed"

PASEO_VERSION="$("$NODE" -p "require('$PREFIX/lib/node_modules/@getpaseo/cli/package.json').version" 2>/dev/null || true)"
if [ "$PASEO_VERSION" != "0.3.1" ]; then
    fail "Paseo CLI 0.3.1 is unavailable"
fi

if [ "$("$TOYBOX" cat "$APP_DIR/enhanced-version" 2>/dev/null || true)" != "$ENHANCED_VERSION" ]; then
    write_status patching "Applying Paseo Enhanced"
    "$NODE" "$RUNTIME_DIR/enhanced/install.mjs" || fail "Paseo Enhanced installation failed"
    printf '%s\n' "$ENHANCED_VERSION" > "$APP_DIR/enhanced-version"
fi

write_status starting "Starting Paseo"
if ! is_paseo_ready; then
    [ -f "$DAEMON_WORKER" ] || fail "Paseo daemon worker is unavailable"
    PASEO_LISTEN=127.0.0.1:6767 \
        PASEO_WEB_UI_ENABLED=true \
        "$NODE" "$DAEMON_WORKER" --no-relay --web-ui &
    DAEMON_PID=$!
fi

wait_for_paseo || fail "Paseo web interface did not become ready"
write_status ready "Paseo is ready"

if [ -n "$DAEMON_PID" ]; then
    wait "$DAEMON_PID"
    DAEMON_PID=""
    fail "Paseo daemon stopped unexpectedly"
fi
