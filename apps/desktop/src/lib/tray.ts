import type { Image as TauriImage } from "@tauri-apps/api/image";
import type {
  Menu as TauriMenu,
  MenuItem as TauriMenuItem,
  MenuItemOptions,
  PredefinedMenuItem as TauriPredefinedMenuItem,
} from "@tauri-apps/api/menu";
import { TrayIcon, type TrayIconOptions } from "@tauri-apps/api/tray";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "./chaos-invoke.ts";
import {
  themeFollower,
  trayIconBase64,
  trayIconDir,
  trayIconFor,
  type TrayTheme,
} from "./tray-icon.ts";

interface DisposableResource {
  close: () => Promise<void>;
}

export interface TrayHandle {
  /** Ends this tray cycle: listener, pending icon work, resources and icon. */
  dispose: () => Promise<void>;
}

interface TrayDeps {
  onOpenFolder: () => void;
  hideWindow: () => Promise<void>;
}

interface TrayWindowRuntime {
  platform: string;
  getCurrentWindow: () => Pick<
    ReturnType<typeof getCurrentWindow>, "isVisible" | "isMinimized" | "minimize" | "setFocus"
  >;
  invoke: typeof invoke;
  removeTray: typeof TrayIcon.removeById;
}

interface TraySetupRuntime<Item, Menu, Image> extends TrayWindowRuntime {
  createItem: (options: MenuItemOptions) => Promise<Item>;
  createSeparator: () => Promise<Item>;
  createMenu: (items: Item[]) => Promise<Menu>;
  createImage: (bytes: Uint8Array) => Promise<Image>;
  createTray: (options: Omit<TrayIconOptions, "menu" | "icon"> & { menu: Menu; icon: Image }) => Promise<
    DisposableResource & Pick<TrayIcon, "setTempDirPath"> & { setIcon: (image: Image) => Promise<void> }
  >;
  runtimeDir: () => Promise<string>;
  appCacheDir: () => Promise<string>;
  listenForTheme: (listener: (theme: TrayTheme) => void) => Promise<() => void | Promise<void>>;
  exit: (code: number) => Promise<void>;
}

const tauriWindowRuntime: TrayWindowRuntime = {
  get platform() { return navigator.platform; },
  getCurrentWindow,
  invoke,
  removeTray: TrayIcon.removeById,
};

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

export async function setupTrayWithRuntime<
  Item extends DisposableResource,
  Menu extends DisposableResource,
  Image extends DisposableResource,
