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
  description: string;
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
    description: "Open folder",
    keys: { mac: ["⌘", "O"], other: ["Ctrl", "O"] },
  },
  {
    id: "file.save",
    group: "File",
    description: "Save (auto-save runs 1s after the last edit)",
    keys: { mac: ["⌘", "S"], other: ["Ctrl", "S"] },
  },
  // ── Tabs ────────────────────────────────────────────────────────────────
  {
    id: "tab.new",
    group: "Tabs",
    description: "New tab",
    keys: { mac: ["⌘", "T"], other: ["Ctrl", "T"] },
  },
  {
    id: "tab.close",
    group: "Tabs",
    description: "Close tab",
    keys: { mac: ["⌘", "W"], other: ["Ctrl", "W"] },
  },
  {
    id: "tab.reopen",
    group: "Tabs",
    description: "Reopen last closed tab",
    keys: { mac: ["⌘", "⇧", "T"], other: ["Ctrl", "Shift", "T"] },
  },
  {
    id: "tab.next",
    group: "Tabs",
    description: "Cycle to next tab",
    keys: { mac: ["⌃", "Tab"], other: ["Ctrl", "Tab"] },
  },
  {
    id: "tab.prev",
    group: "Tabs",
    description: "Cycle to previous tab",
    keys: { mac: ["⌃", "⇧", "Tab"], other: ["Ctrl", "Shift", "Tab"] },
  },
  // ── Navigation ──────────────────────────────────────────────────────────
  {
    id: "nav.quickOpen",
    group: "Navigation",
    description: "Quick Open: jump to a file by name",
    keys: { mac: ["⌘", "P"], other: ["Ctrl", "P"] },
  },
  {
    id: "nav.commandPalette",
    group: "Navigation",
    description: "Command Palette: run any command",
    keys: { mac: ["⌘", "⇧", "P"], other: ["Ctrl", "Shift", "P"] },
  },
  {
    id: "nav.goToSymbol",
    group: "Navigation",
    description: "Go to Symbol: jump to a heading in the current file",
    keys: { mac: ["⌘", "⇧", "O"], other: ["Ctrl", "Shift", "O"] },
  },
  {
    id: "nav.findInFiles",
    group: "Navigation",
    description: "Find in Files: search content across the workspace",
    keys: { mac: ["⌘", "⇧", "F"], other: ["Ctrl", "Shift", "F"] },
  },
  {
    id: "nav.workspaceSymbols",
    group: "Navigation",
    description: "Go to Symbol in Workspace: jump to a heading across all docs",
    keys: { mac: ["⌘", "⌥", "O"], other: ["Ctrl", "Alt", "O"] },
  },
  // Split editor — second pane side by side with independent tabs +
  // editor mode. Toggle: with one pane open, splits; with two open,
  // collapses back to single-pane.
  {
    id: "view.splitEditor",
    group: "Tabs",
    description: "Split editor (toggle): open a second pane side by side",
    keys: { mac: ["⌘", "\\"], other: ["Ctrl", "\\"] },
  },
  {
    id: "view.focusFirstPane",
    group: "Tabs",
    description: "Focus the first pane",
    keys: { mac: ["⌘", "1"], other: ["Ctrl", "1"] },
  },
  {
    id: "view.focusSecondPane",
    group: "Tabs",
    description: "Focus the second pane",
    keys: { mac: ["⌘", "2"], other: ["Ctrl", "2"] },
  },
  // ── View ────────────────────────────────────────────────────────────────
  {
    id: "view.toggleReaderMode",
    group: "Help",
    description: "Toggle Reader / Zen mode (hide chrome, center preview)",
    keys: { mac: ["⌘", "."], other: ["Ctrl", "."] },
  },
  // ── Help ────────────────────────────────────────────────────────────────
  {
    id: "help.shortcuts",
    group: "Help",
    description: "Show keyboard shortcuts",
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
