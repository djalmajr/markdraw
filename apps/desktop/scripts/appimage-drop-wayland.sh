#!/usr/bin/env bash
#
# Strip the bundled libwayland-* from the AppImage `tauri build` just produced,
# repack it and re-sign the updater artifact.
#
# Why: linuxdeploy bundles the build host's libwayland (Ubuntu 22.04 → 1.20).
# The AppImage still uses the *system* libEGL/libgbm (excluded by the AppImage
# excludelist), and Mesa >= 25 builds libEGL_mesa against newer libwayland
# symbols (wl_display_dispatch_queue_timeout, wl_fixes_interface, ...). With
# the old bundled copy loaded first, glvnd can't load Mesa's EGL vendor, the
# WebKit web process aborts with "Could not create default EGL display:
# EGL_BAD_PARAMETER" and the window stays blank on Intel/AMD machines running a
# current distro. libwayland keeps a stable ABI and every GTK3 desktop ships it,
# so the system copy is always the right one.
#
# Tauri's bundler doesn't let us pass `--exclude-library` to linuxdeploy (and
# the linuxdeploy build it downloads predates LINUXDEPLOY_EXCLUDED_LIBRARIES),
# but it leaves the AppDir behind — so we fix the AppDir and repack it with the
# same linuxdeploy-plugin-appimage tool Tauri used.
#
#   bash scripts/appimage-drop-wayland.sh [bundle/appimage dir]
#
# Env: TAURI_SIGNING_PRIVATE_KEY(_PATH) + TAURI_SIGNING_PRIVATE_KEY_PASSWORD to
# re-sign. If the build produced a .sig, re-signing is mandatory (a stale .sig
# would make every updater install fail verification).

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
bundle_dir="$(realpath "${1:-$here/../src-tauri/target/release/bundle/appimage}")"
tools_dir="${TAURI_TOOLS_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/tauri}"
plugin="$tools_dir/linuxdeploy-plugin-appimage.AppImage"

shopt -s nullglob
appdirs=("$bundle_dir"/*.AppDir)
appimages=("$bundle_dir"/*.AppImage)
shopt -u nullglob
if [[ ${#appdirs[@]} -ne 1 || ${#appimages[@]} -ne 1 ]]; then
  echo "error: expected exactly one *.AppDir and one *.AppImage in $bundle_dir" >&2
  exit 1
fi
appdir="${appdirs[0]}"
appimage="${appimages[0]}"
sig="$appimage.sig"

mapfile -t libs < <(find "$appdir/usr/lib" -maxdepth 1 -name 'libwayland-*.so*' | sort)
if [[ ${#libs[@]} -eq 0 ]]; then
  echo "[appimage] no bundled libwayland in $(basename "$appdir"), nothing to do"
  exit 0
fi
if [[ -f "$sig" && -z "${TAURI_SIGNING_PRIVATE_KEY:-}${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
  echo "error: $(basename "$sig") exists but no signing key is set to regenerate it after repacking" >&2
  exit 1
fi
echo "[appimage] dropping bundled: ${libs[*]##*/}"
rm -f "${libs[@]}"

if [[ ! -x "$plugin" ]]; then
  # Same URL Tauri's bundler uses; it only skips it when that download fails.
  echo "[appimage] fetching linuxdeploy-plugin-appimage"
  mkdir -p "$tools_dir"
  curl -fsSL -o "$plugin" \
    "https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-$(uname -m).AppImage"
  chmod +x "$plugin"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "[appimage] repacking $(basename "$appimage")"
(
  cd "$tmp"
  APPIMAGE_EXTRACT_AND_RUN=1 ARCH="$(uname -m)" LDAI_OUTPUT="$tmp/out.AppImage" \
    "$plugin" --appdir "$appdir" > "$tmp/repack.log" 2>&1 \
    || { cat "$tmp/repack.log" >&2; exit 1; }
)
mv -f "$tmp/out.AppImage" "$appimage"
chmod +x "$appimage"

# Prove the shipped file is what we meant: no libwayland, app binary present.
(cd "$tmp" && APPIMAGE_EXTRACT_AND_RUN=1 "$appimage" --appimage-extract > /dev/null)
if compgen -G "$tmp/squashfs-root/usr/lib/libwayland-*" > /dev/null; then
  echo "error: repacked AppImage still bundles libwayland" >&2
  exit 1
fi
if ! compgen -G "$tmp/squashfs-root/usr/bin/*" > /dev/null; then
  echo "error: repacked AppImage has no usr/bin payload" >&2
  exit 1
fi

if [[ -f "$sig" ]]; then
  rm -f "$sig"
  (cd "$here/.." && bunx tauri signer sign "$appimage" > /dev/null)
  [[ -s "$sig" ]] || { echo "error: re-signing produced no $(basename "$sig")" >&2; exit 1; }
  echo "[appimage] re-signed $(basename "$sig")"
fi

echo "[appimage] done: $appimage"
