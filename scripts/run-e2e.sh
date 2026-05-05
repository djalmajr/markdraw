#!/usr/bin/env bash
# Spawn `bun run dev:app` in the background, wait for the tauri-mcp-bridge to
# become healthy, run the E2E specs, then tear everything down.
# Used by release-check.sh and can be invoked standalone for ad-hoc runs.
set -euo pipefail

cd "$(dirname "$0")/.."

# The tauri-plugin-mcp-bridge listens on a WebSocket socket, not an HTTP
# endpoint — so health is a TCP-reachability check, not a curl /health.
# Defaults match `apps/desktop/e2e/bridge.ts` (127.0.0.1:9223). Override
# either piece via TAURI_MCP_BRIDGE_HOST / TAURI_MCP_BRIDGE_PORT.
BRIDGE_HOST="${TAURI_MCP_BRIDGE_HOST:-127.0.0.1}"
BRIDGE_PORT="${TAURI_MCP_BRIDGE_PORT:-9223}"
LOG_DIR="$(mktemp -d -t asciimark-e2e-XXXXXX)"
DEV_LOG="$LOG_DIR/dev.log"
DEV_PID=""

# Probe the bridge port. `nc -z` succeeds the moment the plugin's
# tokio listener is bound — that is the same condition `connectBridge`
# checks against, so a successful probe means specs can connect.
probe_bridge() {
  nc -z -w 1 "$BRIDGE_HOST" "$BRIDGE_PORT" >/dev/null 2>&1
}

cleanup() {
  if [ -n "$DEV_PID" ] && kill -0 "$DEV_PID" 2>/dev/null; then
    # Tauri spawns child webview/cargo processes; kill the whole group.
    pkill -P "$DEV_PID" 2>/dev/null || true
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  if [ "${E2E_KEEP_LOGS:-0}" != "1" ]; then
    rm -rf "$LOG_DIR"
  else
    echo "Logs preserved at $LOG_DIR" >&2
  fi
}
trap cleanup EXIT INT TERM

# If a bridge is already up (developer running dev:app in another terminal),
# reuse it. Otherwise spawn one.
if probe_bridge; then
  echo "▶ Reusing already-running tauri-mcp-bridge at $BRIDGE_HOST:$BRIDGE_PORT"
else
  echo "▶ Spawning tauri dev (logs: $DEV_LOG)"
  bun run dev:app >"$DEV_LOG" 2>&1 &
  DEV_PID=$!

  echo "▶ Waiting for bridge at $BRIDGE_HOST:$BRIDGE_PORT (timeout 90s)"
  WAITED=0
  until probe_bridge; do
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      echo "✖ tauri dev exited before bridge came up. Last log lines:" >&2
      tail -30 "$DEV_LOG" >&2 || true
      exit 1
    fi
    if [ "$WAITED" -ge 90 ]; then
      echo "✖ Timed out waiting for bridge. Last log lines:" >&2
      tail -30 "$DEV_LOG" >&2 || true
      exit 1
    fi
    sleep 2
    WAITED=$((WAITED + 2))
  done
  echo "▶ Bridge healthy after ${WAITED}s"
fi

# TCP-up isn't enough — Solid mounts after the plugin's socket binds, so
# specs that immediately call `window.__DEV__.openFolder(...)` fail with
# "DEV helper not exposed" if the frontend hasn't finished hydrating.
# Poll until __DEV__ is actually an object.
echo "▶ Waiting for frontend (window.__DEV__) to be exposed (timeout 30s)"
bun scripts/wait-app-ready.ts

echo "▶ Running E2E specs"
(cd apps/desktop && bun test e2e/specs)
