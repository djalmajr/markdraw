/**
 * Keyboard shortcut catalog. Single source of truth so the help modal,
 * the menu bar, and the keydown handlers cannot drift apart silently.
 *
 * Pure data — no I/O, no DOM, no platform detection here. Callers pass
 * the platform key in (typically derived from `navigator.platform`).
 */

export type Platform = "mac" | "other";

export type ShortcutGroup = "File" | "Tabs" | "Navigation" | "Help";

export interface ShortcutDescriptor {
  /** Stable identifier used by tests and analytics. */
  id: string;
  group: ShortcutGroup;
  /** Message key resolved by the consumer against the i18n catalog. Kept
   *  as a plain string so `core` stays decoupled from `@asciimark/i18n`. */
  descriptionKey: string;
  /** Modifier + key tokens. Modifiers come first; the LAST token is the
   *  bare key (single letter, "Tab", "Enter", etc). The display layer
   *  joins them with the platform-correct separator (` ` on macOS for
   *  the chord glyphs, `+` elsewhere). */
  keys: {
    mac: readonly string[];
    other: readonly string[];
  };
}

export const SHORTCUTS: readonly ShortcutDescriptor[] = [
  // ── File ────────────────────────────────────────────────────────────────
  {
    id: "file.openFolder",
    group: "File",
    descriptionKey: "shortcut_file_open_folder",
    keys: { mac: ["⌘", "O"], other: ["Ctrl", "O"] },
  },
  {
    id: "file.save",
    group: "File",
    descriptionKey: "shortcut_file_save",
    keys: { mac: ["⌘", "S"], other: ["Ctrl", "S"] },
  },
  // ── Tabs ────────────────────────────────────────────────────────────────
  {
    id: "tab.new",
    group: "Tabs",
    descriptionKey: "shortcut_tab_new",
    keys: { mac: ["⌘", "T"], other: ["Ctrl", "T"] },
  },
  {
    id: "tab.close",
    group: "Tabs",
    descriptionKey: "shortcut_tab_close",
    keys: { mac: ["⌘", "W"], other: ["Ctrl", "W"] },
  },
  {
    id: "tab.reopen",
    group: "Tabs",
    descriptionKey: "shortcut_tab_reopen",
    keys: { mac: ["⌘", "⇧", "T"], other: ["Ctrl", "Shift", "T"] },
  },
  {
    id: "tab.next",
    group: "Tabs",
    descriptionKey: "shortcut_tab_next",
    keys: { mac: ["⌃", "Tab"], other: ["Ctrl", "Tab"] },
  },
  {
    id: "tab.prev",
    group: "Tabs",
    descriptionKey: "shortcut_tab_prev",
    keys: { mac: ["⌃", "⇧", "Tab"], other: ["Ctrl", "Shift", "Tab"] },
  },
  // ── Navigation ──────────────────────────────────────────────────────────
  {
    id: "nav.quickOpen",
    group: "Navigation",
    descriptionKey: "shortcut_nav_quick_open",
    keys: { mac: ["⌘", "P"], other: ["Ctrl", "P"] },
  },
  {
    id: "nav.commandPalette",
    group: "Navigation",
    descriptionKey: "shortcut_nav_command_palette",
    keys: { mac: ["⌘", "⇧", "P"], other: ["Ctrl", "Shift", "P"] },
  },
  {
    id: "nav.goToSymbol",
    group: "Navigation",
    descriptionKey: "shortcut_nav_go_to_symbol",
    keys: { mac: ["⌘", "⇧", "O"], other: ["Ctrl", "Shift", "O"] },
  },
  {
    id: "nav.findInFiles",
    group: "Navigation",
    descriptionKey: "shortcut_nav_find_in_files",
    keys: { mac: ["⌘", "⇧", "F"], other: ["Ctrl", "Shift", "F"] },
  },
  {
    id: "nav.workspaceSymbols",
    group: "Navigation",
    descriptionKey: "shortcut_nav_workspace_symbols",
    keys: { mac: ["⌘", "⌥", "O"], other: ["Ctrl", "Alt", "O"] },
  },
  // Split editor — second pane side by side with independent tabs +
  // editor mode. Toggle: with one pane open, splits; with two open,
  // collapses back to single-pane.
  {
    id: "view.splitEditor",
    group: "Tabs",
    descriptionKey: "shortcut_view_split_editor",
    keys: { mac: ["⌘", "\\"], other: ["Ctrl", "\\"] },
  },
  {
    id: "view.focusFirstPane",
    group: "Tabs",
    descriptionKey: "shortcut_view_focus_first_pane",
    keys: { mac: ["⌘", "1"], other: ["Ctrl", "1"] },
  },
  {
    id: "view.focusSecondPane",
    group: "Tabs",
    descriptionKey: "shortcut_view_focus_second_pane",
    keys: { mac: ["⌘", "2"], other: ["Ctrl", "2"] },
  },
  // ── View ────────────────────────────────────────────────────────────────
  {
    id: "view.toggleReaderMode",
    group: "Help",
    descriptionKey: "shortcut_view_reader_mode",
    keys: { mac: ["⌘", "."], other: ["Ctrl", "."] },
  },
  // ── Help ────────────────────────────────────────────────────────────────
  {
    id: "help.shortcuts",
    group: "Help",
    descriptionKey: "shortcut_help_shortcuts",
    keys: { mac: ["⌘", "/"], other: ["Ctrl", "/"] },
  },
];

/**
 * Detects the platform that the host is running on. Pulled out of the
 * descriptor module so tests can drive it explicitly without monkeying
 * with `navigator`.
 */
export function detectPlatform(platform: string): Platform {
  return platform.startsWith("Mac") ? "mac" : "other";
}

/** Returns the modifier+key list for the active platform, in display order. */
export function shortcutKeys(s: ShortcutDescriptor, platform: Platform): readonly string[] {
  return platform === "mac" ? s.keys.mac : s.keys.other;
}

/** Groups the catalog by `group`, preserving the order shortcuts appear in. */
export function groupShortcuts(
  shortcuts: readonly ShortcutDescriptor[] = SHORTCUTS,
): Map<ShortcutGroup, ShortcutDescriptor[]> {
  const out = new Map<ShortcutGroup, ShortcutDescriptor[]>();
  for (const shortcut of shortcuts) {
    const bucket = out.get(shortcut.group) ?? [];
    bucket.push(shortcut);
    out.set(shortcut.group, bucket);
  }
  return out;
}
