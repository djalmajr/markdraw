#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_ICON="$ROOT_DIR/assets/brand/markdraw-icon.svg"
DESKTOP_SOURCE_ICON="$ROOT_DIR/assets/brand/markdraw-icon-bg.svg"

rsvg-convert -w 16 -h 16 "$SOURCE_ICON" -o "$ROOT_DIR/apps/extension/public/icons/icon16.png"
rsvg-convert -w 48 -h 48 "$SOURCE_ICON" -o "$ROOT_DIR/apps/extension/public/icons/icon48.png"
rsvg-convert -w 128 -h 128 "$SOURCE_ICON" -o "$ROOT_DIR/apps/extension/public/icons/icon128.png"

cp "$SOURCE_ICON" "$ROOT_DIR/apps/extension/public/icons/icon16.svg"
cp "$SOURCE_ICON" "$ROOT_DIR/apps/extension/public/icons/icon48.svg"
cp "$SOURCE_ICON" "$ROOT_DIR/apps/extension/public/icons/icon128.svg"

# Site + extension use the no-background symbol.
cp "$SOURCE_ICON" "$ROOT_DIR/apps/site/public/markdraw-logo.svg"
cp "$SOURCE_ICON" "$ROOT_DIR/apps/site/public/favicon.svg"
cp "$SOURCE_ICON" "$ROOT_DIR/apps/extension/public/favicon.svg"

(
  cd "$ROOT_DIR/apps/desktop"
  bunx tauri icon "../../assets/brand/markdraw-icon-bg.svg" -o "src-tauri/icons"
)

# We only ship desktop + extension right now.
rm -rf "$ROOT_DIR/apps/desktop/src-tauri/icons/android"
rm -rf "$ROOT_DIR/apps/desktop/src-tauri/icons/ios"
