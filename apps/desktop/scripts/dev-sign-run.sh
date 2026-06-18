#!/usr/bin/env bash
#
# Cargo `runner` for `tauri dev` (wired by scripts/dev.sh via the
# CARGO_TARGET_<triple>_RUNNER env var). Cargo invokes it as:
#   dev-sign-run.sh <path-to-binary> [args…]
#
# It re-signs the freshly built app binary with the stable dev identity, then
# execs it — giving every rebuild the SAME code identity so the macOS Keychain
# ACL for the AI keys stays authorized. Only the app binary is signed; test and
# other binaries pass straight through. If signing fails, it still launches
# (you'd just see the keychain prompt again), never blocking dev.

set -euo pipefail

IDENTITY="Markdraw Dev Signing"
bin="$1"
shift || true

if [[ "$(basename "$bin")" == "markdraw" ]]; then
  codesign --force --sign "$IDENTITY" --identifier "app.markdraw" "$bin" >/dev/null 2>&1 \
    || echo "[dev] warning: codesign failed; launching unsigned (keychain may prompt)" >&2
fi

exec "$bin" "$@"
