// Tauri adapters for the tray. Kept apart from tray.ts so the tray logic can
// be tested with injected adapters without loading the native Tauri modules:
// bun shares `mock.module` across test files, and loading
// `@tauri-apps/api/window` or `/tray` there depends on every other suite's
// mocks of `@tauri-apps/api/core` and `/event`.

import type { Image as TauriImage } from "@tauri-apps/api/image";
import type {
  Menu as TauriMenu,
  MenuItem as TauriMenuItem,
  PredefinedMenuItem as TauriPredefinedMenuItem,
} from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "./chaos-invoke.ts";
import {
  createTrayPreferenceSync as createTrayPreferenceSyncWithRuntime,
  setupTrayWithRuntime,
  type TrayDeps,
  type TrayHandle,
  type TrayPreferenceSyncDeps,
  type TrayWindowRuntime,
} from "./tray.ts";
import type { TrayTheme } from "./tray-icon.ts";

const tauriWindowRuntime: TrayWindowRuntime = {
  get platform() { return navigator.platform; },
  getCurrentWindow,
  invoke,
  removeTray: TrayIcon.removeById,
};

export async function setupTray(deps: TrayDeps): Promise<TrayHandle> {
  const [{ Menu, MenuItem, PredefinedMenuItem }, { Image }, { exit }, { appCacheDir, runtimeDir }, { listen }] =
    await Promise.all([
      import("@tauri-apps/api/menu"),
      import("@tauri-apps/api/image"),
      import("@tauri-apps/plugin-process"),
      import("@tauri-apps/api/path"),
      import("@tauri-apps/api/event"),
    ]);

  return setupTrayWithRuntime<TauriMenuItem | TauriPredefinedMenuItem, TauriMenu, TauriImage>(deps, {
    ...tauriWindowRuntime,
    createItem: MenuItem.new,
    createSeparator: () => PredefinedMenuItem.new({ item: "Separator" }),
    createMenu: (items) => Menu.new({ items }),
    createImage: Image.fromBytes,
    createTray: TrayIcon.new,
    runtimeDir,
    appCacheDir,
    listenForTheme: (listener) => listen<TrayTheme>("system-theme-changed", ({ payload }) => listener(payload)),
    exit,
  });
}

export function createTrayPreferenceSync(deps: TrayPreferenceSyncDeps) {
  return createTrayPreferenceSyncWithRuntime(deps, tauriWindowRuntime);
}
