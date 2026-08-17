#!/data/data/com.paseoe/files/usr/bin/bash
set -u

RUN_ID="${1:?Missing Paseo run id}"
APP_DIR="$HOME/.paseo-app"
RUNTIME_DIR="$APP_DIR/runtime"
STATUS_FILE="$APP_DIR/status-$RUN_ID"
LOG_FILE="$APP_DIR/startup.log"
ENHANCED_VERSION="2.3.1"

mkdir -p "$APP_DIR"

write_status() {
    printf '%s\n%s\n%s\n' "$RUN_ID" "$1" "$2" > "$STATUS_FILE.tmp"
    mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

fail() {
    write_status error "$1"
    exit 1
}

wait_for_paseo() {
    attempt=0
    while [ "$attempt" -lt 60 ]; do
        if node -e '
const http = require("http");
const request = http.get("http://127.0.0.1:6767/", response => {
    response.resume();
    process.exit(response.statusCode >= 200 && response.statusCode < 500 ? 0 : 1);
});
request.setTimeout(1000, () => {
    request.destroy();
    process.exit(1);
});
request.on("error", () => process.exit(1));
'; then
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 0.5
    done
    return 1
}

exec >>"$LOG_FILE" 2>&1
write_status installing "Preparing the bundled Paseo runtime"

"$RUNTIME_DIR/install-bundled-runtime.sh" || fail "Runtime installation failed"

PASEO_VERSION="$(paseo --version 2>/dev/null || true)"
if [ "$PASEO_VERSION" != "0.3.1" ]; then
    fail "Paseo CLI 0.3.1 is unavailable"
fi

if [ "$(cat "$APP_DIR/enhanced-version" 2>/dev/null || true)" != "$ENHANCED_VERSION" ]; then
    write_status patching "Applying Paseo Enhanced"
    node "$RUNTIME_DIR/enhanced/install.mjs" || fail "Paseo Enhanced installation failed"
    printf '%s\n' "$ENHANCED_VERSION" > "$APP_DIR/enhanced-version"
    paseo daemon stop --force >/dev/null 2>&1 || true
fi

write_status starting "Starting Paseo"
if ! paseo daemon status --json >/dev/null 2>&1; then
    paseo daemon start --port 6767 --web-ui --no-relay || fail "Paseo daemon failed to start"
fi

wait_for_paseo || fail "Paseo web interface did not become ready"
write_status ready "Paseo is ready"
