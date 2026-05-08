/**
 * Command palette catalog — pure data + filter. Commands are everything
 * the user can do that isn't tied to a file path: toggle theme, open
 * folder, refresh, export, change editor mode, etc. The host (apps/*)
 * owns the actual `run` callbacks; this module owns the *shape*.
 */

import type { Platform } from "./keyboard-shortcuts.ts";

export type CommandGroup = "File" | "View" | "Theme" | "Workspace" | "Help" | "Language";

export interface Command {
  /** Stable identifier — used by tests and to dedup the catalog. */
  id: string;
  group: CommandGroup;
  /** Human-readable label shown in the palette. */
  title: string;
  /** Optional secondary text (right-aligned in the row). Currently used
   *  to show the keyboard shortcut bound to this command, when any. */
  shortcut?: { mac: readonly string[]; other: readonly string[] };
  /** Optional predicate; when present and false, the command is hidden.
   *  Used for state-dependent visibility (e.g. "Export PDF" only when a
   *  file is open). */
  when?: () => boolean;
  /** Side-effect to run when the user picks this command. */
  run: () => void | Promise<void>;
}

const GROUP_RANK: Record<CommandGroup, number> = {
  File: 0,
  View: 1,
  Theme: 2,
  Workspace: 3,
  Language: 4,
  Help: 5,
};

/** Maximum number of recently-used command ids retained in storage. */
export const RECENT_COMMANDS_CAP = 5;
const RECENT_COMMANDS_STORAGE_KEY = "asciimark-recent-commands";

/** Minimal storage surface so tests can inject a fake without touching
 *  `globalThis.localStorage` and so the function works in non-DOM
 *  environments without throwing. */
export interface RecentCommandsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): RecentCommandsStorage | null {
  if (typeof globalThis === "undefined") return null;
  const ls = (globalThis as { localStorage?: RecentCommandsStorage }).localStorage;
  return ls ?? null;
}

function readRecentIds(storage: RecentCommandsStorage | null): string[] {
  if (!storage) return [];
  const raw = storage.getItem(RECENT_COMMANDS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/** Returns the MRU command ids (most-recent first), capped at
 *  `RECENT_COMMANDS_CAP`. Reads from localStorage by default; tests pass
 *  an in-memory storage. */
export function getRecentCommandIds(storage?: RecentCommandsStorage | null): string[] {
  const s = storage === undefined ? defaultStorage() : storage;
  return readRecentIds(s).slice(0, RECENT_COMMANDS_CAP);
}

/** Records the given id at the top of the MRU list. Existing occurrences
 *  are deduped (so reusing a command bumps it to the top instead of
 *  duplicating). The list is capped at `RECENT_COMMANDS_CAP`. */
export function recordCommandUse(
  id: string,
  storage?: RecentCommandsStorage | null,
): void {
  const s = storage === undefined ? defaultStorage() : storage;
  if (!s) return;
  const current = readRecentIds(s).filter((existing) => existing !== id);
  const next = [id, ...current].slice(0, RECENT_COMMANDS_CAP);
  s.setItem(RECENT_COMMANDS_STORAGE_KEY, JSON.stringify(next));
}

/**
 * Returns the visible commands for the given query, ordered by:
 *   1. exact title prefix match (case-insensitive)
 *   2. substring match in title
 *   3. substring match in group name
 *   4. group rank, then title alphabetical
 *
 * Mutation-survival contracts (locked in by `command-palette.test.ts`):
 *   - Removing the prefix-bonus collapses 1-2 into one tier and the
 *     "exact prefix outranks substring" assertion fails.
 *   - Letting a `when() === false` command through fails the
 *     "hidden commands are filtered" assertion.
 *   - Returning duplicates by id fails the "ids unique in result" guard.
 *   - Dropping the `recentIds` prepend leaves the empty-query result
 *     sorted alphabetically only, breaking MRU recency tests.
 *
 * When `query === ""` and `recentIds` are supplied, recent ids are
 * pulled to the top (most-recent first) and the rest follow grouped
 * alphabetically. Recents that no longer match a visible command (e.g.
 * gated by `when()`) are silently skipped.
 */
export function filterCommands(
  query: string,
  commands: readonly Command[],
  recentIds: readonly string[] = [],
): Command[] {
  const visible = commands.filter((c) => !c.when || c.when());

  if (query === "") {
    const byId = new Map(visible.map((c) => [c.id, c] as const));
    const recents: Command[] = [];
    const seen = new Set<string>();
    for (const id of recentIds) {
      const cmd = byId.get(id);
      if (cmd && !seen.has(id)) {
        recents.push(cmd);
        seen.add(id);
      }
    }
    const rest = visible
      .filter((c) => !seen.has(c.id))
      .sort((a, b) => {
        const groupCmp = GROUP_RANK[a.group] - GROUP_RANK[b.group];
        if (groupCmp !== 0) return groupCmp;
        return a.title.localeCompare(b.title);
      });
    return [...recents, ...rest];
  }

  const q = query.toLowerCase();
  type Scored = { command: Command; tier: number; titleIdx: number };
  const scored: Scored[] = [];

  for (const command of visible) {
    const title = command.title.toLowerCase();
    const group = command.group.toLowerCase();
    const titleIdx = title.indexOf(q);
    if (titleIdx === 0) {
      scored.push({ command, tier: 0, titleIdx });
      continue;
    }
    if (titleIdx > 0) {
      scored.push({ command, tier: 1, titleIdx });
      continue;
    }
    if (group.includes(q)) {
      scored.push({ command, tier: 2, titleIdx: 0 });
    }
  }

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier <= 1 && a.titleIdx !== b.titleIdx) return a.titleIdx - b.titleIdx;
    const groupCmp = GROUP_RANK[a.command.group] - GROUP_RANK[b.command.group];
    if (groupCmp !== 0) return groupCmp;
    return a.command.title.localeCompare(b.command.title);
  });

  return scored.map((s) => s.command);
}

export function commandShortcutLabel(
  shortcut: Command["shortcut"],
  platform: Platform,
): string {
  if (!shortcut) return "";
  const tokens = platform === "mac" ? shortcut.mac : shortcut.other;
  return tokens.join(platform === "mac" ? " " : "+");
}
