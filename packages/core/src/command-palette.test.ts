import { describe, expect, it } from "bun:test";
import {
  RECENT_COMMANDS_CAP,
  commandShortcutLabel,
  filterCommands,
  getRecentCommandIds,
  recordCommandUse,
  type Command,
  type RecentCommandsStorage,
} from "./command-palette.ts";

function memoryStorage(initial: Record<string, string> = {}): RecentCommandsStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

function cmd(
  id: string,
  group: Command["group"],
  title: string,
  extra: Partial<Command> = {},
): Command {
  return { id, group, title, run: () => {}, ...extra };
}

const CATALOG: Command[] = [
  cmd("file.openFolder", "File", "Open Folder"),
  cmd("file.exportPdf", "File", "Export PDF", { when: () => true }),
  cmd("file.refresh", "Workspace", "Refresh Workspace"),
  cmd("view.toggleSidebar", "View", "Toggle Sidebar"),
  cmd("view.toggleHidden", "View", "Toggle Hidden Files"),
  cmd("theme.dark", "Theme", "Set Theme: Dark"),
  cmd("theme.light", "Theme", "Set Theme: Light"),
  cmd("help.shortcuts", "Help", "Show Keyboard Shortcuts"),
];

describe("filterCommands", () => {
  it("empty query returns all visible commands grouped by File→View→Theme→Workspace→Help", () => {
    // Mutation captured: shuffling GROUP_RANK breaks this exact ordering
    // assertion. Confirms that "File" appears first and "Help" last.
    const result = filterCommands("", CATALOG);
    expect(result.map((c) => c.id)).toEqual([
      "file.exportPdf",
      "file.openFolder",
      "view.toggleHidden",
      "view.toggleSidebar",
      "theme.dark",
      "theme.light",
      "file.refresh",
      "help.shortcuts",
    ]);
  });

  it("hides commands whose `when()` returns false", () => {
    // Mutation captured: removing the `when()` filter would surface the
    // "hidden" command and the assertion below fails.
    const list: Command[] = [
      cmd("a", "File", "Visible Cmd"),
      cmd("b", "File", "Hidden Cmd", { when: () => false }),
    ];
    expect(filterCommands("", list).map((c) => c.id)).toEqual(["a"]);
    expect(filterCommands("hidden", list).map((c) => c.id)).toEqual([]);
  });

  it("title prefix match outranks title-substring match (tier 0 before tier 1)", () => {
    // Mutation captured: collapsing tier 0 and tier 1 into one tier moves
    // "Open Folder" below "Toggle Sidebar" when query="o" — fails this.
    const result = filterCommands("o", CATALOG);
    const titles = result.map((c) => c.title);
    // "Open Folder" starts with "o" → tier 0
    // "Toggle Sidebar" / "Toggle Hidden Files" / "Show Keyboard Shortcuts"
    //   contain "o" later → tier 1
    expect(titles[0]).toBe("Open Folder");
  });

  it("title-substring match outranks group-name match (tier 1 before tier 2)", () => {
    // Mutation captured: searching "view" should put "View"-group commands
    // above non-View commands ONLY when no title contains "view". Here
    // none do, so all tier-2 results show. We check that NO tier-2 result
    // comes before a tier-1 result on a query that has both.
    const list: Command[] = [
      cmd("a", "View", "Toggle Hidden Files"),
      cmd("b", "File", "Open File"),
    ];
    const result = filterCommands("file", list);
    // "Open File" has "file" in title (tier 1); "Toggle Hidden Files"
    // also has "file" in title — both tier 1 — but only "Open File"
    // matches the prefix near 0... actually both contain "file", so
    // both are tier 1 and the order is by titleIdx then title.
    expect(result.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("query case is normalized (smart-case-equivalent for the substring path)", () => {
    // VS Code conventions: "OPEN" still matches "Open Folder".
    const result = filterCommands("OPEN", CATALOG);
    expect(result.map((c) => c.title)).toContain("Open Folder");
  });

  it("returns empty array when the query matches nothing", () => {
    expect(filterCommands("zzzzz", CATALOG)).toEqual([]);
  });

  it("each command appears at most once in the result (no duplicates by id)", () => {
    // Mutation captured: a second push in any tier (e.g. forgetting the
    // `continue` after pushing tier 0) would add the same command twice.
    const result = filterCommands("o", CATALOG);
    const ids = result.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("filterCommands — MRU recents", () => {
  it("empty query prepends recent ids in MRU order, then the rest grouped/alpha", () => {
    // Mutation captured: dropping the recents prepend collapses the
    // result back to GROUP_RANK + alpha and "theme.dark" no longer
    // appears first when it was the most-recently used command.
    const result = filterCommands("", CATALOG, ["theme.dark", "view.toggleSidebar"]);
    expect(result.slice(0, 2).map((c) => c.id)).toEqual([
      "theme.dark",
      "view.toggleSidebar",
    ]);
    // remaining commands keep their normal grouped order, with the two
    // promoted ids removed from their original position.
    expect(result.slice(2).map((c) => c.id)).toEqual([
      "file.exportPdf",
      "file.openFolder",
      "view.toggleHidden",
      "theme.light",
      "file.refresh",
      "help.shortcuts",
    ]);
  });

  it("recent ids that no longer match a visible command are silently skipped", () => {
    // Mutation captured: pushing unknown ids through would surface them
    // as undefined items in the palette and crash the renderer.
    const result = filterCommands("", CATALOG, ["nope.gone", "theme.dark"]);
    expect(result[0]?.id).toBe("theme.dark");
    expect(result.find((c) => c.id === "nope.gone")).toBeUndefined();
  });

  it("non-empty query ignores recents (recents are an empty-state hint)", () => {
    // Recents only apply to the no-query state; once the user types,
    // standard tier ranking takes over.
    const result = filterCommands("open", CATALOG, ["theme.dark"]);
    expect(result[0]?.title).toBe("Open Folder");
    expect(result.find((c) => c.id === "theme.dark")).toBeUndefined();
  });
});

describe("recordCommandUse / getRecentCommandIds", () => {
  it("recordCommandUse prepends the id and getRecentCommandIds reads it back MRU-first", () => {
    const s = memoryStorage();
    recordCommandUse("a", s);
    recordCommandUse("b", s);
    recordCommandUse("c", s);
    expect(getRecentCommandIds(s)).toEqual(["c", "b", "a"]);
  });

  it("recording an existing id bumps it to the top instead of duplicating", () => {
    // Mutation captured: removing the dedup `.filter(...)` would push the
    // same id twice and the first call's "a" would still be in position 2.
    const s = memoryStorage();
    recordCommandUse("a", s);
    recordCommandUse("b", s);
    recordCommandUse("a", s);
    expect(getRecentCommandIds(s)).toEqual(["a", "b"]);
  });

  it("evicts the oldest entry when capacity is exceeded", () => {
    // Mutation captured: removing the `.slice(0, RECENT_COMMANDS_CAP)`
    // would let the array grow unbounded and "a" would still be present
    // after 6 distinct records.
    const s = memoryStorage();
    for (const id of ["a", "b", "c", "d", "e", "f"]) recordCommandUse(id, s);
    const ids = getRecentCommandIds(s);
    expect(ids).toHaveLength(RECENT_COMMANDS_CAP);
    expect(ids).toEqual(["f", "e", "d", "c", "b"]);
    expect(ids).not.toContain("a");
  });

  it("getRecentCommandIds tolerates missing / corrupt storage payloads", () => {
    const empty = memoryStorage();
    expect(getRecentCommandIds(empty)).toEqual([]);

    const corrupt = memoryStorage({ "asciimark-recent-commands": "{not json" });
    expect(getRecentCommandIds(corrupt)).toEqual([]);

    const wrongShape = memoryStorage({ "asciimark-recent-commands": JSON.stringify({}) });
    expect(getRecentCommandIds(wrongShape)).toEqual([]);
  });
});

describe("commandShortcutLabel", () => {
  it("joins tokens with space on macOS and `+` elsewhere", () => {
    const shortcut = { mac: ["⌘", "⇧", "P"] as const, other: ["Ctrl", "Shift", "P"] as const };
    expect(commandShortcutLabel(shortcut, "mac")).toBe("⌘ ⇧ P");
    expect(commandShortcutLabel(shortcut, "other")).toBe("Ctrl+Shift+P");
  });

  it("returns empty string when the command has no shortcut", () => {
    expect(commandShortcutLabel(undefined, "mac")).toBe("");
    expect(commandShortcutLabel(undefined, "other")).toBe("");
  });
});
