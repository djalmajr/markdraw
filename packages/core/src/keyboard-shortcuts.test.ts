import { describe, expect, it } from "bun:test";
import {
  SHORTCUTS,
  detectPlatform,
  groupShortcuts,
  shortcutKeys,
} from "./keyboard-shortcuts.ts";

describe("keyboard-shortcuts", () => {
  it("detectPlatform maps Mac-prefixed strings to 'mac' and everything else to 'other'", () => {
    // Domain rule: the navigator.platform contract from app.tsx:591 is the
    // only platform discriminator we ship — Mac vs not-Mac.
    expect(detectPlatform("MacIntel")).toBe("mac");
    expect(detectPlatform("MacPPC")).toBe("mac");
    expect(detectPlatform("Win32")).toBe("other");
    expect(detectPlatform("Linux x86_64")).toBe("other");
    expect(detectPlatform("")).toBe("other");
  });

  it("shortcutKeys returns mac and other slots for the same shortcut id", () => {
    // Mutation captured: swapping `keys.mac` and `keys.other` in
    // shortcutKeys would surface here because the ⌘ glyph is mac-only
    // and "Ctrl" is non-mac.
    const newTab = SHORTCUTS.find((s) => s.id === "tab.new")!;
    expect(shortcutKeys(newTab, "mac")).toContain("⌘");
    expect(shortcutKeys(newTab, "other")).toContain("Ctrl");
    expect(shortcutKeys(newTab, "mac")).not.toContain("Ctrl");
    expect(shortcutKeys(newTab, "other")).not.toContain("⌘");
  });

  it("every shortcut has the same final key on both platforms", () => {
    // Domain rule: only the modifier glyph differs between platforms.
    // The bare key (last token) MUST match — otherwise the catalog is
    // describing two unrelated shortcuts under one id.
    for (const shortcut of SHORTCUTS) {
      const macKey = shortcut.keys.mac[shortcut.keys.mac.length - 1];
      const otherKey = shortcut.keys.other[shortcut.keys.other.length - 1];
      expect(macKey).toBe(otherKey);
    }
  });

  it("groupShortcuts preserves the catalog order inside each group", () => {
    const grouped = groupShortcuts();
    const tabs = grouped.get("Tabs") ?? [];
    // The first 5 are the canonical tab shortcuts; the trailing 3 are
    // the split-pane controls (added once split panes shipped — they
    // are conceptually still "Tabs" because they manage panes which
    // hold tab groups).
    expect(tabs.map((s) => s.id).slice(0, 5)).toEqual([
      "tab.new",
      "tab.close",
      "tab.reopen",
      "tab.next",
      "tab.prev",
    ]);
    expect(tabs.map((s) => s.id)).toContain("view.splitEditor");
    expect(tabs.map((s) => s.id)).toContain("view.focusFirstPane");
    expect(tabs.map((s) => s.id)).toContain("view.focusSecondPane");
  });

  it("shortcut ids are unique across the entire catalog", () => {
    // Regression guard: a duplicate id would silently shadow the
    // earlier descriptor in lookup helpers callers may build.
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("contains the four canonical groups", () => {
    const groups = new Set(SHORTCUTS.map((s) => s.group));
    expect(groups).toEqual(new Set(["File", "Tabs", "Navigation", "Help"]));
  });

  it("every shortcut exposes a non-empty descriptionKey for the i18n consumer", () => {
    // Mutation captured: dropping `descriptionKey` from any descriptor (or
    // setting it to an empty string) would leave ShortcutsHelp rendering
    // a blank label instead of the translated one.
    for (const shortcut of SHORTCUTS) {
      expect(typeof shortcut.descriptionKey).toBe("string");
      expect(shortcut.descriptionKey.length).toBeGreaterThan(0);
    }
  });

  it("descriptionKey values are unique across the catalog", () => {
    // Two shortcuts sharing a key would mean translators only get one
    // label for two distinct actions.
    const keys = SHORTCUTS.map((s) => s.descriptionKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
