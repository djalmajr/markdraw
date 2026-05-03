#!/usr/bin/env bash
# Spawn `bun run dev:app` in the background, wait for the tauri-mcp-bridge to
# become healthy, run the E2E specs, then tear everything down.
# Used by release-check.sh and can be invoked standalone for ad-hoc runs.
set -euo pipefail

cd "$(dirname "$0")/.."

BRIDGE_BASE="${TAURI_MCP_BRIDGE:-http://127.0.0.1:4000}"
LOG_DIR="$(mktemp -d -t asciimark-e2e-XXXXXX)"
DEV_LOG="$LOG_DIR/dev.log"
DEV_PID=""

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
if curl -sf --max-time 1 "$BRIDGE_BASE/health" >/dev/null 2>&1; then
  echo "▶ Reusing already-running tauri-mcp-bridge at $BRIDGE_BASE"
else
  echo "▶ Spawning tauri dev (logs: $DEV_LOG)"
  bun run dev:app >"$DEV_LOG" 2>&1 &
  DEV_PID=$!

  echo "▶ Waiting for bridge at $BRIDGE_BASE/health (timeout 90s)"
  WAITED=0
  until curl -sf --max-time 1 "$BRIDGE_BASE/health" >/dev/null 2>&1; do
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

echo "▶ Running E2E specs"
(cd apps/desktop && bun test e2e/specs)
