import { TrayIcon } from "@tauri-apps/api/tray";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { Image } from "@tauri-apps/api/image";
import { invoke } from "./chaos-invoke.ts";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import { appCacheDir, runtimeDir } from "@tauri-apps/api/path";
import { listen } from "@tauri-apps/api/event";
import {
  themeFollower,
  trayIconBase64,
  trayIconDir,
  trayIconFor,
  type TrayTheme,
} from "./tray-icon.ts";

interface TrayDeps {
  onOpenFolder: () => void;
}

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
 * on dark bar, black on light bar), matching native tray icons. Linux
 * trays don't tint icons, so there the glyph is picked from the desktop's
 * color scheme and swapped when it changes (`trayIconFor`).
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
        await invoke("hide_main_window");
        await invoke("set_dock_visible", { visible: false });
      } else {
        await invoke("set_dock_visible", { visible: true });
        await invoke("show_main_window");
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

  const isLinux = navigator.platform.startsWith("Linux");
  const iconFor = (theme: TrayTheme) =>
    Image.fromBytes(base64ToBytes(trayIconBase64(navigator.platform, theme)));
  // Linux only: each glyph's PNG goes to its own directory (see trayIconDir).
  const iconBase = isLinux
    ? await runtimeDir()
        .catch(() => appCacheDir())
        .catch(() => null)
    : null;
  const iconDir = (theme: TrayTheme) =>
    iconBase ? trayIconDir(iconBase, trayIconFor(navigator.platform, theme)) : undefined;
  // The desktop's scheme now. Not `getCurrentWindow().theme()`: on Linux tao
  // keeps the window's theme as it was when the window was created.
  const systemTheme = () =>
    isLinux ? invoke<TrayTheme>("system_theme").catch(() => null) : Promise.resolve(null);
  const theme = await systemTheme();

  const tray = await TrayIcon.new({
    id: TRAY_ID,
    icon: await iconFor(theme),
    tempDirPath: iconDir(theme),
    menu,
    menuOnLeftClick: false,
    iconAsTemplate: true,
    tooltip: "Markdraw",
    action: async (event) => {
      if (event.type === "Click" && event.button === "Left") {
        const win = getCurrentWindow();
        await invoke("set_dock_visible", { visible: true });
        await invoke("show_main_window");
        await win.setFocus();
      }
    },
  });

  // Follow the desktop's light/dark switch (Linux only; macOS tints the
  // template image itself). The Rust side emits `system-theme-changed`:
  // the window's `onThemeChanged` never fires for a desktop switch there.
  // Once listening, the scheme is read again to catch a switch made while
  // the tray was being created (`themeFollower` orders it all).
  if (isLinux) {
    const follower = themeFollower(theme, async (next) => {
      const image = await iconFor(next);
      const dir = iconDir(next);
      if (dir) await tray.setTempDirPath(dir);
      await tray.setIcon(image);
    });
    await listen<TrayTheme>("system-theme-changed", ({ payload }) => {
      void follower.event(payload);
    }).catch(() => {});
    await follower.reconcile(systemTheme);
  }
}
