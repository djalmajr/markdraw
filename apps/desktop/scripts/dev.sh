#!/usr/bin/env bash
#
# Dev launcher for Markdraw (`bun run dev:app` → this).
#
# On macOS, if the stable dev code-signing identity exists (created once by
# scripts/macos-dev-signing-setup.sh), wire a cargo `runner` that re-signs the
# freshly built binary with that identity before each launch. This keeps the
# binary's code identity constant across rebuilds, so the macOS Keychain ACL for
# the AI API keys (src-tauri/src/ai_keychain.rs) stays authorized — no password
# prompt on every `tauri dev`.
#
# Without the identity (other contributors, CI, non-macOS) this is a transparent
# passthrough: it just runs `tauri dev`, exactly as before.

set -euo pipefail

IDENTITY="Markdraw Dev Signing"
here="$(cd "$(dirname "$0")" && pwd)"

# NOTE: -p codesigning WITHOUT -v — a self-signed cert is reported untrusted but
# is still usable for signing, and `-v` would hide it.
if [[ "$(uname)" == "Darwin" ]] && security find-identity -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  case "$(uname -m)" in
    arm64) triple="AARCH64_APPLE_DARWIN" ;;
    x86_64) triple="X86_64_APPLE_DARWIN" ;;
    *) triple="" ;;
  esac
  if [[ -n "$triple" ]]; then
    export "CARGO_TARGET_${triple}_RUNNER=${here}/dev-sign-run.sh"
    echo "[dev] signing dev builds with stable identity '${IDENTITY}' (keychain stays authorized)"
  fi
fi

exec tauri dev --config src-tauri/tauri.dev.conf.json "$@"
