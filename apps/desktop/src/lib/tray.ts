import { TrayIcon } from "@tauri-apps/api/tray";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { Image } from "@tauri-apps/api/image";
import { invoke } from "./chaos-invoke.ts";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";

interface TrayDeps {
  onOpenFolder: () => void;
}

// Tray icon: black "A" on transparent background (88x88 RGBA PNG, base64).
// Generated from assets/brand/markdraw-icon-white.svg (colors inverted).
// Embedded to avoid file path resolution issues between dev and production.
const TRAY_ICON_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAFgAAABYCAYAAABxlTA0AAAE2ElEQVR42u2cXYgVZRjHf0ezbSvT1cWMipQKYkvypi/ctBVLCiGSwIsuFI0uuqkg6OOqm76oQLrIIOjGAinTCwWlsqXUinCRaE0xjUAzN1sl0fKs7k4X8w4djmd35n2emXnmyPuDB5Y9O+/7f35wzs68886BQCAQCAQCgUAgEAgEAoHyqFkH8GAaMMf9/Bvwt3WgS4EO4GlgAIiaasC91mEdsl3pAQa5WGxzDbq/DXjQAwyTLjepYYLkzFwJ7Ce73KT2u2MDKbyGv9ykXrUOX3VuB+rIBdcJHxXjUgO+Qi43qW9or9PP0liNXm5Sq6ybqRrdwAnyE3wCmGndVJX4kPzkJvWBdVNVoRcYI3/BY8AD1s1ZcxnwI/nLbbzKm2LdpCUvUpzcpF6wbtKKm4AzGQRp6yww17pZCzYLZElro3WzZdOXkzifWmLddFlMAvaUILS59gKTrZsvg6cM5Ca1xrr5opkK/GEoeIj41tMly5uGcpN63VpCUcwFzlVAcB24xVpGEWysgNykPrWWkTcLKyC1uRZaS8mLSbS+7e5TPwErgdtcrXS/04w54LK1PWuUIj6j9d6HDveaZuzV1nK0XAUcUwg45MaYaPxDivGPpYxfeV5WNB8BD2aYow/devJL1pKkTMdv80hzrfeY6yPFPKeAGdayJGguKoaBWR5zae/ptd3Fx3XE67DShlcJ5nxSMd8/wA3W0nx4X9FsP7J9DTXga8W871lLy8qtwIiwyTrxea6UHsXcI7TJJfQGYYMR8EYO87+tmP9ja3lpzAdGhc0dBa7OIcNUN5Ykwyhwp7XEidgmbCwCVuSY4wlFjq3WEsfjfkVTRWzY61fkWWQtsxW7hc2MEG9bzZt5wHlhpp3WMptZJmwkAtYWmOtdRa6HraU28oOwiZNk3wU5D/jc1R0Zj+lCfrn+vbXUhEeEDUTAcxnnmA/81XDcKeCujMc+r8j3kLVcgF3C8L+S7Rm3Zrm+ki9HvqT5rbXcpcLgEfC4Qq6v5BWKnKY7gnYKQ39H+mlZmlwfyTXk77TdVnKXCAOPAQtykusj+V7kC/N9FoKlK1cbcpbrI/kTYeZdZcuV7o5M2/QxDTguHDsi3pZ1zQTjaza/LCpTcL8w5Fsp496jkJvU3SlzvCMcd0dZchcIA54k/d7XFcA+hdxB0k/9piP7CIooabPKl8Jwz2Qcfzbws2D8g8D1Ged4VtjDF0XLvU8Y7DB+X5zhK9lHLsRPHh0U9tJbpOAtwlCStd7ZZPu48JWbIL342FKU3GuBC4JAZ4gvV6VzTiRZKheXSfKU0wWXK3eWC8JEwAHlvONJ1shNOCDsaXnWCXx2F94obGImursVQ8Bi4s/khF+Iz8V/V4xbQ/7AeGYXPoLHhGG6Sb80TmOIWOhaV73o5OIydQuPHVXO3RLNXYs9QGcRoYR0onuUbFkRobrQPWOxztpqA+sUfZxzLgphvSJYlZ60lK4ERvjt+vRmDnBaEGqTtdEWbBL0cZr/v96xMB7Fb//XPgp8Synowm/dY8T1XgpLybasuB35f+oy6HYZ0/o47noulRnAK8TrDI1hzhMv7T1Ge3y9Vs1l3cHFG1UOux7FO+DzEjCL+OS77kL9a6ZLRydwM/HC1BHgT+tAgUAgEAgEAoFAIBAIBAI+/Ad6Ee3F+XKpvwAAAABJRU5ErkJggg==";

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Create a system tray icon with a context menu (right-click) and a
 * left-click action that shows/focuses the main window.
 *
 * On macOS, `iconAsTemplate: true` makes the OS render the icon as a
 * template image — the black pixels adapt to the menu bar theme (white
 * on dark bar, black on light bar), matching native tray icons.
 */
/**
 * Stable id for the Markdraw tray entry. Used both when creating
 * the tray and when removing any leftover one before re-creating —
 * HMR (and even cold dev restarts when the previous Rust process
 * lingered briefly) can leave duplicates in the macOS menu bar.
 */
export const TRAY_ID = "markdraw-tray";

export async function setupTray(deps: TrayDeps): Promise<void> {
  // If a tray with our id already exists from a previous lifecycle —
  // most commonly an HMR-induced re-mount of `App`, but also a cold
  // restart while the OS hasn't yet GC'd the previous icon — remove
  // it before adding the new one. Otherwise every restart stacks
  // another "A" in the menu bar (we've seen up to 4 in dev).
  await TrayIcon.removeById(TRAY_ID).catch(() => {
    // Not present (or platform refused) — fine; the new() below will
    // create a fresh one. Swallow so a missing tray doesn't block
    // the rest of the setup.
  });


  const showHide = await MenuItem.new({
    id: "tray-show-hide",
    text: "Show/Hide",
    action: async () => {
      const win = getCurrentWindow();
      if (await win.isVisible()) {
        await win.hide();
        await invoke("set_dock_visible", { visible: false });
      } else {
        await invoke("set_dock_visible", { visible: true });
        await win.show();
        await win.setFocus();
      }
    },
  });

  const openFolder = await MenuItem.new({
    id: "tray-open-folder",
    text: "Open Folder...",
    action: deps.onOpenFolder,
  });

  const quitItem = await MenuItem.new({
    id: "tray-quit",
    text: "Quit",
    action: () => exit(0),
  });

  const menu = await Menu.new({
    items: [
      showHide,
      await PredefinedMenuItem.new({ item: "Separator" }),
      openFolder,
      await PredefinedMenuItem.new({ item: "Separator" }),
      quitItem,
    ],
  });

  const icon = await Image.fromBytes(base64ToBytes(TRAY_ICON_BASE64));

  await TrayIcon.new({
    id: TRAY_ID,
    icon,
    menu,
    menuOnLeftClick: false,
    iconAsTemplate: true,
    tooltip: "Markdraw",
    action: async (event) => {
      if (event.type === "Click" && event.button === "Left") {
        const win = getCurrentWindow();
        await invoke("set_dock_visible", { visible: true });
        await win.show();
        await win.setFocus();
      }
    },
  });
}
