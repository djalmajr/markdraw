// Configurable keybindings: parse the shortcut catalog's key tokens into a
// match-able shape, test them against a keyboard event, and persist per-user
// overrides. Pure + DOM-free (the event is passed in as a plain shape) so it
// stays unit-testable and `core` keeps no platform/DOM coupling.

import { SHORTCUTS, type Platform } from "./keyboard-shortcuts.ts";

const STORAGE_KEY = "markdraw-keybindings";

/** Normalized binding: LITERAL modifier flags + the bare key (lower-cased).
 *  Modifiers are literal (not a platform "mod" abstraction) because the catalog
 *  already stores platform-specific tokens — `⌘` on macOS, `Ctrl` elsewhere —
 *  and some shortcuts use real Ctrl on macOS too (e.g. ⌃Tab to cycle tabs). */
export interface ParsedBinding {
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** The non-modifier key, lower-cased ("p", "tab", "/", …). Empty when the
   *  binding is modifier-only or unset. */
  key: string;
}

/** Per-shortcut override; both platform variants stored so a binding set on one
 *  OS doesn't silently wipe the other. */
export interface KeybindingOverride {
  mac: string[];
  other: string[];
}

const META_TOKENS = new Set(["⌘", "cmd", "command", "meta"]);
const CTRL_TOKENS = new Set(["⌃", "ctrl", "control"]);
const SHIFT_TOKENS = new Set(["⇧", "shift"]);
const ALT_TOKENS = new Set(["⌥", "alt", "option", "opt"]);

/** Map a key-token array (e.g. `["⌘","⇧","P"]` or `["Ctrl","Shift","P"]`) to a
 *  normalized binding. The last non-modifier token is the bare key. */
export function parseBinding(keys: readonly string[]): ParsedBinding {
  let meta = false;
  let ctrl = false;
  let shift = false;
  let alt = false;
  let key = "";
  for (const token of keys) {
    const t = token.toLowerCase();
    if (META_TOKENS.has(token) || META_TOKENS.has(t)) meta = true;
    else if (CTRL_TOKENS.has(token) || CTRL_TOKENS.has(t)) ctrl = true;
    else if (SHIFT_TOKENS.has(token) || SHIFT_TOKENS.has(t)) shift = true;
    else if (ALT_TOKENS.has(token) || ALT_TOKENS.has(t)) alt = true;
    else key = t;
  }
  return { meta, ctrl, shift, alt, key };
}

/** The subset of a KeyboardEvent the matcher needs. `code` (physical key) is
 *  used as a fallback so Option-composed keys (macOS sends `e.key === "ø"` for
 *  ⌥O) and non-US layouts still match. */
export interface KeyEventLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
  code?: string;
}

/** Map a physical `KeyboardEvent.code` to the bare key our tokens use. */
function codeToKey(code: string | undefined): string {
  if (!code) return "";
  if (code.startsWith("Key")) return code.slice(3).toLowerCase(); // KeyO → o
  if (code.startsWith("Digit")) return code.slice(5); // Digit1 → 1
  const punct: Record<string, string> = {
    Slash: "/",
    Backslash: "\\",
    Comma: ",",
    Period: ".",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Minus: "-",
    Equal: "=",
    Backquote: "`",
    Tab: "tab",
    Enter: "enter",
    Space: " ",
  };
  return punct[code] ?? "";
}

/** True when the event matches the binding EXACTLY — every modifier (meta, ctrl,
 *  shift, alt) must equal the binding so ⌘T ≠ ⌘⇧T and Cmd+L ≠ Ctrl+L. Pass the
 *  platform-appropriate key array (see `effectiveKeys`). */
export function matchBinding(e: KeyEventLike, keys: readonly string[]): boolean {
  const b = parseBinding(keys);
  if (!b.key) return false;
  if (b.meta !== e.metaKey || b.ctrl !== e.ctrlKey || b.shift !== e.shiftKey || b.alt !== e.altKey) {
    return false;
  }
  return e.key.toLowerCase() === b.key || codeToKey(e.code) === b.key;
}

/** Render key tokens for display, joined with the platform separator. */
export function formatBinding(keys: readonly string[], platform: Platform): string {
  return keys.join(platform === "mac" ? " " : "+");
}

// ── Persistence ─────────────────────────────────────────────────────────────

export function getStoredKeybindings(): Record<string, KeybindingOverride> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, KeybindingOverride> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as { mac?: unknown; other?: unknown };
      if (Array.isArray(v?.mac) && Array.isArray(v?.other)) {
        out[id] = { mac: v.mac.map(String), other: v.other.map(String) };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function setStoredKeybinding(id: string, keys: KeybindingOverride): void {
  const all = getStoredKeybindings();
  all[id] = { mac: [...keys.mac], other: [...keys.other] };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/** Remove an override (revert to the catalog default). */
export function resetStoredKeybinding(id: string): void {
  const all = getStoredKeybindings();
  if (!(id in all)) return;
  delete all[id];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/** Effective key tokens for a shortcut id on a platform: the user override if
 *  set, else the catalog default, else `[]` for an unknown id. */
export function effectiveKeys(
  id: string,
  platform: Platform,
  overrides: Record<string, KeybindingOverride> = getStoredKeybindings(),
): readonly string[] {
  const override = overrides[id];
  if (override) return platform === "mac" ? override.mac : override.other;
  const def = SHORTCUTS.find((s) => s.id === id);
  if (!def) return [];
  return platform === "mac" ? def.keys.mac : def.keys.other;
}
