#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_ICON="$ROOT_DIR/assets/brand/markdraw-icon.svg"
DESKTOP_SOURCE_ICON="$ROOT_DIR/assets/brand/markdraw-icon-bg.svg"



# Site + extension use the no-background symbol.
cp "$SOURCE_ICON" "$ROOT_DIR/apps/site/public/markdraw-logo.svg"
cp "$SOURCE_ICON" "$ROOT_DIR/apps/site/public/favicon.svg"

(
  cd "$ROOT_DIR/apps/desktop"
  bunx tauri icon "../../assets/brand/markdraw-icon-bg.svg" -o "src-tauri/icons"
)

# We only ship desktop + extension right now.
rm -rf "$ROOT_DIR/apps/desktop/src-tauri/icons/android"
rm -rf "$ROOT_DIR/apps/desktop/src-tauri/icons/ios"
