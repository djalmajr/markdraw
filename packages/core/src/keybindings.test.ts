import { beforeEach, describe, expect, it } from "bun:test";
import {
  type KeyEventLike,
  effectiveKeys,
  formatBinding,
  getStoredKeybindings,
  matchBinding,
  parseBinding,
  resetStoredKeybinding,
  setStoredKeybinding,
} from "./keybindings.ts";
import { installLocalStorageMock } from "./test-utils.ts";

installLocalStorageMock();

function ev(over: Partial<KeyEventLike>): KeyEventLike {
  return { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: "", ...over };
}

describe("parseBinding", () => {
  it("parses mac glyph tokens", () => {
    expect(parseBinding(["⌘", "⇧", "P"])).toEqual({ meta: true, ctrl: false, shift: true, alt: false, key: "p" });
  });
  it("parses Ctrl/Alt tokens as literal modifiers", () => {
    expect(parseBinding(["Ctrl", "Alt", "O"])).toEqual({ meta: false, ctrl: true, shift: false, alt: true, key: "o" });
  });
  it("treats the last non-modifier token as the key", () => {
    expect(parseBinding(["⌘", "Tab"]).key).toBe("tab");
  });
});

describe("matchBinding", () => {
  it("matches Cmd+P against ['⌘','P']", () => {
    expect(matchBinding(ev({ metaKey: true, key: "p" }), ["⌘", "P"])).toBe(true);
  });
  it("rejects Ctrl+P against ['⌘','P'] (meta mismatch)", () => {
    expect(matchBinding(ev({ ctrlKey: true, key: "p" }), ["⌘", "P"])).toBe(false);
  });
  it("requires shift to match exactly (⌘T ≠ ⌘⇧T)", () => {
    expect(matchBinding(ev({ metaKey: true, shiftKey: true, key: "t" }), ["⌘", "T"])).toBe(false);
    expect(matchBinding(ev({ metaKey: true, shiftKey: true, key: "t" }), ["⌘", "⇧", "T"])).toBe(true);
  });
  it("requires alt to match exactly", () => {
    expect(matchBinding(ev({ metaKey: true, key: "o" }), ["⌘", "⌥", "O"])).toBe(false);
    expect(matchBinding(ev({ metaKey: true, altKey: true, key: "o" }), ["⌘", "⌥", "O"])).toBe(true);
  });
  it("is case-insensitive on the key", () => {
    expect(matchBinding(ev({ metaKey: true, key: "L" }), ["⌘", "l"])).toBe(true);
  });
  it("matches literal Ctrl bindings (Ctrl+P, and ⌃Tab on macOS)", () => {
    expect(matchBinding(ev({ ctrlKey: true, key: "p" }), ["Ctrl", "P"])).toBe(true);
    expect(matchBinding(ev({ metaKey: true, key: "p" }), ["Ctrl", "P"])).toBe(false);
    // ⌃Tab to cycle tabs — uses real Ctrl even on macOS.
    expect(matchBinding(ev({ ctrlKey: true, key: "Tab", code: "Tab" }), ["⌃", "Tab"])).toBe(true);
  });
  it("returns false for an empty/modifier-only binding", () => {
    expect(matchBinding(ev({ metaKey: true, key: "Meta" }), ["⌘"])).toBe(false);
  });

  it("falls back to e.code for Option-composed keys (⌥O → key 'ø', code 'KeyO')", () => {
    expect(matchBinding(ev({ metaKey: true, altKey: true, key: "ø", code: "KeyO" }), ["⌘", "⌥", "O"])).toBe(true);
  });

  it("matches punctuation/digit codes (⌘\\ , ⌘1)", () => {
    expect(matchBinding(ev({ metaKey: true, key: "\\", code: "Backslash" }), ["⌘", "\\"])).toBe(true);
    expect(matchBinding(ev({ metaKey: true, key: "1", code: "Digit1" }), ["⌘", "1"])).toBe(true);
  });
});

describe("formatBinding", () => {
  it("joins with a space on mac and + elsewhere", () => {
    expect(formatBinding(["⌘", "P"], "mac")).toBe("⌘ P");
    expect(formatBinding(["Ctrl", "P"], "other")).toBe("Ctrl+P");
  });
});

describe("persistence + effectiveKeys", () => {
  beforeEach(() => {
    installLocalStorageMock();
    localStorage.clear();
  });

  it("falls back to the catalog default when there is no override", () => {
    expect(effectiveKeys("ai.openChat", "mac")).toEqual(["⌘", "L"]);
    expect(effectiveKeys("ai.openChat", "other")).toEqual(["Ctrl", "L"]);
  });

  it("round-trips an override and applies it via effectiveKeys", () => {
    setStoredKeybinding("ai.openChat", { mac: ["⌘", "J"], other: ["Ctrl", "J"] });
    expect(getStoredKeybindings()["ai.openChat"]).toEqual({ mac: ["⌘", "J"], other: ["Ctrl", "J"] });
    expect(effectiveKeys("ai.openChat", "mac")).toEqual(["⌘", "J"]);
  });

  it("reset reverts to the default", () => {
    setStoredKeybinding("ai.openChat", { mac: ["⌘", "J"], other: ["Ctrl", "J"] });
    resetStoredKeybinding("ai.openChat");
    expect(effectiveKeys("ai.openChat", "mac")).toEqual(["⌘", "L"]);
  });

  it("ignores malformed stored entries", () => {
    localStorage.setItem("markdraw-keybindings", JSON.stringify({ "ai.openChat": { mac: "nope" } }));
    expect(getStoredKeybindings()).toEqual({});
    expect(effectiveKeys("ai.openChat", "mac")).toEqual(["⌘", "L"]);
  });

  it("returns [] for an unknown shortcut id", () => {
    expect(effectiveKeys("does.not.exist", "mac")).toEqual([]);
  });
});
