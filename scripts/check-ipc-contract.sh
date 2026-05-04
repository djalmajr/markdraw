#!/usr/bin/env bash
# Lightweight IPC contract check: every `invoke('cmd', …)` in the desktop
# frontend must reference a `#[tauri::command]` declared in the Rust
# backend. Catches drift the moment someone renames a command in Rust
# but forgets the frontend (camelCase vs snake_case is the most common
# trap).
#
# This is the poor man's specta. Real specta + tauri-specta would emit
# typed TS bindings, but their version matrix vs tauri 2.x is fragile —
# this grep-based contract gets us 80% of the value without a release
# blocker. See docs/testing/STRATEGIES.md for the upgrade path.
set -euo pipefail

cd "$(dirname "$0")/.."

LIB_RS="apps/desktop/src-tauri/src/lib.rs"
FRONTEND_DIR="apps/desktop/src"

# Extract every command declared in the Rust backend's invoke_handler!
# block. The Tauri macro takes a comma-separated list of identifiers.
RUST_COMMANDS=$(awk '
  /tauri::generate_handler!/,/])/ {
    gsub(/[ \t,\[\]]/, " ")
    for (i = 1; i <= NF; i++) {
      if ($i ~ /^[a-z_][a-z0-9_]*$/) print $i
    }
  }
' "$LIB_RS" | grep -vE '^(tauri|generate_handler|invoke_handler)$' | sort -u)

if [ -z "$RUST_COMMANDS" ]; then
  echo "✖ Could not extract any Rust commands from $LIB_RS" >&2
  exit 1
fi

# Extract every command name invoked from the frontend.
FRONT_COMMANDS=$(grep -rohE "invoke[<(][^,)]*['\"]([a-z_][a-z0-9_]*)['\"]" "$FRONTEND_DIR" \
  | grep -oE "['\"][a-z_][a-z0-9_]*['\"]" \
  | tr -d "'\"" | sort -u || true)

EXIT=0

# Frontend uses something Rust doesn't expose — drift, fail.
while IFS= read -r cmd; do
  [ -z "$cmd" ] && continue
  if ! grep -qx "$cmd" <<<"$RUST_COMMANDS"; then
    echo "✖ Frontend invokes '$cmd' but it is not registered in $LIB_RS"
    EXIT=1
  fi
done <<<"$FRONT_COMMANDS"

# Rust exposes something nobody uses — likely dead code. Warn only.
while IFS= read -r cmd; do
  [ -z "$cmd" ] && continue
  if ! grep -qx "$cmd" <<<"$FRONT_COMMANDS"; then
    echo "⚠ Rust exposes '$cmd' but no frontend caller found (possible dead command)"
  fi
done <<<"$RUST_COMMANDS"

if [ $EXIT -eq 0 ]; then
  echo "✔ IPC contract OK ($(wc -l <<<"$RUST_COMMANDS" | tr -d ' ') Rust commands; $(wc -l <<<"$FRONT_COMMANDS" | tr -d ' ') frontend invocations)"
fi
exit $EXIT
