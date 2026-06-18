import {
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from "@tauri-apps/api/menu";
import { getVersion } from "@tauri-apps/api/app";

interface MenuDeps {
  onOpenFolder: () => void;
  onExportPdf: () => void;
  onCheckForUpdates: () => void;
  onCloseTab?: () => void;
  onEditorMode: (mode: "edit" | "split" | "preview") => void;
  onToggleSidebar: () => void;
  onToggleToc: () => void;
  onThemeChange: (mode: string) => void;
  onFind: () => void;
}

/**
 * Build the native app menu (macOS menu bar, Windows/Linux window menu).
 *
 * All callbacks point to the same handlers as the toolbar dropdown, so the
 * two interfaces are always in sync. PredefinedMenuItems (Undo, Redo, Cut,
 * Copy, Paste, etc.) are handled natively by the OS — they automatically
 * route to whichever text field is focused.
 */
export async function setupAppMenu(deps: MenuDeps): Promise<void> {
  // On macOS the first Submenu becomes the "app menu" (shown as the app name
  // in the menu bar). "About" is not a valid PredefinedMenuItem type in the JS
  // API, so we use a regular MenuItem.
  const appSubmenu = await Submenu.new({
    text: "Markdraw",
    items: [
      await MenuItem.new({
        id: "about",
        text: "About Markdraw",
        enabled: false,
      }),
      await MenuItem.new({
        id: "check-updates",
        text: "Check for Updates...",
        action: deps.onCheckForUpdates,
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Hide" }),
      await PredefinedMenuItem.new({ item: "HideOthers" }),
      await PredefinedMenuItem.new({ item: "ShowAll" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Quit" }),
    ],
  });

  const fileSubmenu = await Submenu.new({
    text: "File",
    items: [
      await MenuItem.new({
        id: "open-folder",
        text: "Open Folder...",
        accelerator: "CmdOrCtrl+O",
        action: deps.onOpenFolder,
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        id: "export-pdf",
        text: "Export PDF",
        action: deps.onExportPdf,
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      ...(deps.onCloseTab
        ? [
            await MenuItem.new({
              id: "close-tab",
              text: "Close Tab",
              accelerator: "CmdOrCtrl+W",
              action: deps.onCloseTab,
            }),
          ]
        : []),
      await PredefinedMenuItem.new({ item: "CloseWindow" }),
    ],
  });

  const editSubmenu = await Submenu.new({
    text: "Edit",
    items: [
      await PredefinedMenuItem.new({ item: "Undo" }),
      await PredefinedMenuItem.new({ item: "Redo" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Cut" }),
      await PredefinedMenuItem.new({ item: "Copy" }),
      await PredefinedMenuItem.new({ item: "Paste" }),
      await PredefinedMenuItem.new({ item: "SelectAll" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        id: "find",
        text: "Find",
        accelerator: "CmdOrCtrl+F",
        action: deps.onFind,
      }),
    ],
  });

  const viewSubmenu = await Submenu.new({
    text: "View",
    items: [
      await MenuItem.new({
        id: "mode-edit",
        text: "Editor",
        action: () => deps.onEditorMode("edit"),
      }),
      await MenuItem.new({
        id: "mode-split",
        text: "Edit & Preview",
        action: () => deps.onEditorMode("split"),
      }),
      await MenuItem.new({
        id: "mode-preview",
        text: "Preview",
        action: () => deps.onEditorMode("preview"),
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        id: "toggle-sidebar",
        text: "Toggle Sidebar",
        action: deps.onToggleSidebar,
      }),
      await MenuItem.new({
        id: "toggle-toc",
        text: "Toggle TOC",
        action: deps.onToggleToc,
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await Submenu.new({
        text: "Theme",
        items: [
          await MenuItem.new({
            id: "theme-system",
            text: "System",
            action: () => deps.onThemeChange("system"),
          }),
          await MenuItem.new({
            id: "theme-light",
            text: "Light",
            action: () => deps.onThemeChange("light"),
          }),
          await MenuItem.new({
            id: "theme-dark",
            text: "Dark",
            action: () => deps.onThemeChange("dark"),
          }),
        ],
      }),
    ],
  });

  const version = await getVersion();

  const helpSubmenu = await Submenu.new({
    text: "Help",
    items: [
      await MenuItem.new({
        id: "help-updates",
        text: "Check for Updates...",
        action: deps.onCheckForUpdates,
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        id: "help-version",
        text: `Version ${version}`,
        enabled: false,
      }),
    ],
  });

  const menu = await Menu.new({
    items: [appSubmenu, fileSubmenu, editSubmenu, viewSubmenu, helpSubmenu],
  });

  await menu.setAsAppMenu();
}