>(deps: TrayDeps, runtime: TraySetupRuntime<Item, Menu, Image>): Promise<TrayHandle> {
  const { getCurrentWindow, invoke, platform, removeTray } = runtime;
  const resources: DisposableResource[] = [];
  let themeQueue: Promise<void> = Promise.resolve();
  let unlisten: (() => void | Promise<void>) | undefined;
  let tray: Awaited<ReturnType<typeof runtime.createTray>> | undefined;
  let disposed = false;

  const keep = <T extends DisposableResource>(resource: T): T => {
    if (disposed) {
      void resource.close().catch(() => {});
      return resource;
    }
    resources.push(resource);
    return resource;
  };
  const release = async (resource: DisposableResource) => {
    const index = resources.indexOf(resource);
    if (index >= 0) resources.splice(index, 1);
    try {
      await resource.close();
    } catch {
      // Already closed by a concurrent teardown.
    }
  };

  let updateIcon: (next: TrayTheme) => Promise<void> = () => Promise.resolve();

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (unlisten) {
      const stop = unlisten;
      unlisten = undefined;
      try {
        await stop();
      } catch {
        // A listener that is already gone needs no teardown.
      }
    }
    await themeQueue;
    const held = resources.splice(0).reverse();
    await Promise.all(held.map((resource) => resource.close().catch(() => {})));
    if (tray) {
      const icon = tray;
      tray = undefined;
      try {
        await removeTray(TRAY_ID);
      } catch {
        // No icon to remove (failed setup or already retired).
      }
      try {
        await icon.close();
      } catch {
        // The native icon was removed; the handle may already be closed.
      }
    }
  };

  try {
    // If a tray with our id already exists from a previous lifecycle —
    // most commonly an HMR-induced re-mount of `App`, but also a cold
    // restart while the OS hasn't yet GC'd the previous icon — remove
    // it before adding the new one. Otherwise every restart stacks
    // another "A" in the menu bar (we've seen up to 4 in dev).
    await removeTray(TRAY_ID).catch(() => {
      // Not present (or platform refused) — fine; the new() below will
      // create a fresh one. Swallow so a missing tray doesn't block
      // the rest of the setup.
    });

    const showHide = keep(await runtime.createItem({
      id: "tray-show-hide",
      text: "Show/Hide",
      action: async () => {
        const win = getCurrentWindow();
        if (await win.isVisible()) {
          await deps.hideWindow();
        } else {
          await invoke("set_dock_visible", { visible: true });
          await invoke("show_main_window");
          await win.setFocus();
        }
      },
    }));

    const openFolder = keep(await runtime.createItem({
      id: "tray-open-folder",
      text: "Open Folder...",
      action: deps.onOpenFolder,
    }));

    const quitItem = keep(await runtime.createItem({
      id: "tray-quit",
      text: "Quit",
      action: () => runtime.exit(0),
    }));

    const menu = keep(await runtime.createMenu([
      showHide,
      keep(await runtime.createSeparator()),
      openFolder,
      keep(await runtime.createSeparator()),
      quitItem,
    ]));

    const isLinux = platform.startsWith("Linux");
    const iconFor = (theme: TrayTheme) =>
      runtime.createImage(base64ToBytes(trayIconBase64(platform, theme)));
    // Linux only: each glyph's PNG goes to its own directory (see trayIconDir).
    const iconBase = isLinux
      ? await runtime.runtimeDir()
          .catch(() => runtime.appCacheDir())
          .catch(() => null)
      : null;
    const iconDir = (theme: TrayTheme) =>
      iconBase ? trayIconDir(iconBase, trayIconFor(platform, theme)) : undefined;
    updateIcon = (next) => {
      const task = themeQueue
        .then(async () => {
          if (disposed || !tray) return;
          const image = keep(await iconFor(next));
          try {
            if (disposed) return;
            const dir = iconDir(next);
            if (dir) await tray.setTempDirPath(dir);
            // The icon may have been removed while the directory IPC ran.
            if (disposed) return;
            await tray.setIcon(image);
          } finally {
            await release(image);
          }
        })
        .catch(() => {});
      themeQueue = task;
      return task;
    };
    // The desktop's scheme now. Not `getCurrentWindow().theme()`: on Linux tao
    // keeps the window's theme as it was when the window was created.
    const systemTheme = () =>
      isLinux ? invoke<TrayTheme>("system_theme").catch(() => null) : Promise.resolve(null);
    const theme = await systemTheme();
    const initialImage = keep(await iconFor(theme));

    tray = await runtime.createTray({
      id: TRAY_ID,
      icon: initialImage,
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
      const follower = themeFollower(theme, updateIcon);
      unlisten = await runtime.listenForTheme((theme) => {
        void follower.event(theme);
      }).catch(() => undefined);
      await follower.reconcile(systemTheme);
    }

    return { dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

interface TrayPreferenceSyncDeps {
  /** Dev never creates a tray, even when the stored preference is on. */
  isDev: boolean;
  /** The live value read by the close handler and the tray menu. */
  isTrayAvailable: () => boolean;
  setup: () => Promise<TrayHandle>;
  onAvailabilityChange: (available: boolean) => void;
  onError?: (error: unknown) => void;
}

/**
 * Applies the live `showTrayIcon` preference. Operations are queued so a
 * fast off→on toggle can keep the active cycle, and a setup that resolves
 * after an "off" cannot mark the tray available.
 */
export function createTrayPreferenceSync(
  deps: TrayPreferenceSyncDeps,
  runtime: TrayWindowRuntime = tauriWindowRuntime,
): {
  sync: (showTrayIcon: boolean) => Promise<void>;
  /** Chooses between hiding and minimizing inside the tray teardown queue. */
  hideWindow: () => Promise<void>;
} {
  let token = 0;
  let queue: Promise<void> = Promise.resolve();
  let currentHandle: TrayHandle | undefined;
  const isMac = runtime.platform.startsWith("Mac");

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task);
    queue = result.then(() => {}, () => {});
    return result;
  };
  const setDockVisible = async (visible: boolean) => {
    await runtime.invoke("set_dock_visible", { visible }).catch((error) => deps.onError?.(error));
  };
  const retire = async () => {
    const handle = currentHandle;
    if (handle) {
      if (!isMac) {
        const win = runtime.getCurrentWindow();
        // Put a window hidden by the tray back within reach of the taskbar.
        if (!(await win.isMinimized()) && !(await win.isVisible())) {
          await runtime.invoke("show_main_window");
          await win.minimize();
        }
      }
      currentHandle = undefined;
      await handle.dispose().catch((error: unknown) => deps.onError?.(error));
    }
    await runtime.removeTray(TRAY_ID).catch(() => {});
    if (isMac) await setDockVisible(true);
  };

  return {
    sync(showTrayIcon) {
      const current = ++token;
      if (!showTrayIcon || deps.isDev) deps.onAvailabilityChange(false);

      // A disabled tray is never created; in dev we don't even touch an
      // icon a prod build may own. Otherwise removal also runs on startup,
      // cleaning up an icon left by a previous lifecycle.
      if (deps.isDev) return Promise.resolve();
      return enqueue(async () => {
        if (current !== token) return;
        if (!showTrayIcon) {
          try {
            await retire();
          } catch (error) {
            // Keep a way to reopen the window if the transition failed.
            if (current === token) deps.onAvailabilityChange(currentHandle !== undefined);
            deps.onError?.(error);
          }
          return;
        }
        if (currentHandle) {
          deps.onAvailabilityChange(true);
          return;
        }
        try {
          const handle = await deps.setup();
          if (current !== token) {
            await handle.dispose().catch((error: unknown) => deps.onError?.(error));
            return;
          }
          currentHandle = handle;
          deps.onAvailabilityChange(true);
        } catch (error) {
          await retire();
          if (current === token) {
            deps.onAvailabilityChange(false);
            deps.onError?.(error);
          }
        }
      });
    },
    hideWindow() {
      return enqueue(async () => {
        if (!isMac && !deps.isTrayAvailable()) {
          await runtime.getCurrentWindow().minimize();
          return;
        }
        await runtime.invoke("hide_main_window");
        if (isMac && deps.isTrayAvailable()) {
          await setDockVisible(false);
        }
      });
    },
  };
}
