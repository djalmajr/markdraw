#!/usr/bin/env bash
#
# One-time macOS setup: create a STABLE self-signed code-signing identity that
# `bun run dev:app` uses to sign every dev build (see scripts/dev.sh +
# dev-sign-run.sh).
#
# WHY: the dev binary is ad-hoc/linker-signed, so its code identity (cdhash)
# changes on EVERY rebuild. macOS keys the Keychain ACL for the AI API keys
# (see src-tauri/src/ai_keychain.rs) to that identity — so every `tauri dev`
# looks like a brand-new app and macOS re-prompts for your password to release
# the key. Signing each dev build with ONE stable certificate gives the binary a
# constant "designated requirement", so a single "Always Allow" sticks forever.
# (The cert does NOT need to be trusted/admin — codesign accepts a self-signed
# identity; the Keychain ACL matches on the cert identity, not its trust chain.)
#
# Run once:
#   bash apps/desktop/scripts/macos-dev-signing-setup.sh
# It asks for your login-keychain password ONCE (so `codesign` can use the new
# key without prompting per build). Then run `bun run dev:app` and click
# "Always Allow" a single time on the Keychain prompt — done forever.

set -euo pipefail

NAME="AsciiMark Dev Signing"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "macOS only — nothing to do."
  exit 0
fi

# The user's default (login) keychain.
KEYCHAIN="$(security default-keychain -d user | sed 's/[" ]//g')"
[[ -z "$KEYCHAIN" ]] && KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"

# Idempotent: bail if the identity already exists (note: -p codesigning WITHOUT
# -v, since a self-signed cert is reported untrusted but is still usable).
if security find-identity -p codesigning | grep -qF "$NAME"; then
  echo "✓ Identity '$NAME' already exists — nothing to do."
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "→ Generating a self-signed code-signing certificate…"
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
  -subj "/CN=${NAME}" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

# Import cert + key as separate PEMs. (PKCS#12 from OpenSSL 3 trips macOS's
# importer with "MAC verification failed"; separate PEMs sidestep that.)
echo "→ Importing into your login keychain (codesign-only access)…"
security import "$tmp/cert.pem" -k "$KEYCHAIN" -T /usr/bin/codesign >/dev/null
security import "$tmp/key.pem"  -k "$KEYCHAIN" -T /usr/bin/codesign >/dev/null

echo "→ Authorizing codesign to use the key without future prompts."
echo "  Enter your macOS login (keychain) password:"
read -rsp "  Password: " KPW
echo
if ! security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KPW" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "  ⚠ set-key-partition-list failed (wrong password?). Re-run this script."
  exit 1
fi

echo
echo "✓ Done. Identity '$NAME' is ready."
echo "  Next: run 'bun run dev:app' and click 'Always Allow' ONCE on the"
echo "  Keychain prompt. After that you won't be asked again."
