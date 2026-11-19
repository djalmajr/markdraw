import { beforeEach, describe, expect, it } from "bun:test";
import {
  LEGACY_STORAGE_KEY,
  OPEN_ROOTS_STORAGE_KEY,
  PENDING_TAB_ROOTS_STORAGE_KEY,
  clearTabSession,
  getOpenRoots,
  getPendingTabRoots,
  getTabSession,
  loadOpenRoots,
  makeTabId,
  migrateLegacyTabSession,
  parseTabId,
  planTabRestore,
  setOpenRoots,
  setPendingTabRoots,
  setTabSession,
  type PersistedTabSession,
} from "./tabs.ts";
import { installLocalStorageMock } from "./test-utils.ts";

installLocalStorageMock();

describe("tab id encoding", () => {
  it("makeTabId joins rootId and filePath with the :: separator", () => {
    expect(makeTabId("root-1", "notes/a.md")).toBe("root-1::notes/a.md");
  });

  it("parseTabId is the inverse of makeTabId", () => {
    const tabId = makeTabId("root-1", "notes/a.md");
    expect(parseTabId(tabId)).toEqual({ rootId: "root-1", filePath: "notes/a.md" });
  });

  it("parseTabId tolerates ids without separator (legacy / non-prefixed)", () => {
    expect(parseTabId("plain-path.md")).toEqual({ rootId: "", filePath: "plain-path.md" });
  });

  it("parseTabId only splits on the first :: so paths with :: survive", () => {
    expect(parseTabId("root::a::b.md")).toEqual({ rootId: "root", filePath: "a::b.md" });
  });
});

describe("tab session persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when nothing is stored", () => {
    expect(getTabSession()).toBeNull();
  });

  it("round-trips a valid session", () => {
    const session: PersistedTabSession = {
      activeTabId: "r::a.md",
      tabs: [
        {
          editorMode: "split",
          fileName: "a.md",
          filePath: "a.md",
          id: "r::a.md",
          isPinned: false,
          rootId: "r",
        },
      ],
    };

    setTabSession(session);
    expect(getTabSession()).toEqual(session);
  });

  it("strips runtime-only fields when persisting (only canonical fields go to storage)", () => {
    const session = {
      activeTabId: "r::a.md",
      tabs: [
        {
          editorMode: "edit" as const,
          fileName: "a.md",
          filePath: "a.md",
          id: "r::a.md",
          isPinned: true,
          rootId: "r",
          // Runtime-only field that should NOT be persisted:
          editorContent: "should not survive",
        },
      ],
    };
    setTabSession(session as unknown as PersistedTabSession);
    const raw = JSON.parse(localStorage.getItem("markdraw-tab-session")!);
    expect(raw.tabs[0]).not.toHaveProperty("editorContent");
  });

  it("filters out malformed tab entries on read", () => {
    localStorage.setItem(
      "markdraw-tab-session",
      JSON.stringify({
        activeTabId: "r::a",
        tabs: [
          { id: "r::a", filePath: "a", rootId: "r", fileName: "a", isPinned: false, editorMode: "edit" },
          { broken: true },
          { id: "r::b", filePath: "b", rootId: "r", fileName: "b", isPinned: "yes", editorMode: "edit" },
          { id: "r::c", filePath: "c", rootId: "r", fileName: "c", isPinned: false, editorMode: "weird" },
        ],
      }),
    );
    const session = getTabSession();
    expect(session?.tabs).toHaveLength(1);
    expect(session?.tabs[0]?.id).toBe("r::a");
  });

  it("returns null when stored payload has no valid tabs", () => {
    localStorage.setItem("markdraw-tab-session", JSON.stringify({ tabs: [], activeTabId: null }));
    expect(getTabSession()).toBeNull();
  });

  it("returns null on malformed JSON instead of throwing", () => {
    localStorage.setItem("markdraw-tab-session", "{not json");
    expect(getTabSession()).toBeNull();
  });

  it("clearTabSession removes the storage key", () => {
    setTabSession({
      activeTabId: null,
      tabs: [
        {
          editorMode: "edit",
          fileName: "a",
          filePath: "a",
          id: "r::a",
          isPinned: false,
          rootId: "r",
        },
      ],
    });
    clearTabSession();
    expect(localStorage.getItem("markdraw-tab-session")).toBeNull();
  });

  it("get/setTabSession respect a custom storage key (per-pane scope)", () => {
    // Domain rule: each pane writes to its own slot so two panes do
    // not clobber each other's tab list.
    const session: PersistedTabSession = {
      activeTabId: "r::a",
      tabs: [
        { editorMode: "edit", fileName: "a", filePath: "a", id: "r::a", isPinned: true, rootId: "r" },
      ],
    };
    setTabSession(session, "markdraw-tab-session-pane-0");
    setTabSession({ ...session, activeTabId: "r::b", tabs: [{ ...session.tabs[0]!, id: "r::b", filePath: "b", fileName: "b" }] }, "markdraw-tab-session-pane-1");

    expect(getTabSession("markdraw-tab-session-pane-0")?.activeTabId).toBe("r::a");
    expect(getTabSession("markdraw-tab-session-pane-1")?.activeTabId).toBe("r::b");
    // Default key (legacy) untouched.
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });
});

describe("migrateLegacyTabSession", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("copies the legacy single-pane key into a pane-scoped key and clears the legacy slot", () => {
    // Mutation captured: removing the `localStorage.removeItem(LEGACY_STORAGE_KEY)`
    // line would leave the legacy slot in place — test fails by detecting
    // that the legacy key still has the payload.
    const session: PersistedTabSession = {
      activeTabId: "r::x",
      tabs: [{ editorMode: "preview", fileName: "x", filePath: "x", id: "r::x", isPinned: true, rootId: "r" }],
    };
    setTabSession(session); // writes to legacy
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();

    const moved = migrateLegacyTabSession("markdraw-tab-session-pane-0");
    expect(moved).toBe(true);
    expect(localStorage.getItem("markdraw-tab-session-pane-0")).not.toBeNull();
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it("is a no-op when the target slot already has data", () => {
    setTabSession({ activeTabId: null, tabs: [{ editorMode: "edit", fileName: "x", filePath: "x", id: "r::x", isPinned: true, rootId: "r" }] }); // legacy
    setTabSession({ activeTabId: null, tabs: [{ editorMode: "edit", fileName: "y", filePath: "y", id: "r::y", isPinned: true, rootId: "r" }] }, "markdraw-tab-session-pane-0");

    const moved = migrateLegacyTabSession("markdraw-tab-session-pane-0");
    expect(moved).toBe(false);
    expect(getTabSession("markdraw-tab-session-pane-0")?.activeTabId).toBeNull();
    expect(getTabSession("markdraw-tab-session-pane-0")?.tabs[0]?.id).toBe("r::y");
  });

  it("returns false when there is nothing to migrate", () => {
    expect(migrateLegacyTabSession("markdraw-tab-session-pane-0")).toBe(false);
  });

  it("refuses to migrate to the legacy key (no self-loop)", () => {
    setTabSession({ activeTabId: null, tabs: [{ editorMode: "edit", fileName: "x", filePath: "x", id: "r::x", isPinned: true, rootId: "r" }] });
    expect(migrateLegacyTabSession(LEGACY_STORAGE_KEY)).toBe(false);
  });
});

describe("open roots persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips the open roots as { id, path } under its own key", () => {
    setOpenRoots([
      { id: "/notes", path: "/notes" },
      { id: "/plans", path: "/plans" },
    ]);

    expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_STORAGE_KEY)!)).toEqual([
      { id: "/notes", path: "/notes" },
      { id: "/plans", path: "/plans" },
    ]);
    expect(getOpenRoots()).toEqual([
      { id: "/notes", path: "/notes" },
      { id: "/plans", path: "/plans" },
    ]);
    // The tab session key is untouched by the root list.
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it("keeps the same folder opened twice once, in first-seen order", () => {
    setOpenRoots([
      { id: "/notes", path: "/notes" },
      { id: "/plans", path: "/plans" },
      { id: "/notes", path: "/notes" },
    ]);
    expect(getOpenRoots().map((root) => root.path)).toEqual(["/notes", "/plans"]);
  });

  it("records 'nothing is open' as an empty inventory, not as a missing key", () => {
    setOpenRoots([{ id: "/notes", path: "/notes" }]);
    setOpenRoots([]);
    expect(localStorage.getItem(OPEN_ROOTS_STORAGE_KEY)).toBe("[]");
    expect(getOpenRoots()).toEqual([]);
    expect(loadOpenRoots()).toEqual([]);
  });

  it("tells a missing or unusable inventory (null) from an empty one", () => {
    // A version that predates the key: no inventory, so nothing may be dropped.
    expect(loadOpenRoots()).toBeNull();
    expect(getOpenRoots()).toEqual([]);
    for (const raw of ["{not json", JSON.stringify({ path: "/notes" }), JSON.stringify(["/notes"]), ""]) {
      localStorage.setItem(OPEN_ROOTS_STORAGE_KEY, raw);
      expect(loadOpenRoots()).toBeNull();
    }
    localStorage.setItem(OPEN_ROOTS_STORAGE_KEY, "[]");
    expect(loadOpenRoots()).toEqual([]);
  });

  it("round-trips many roots", () => {
    const roots = Array.from({ length: 40 }, (_, i) => ({ id: `/root-${i}`, path: `/root-${i}` }));
    setOpenRoots(roots);
    expect(getOpenRoots()).toEqual(roots);
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["a non-array payload", JSON.stringify({ path: "/notes" })],
    ["an older shape with bare strings", JSON.stringify(["/notes"])],
    ["an entry missing its path", JSON.stringify([{ id: 1, path: null }])],
    ["an empty string", ""],
  ])("ignores %s instead of failing the reload", (_label, raw) => {
    localStorage.setItem(OPEN_ROOTS_STORAGE_KEY, raw);
    expect(getOpenRoots()).toEqual([]);
  });

  it("drops an entry with an empty path but keeps the valid ones", () => {
    localStorage.setItem(
      OPEN_ROOTS_STORAGE_KEY,
      JSON.stringify([{ id: "/notes", path: "/notes" }, { id: "", path: "" }]),
    );
    expect(getOpenRoots()).toEqual([{ id: "/notes", path: "/notes" }]);
  });
});

describe("pending tab roots", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips the ids, deduped and without empty ones", () => {
    setPendingTabRoots(["/notes", "/plans", "/notes", ""]);
    expect(getPendingTabRoots()).toEqual(["/notes", "/plans"]);
  });

  it("removes the key when nothing is pending", () => {
    setPendingTabRoots(["/notes"]);
    setPendingTabRoots([]);
    expect(localStorage.getItem(PENDING_TAB_ROOTS_STORAGE_KEY)).toBeNull();
    expect(getPendingTabRoots()).toEqual([]);
  });

  it("reads corrupt or foreign-shaped storage as none", () => {
    for (const raw of ["{not json", JSON.stringify({ roots: ["/notes"] }), JSON.stringify([1, 2])]) {
      localStorage.setItem(PENDING_TAB_ROOTS_STORAGE_KEY, raw);
      expect(getPendingTabRoots()).toEqual([]);
    }
  });
});

describe("planTabRestore", () => {
  const tab = (rootId: string, filePath: string, id = makeTabId(rootId, filePath)) => ({
    id,
    filePath,
    rootId,
    fileName: filePath,
    isPinned: false,
    editorMode: "edit" as const,
  });

  const session: PersistedTabSession = {
    activeTabId: "root-b::b.md",
    tabs: [tab("root-a", "a.md"), tab("root-b", "b.md")],
  };

  it("restores only the tabs of the roots that just opened", () => {
    const plan = planTabRestore(session, ["root-a"], new Set());
    expect(plan.rootIds).toEqual(["root-a"]);
    expect(plan.tabs.map((t) => t.filePath)).toEqual(["a.md"]);
    // The persisted active tab belongs to root-b, which is not open.
    expect(plan.activeTabId).toBeNull();
  });

  it("skips roots already restored and restores the next root's own tabs", () => {
    const restored = new Set<string>();
    const first = planTabRestore(session, ["root-a"], restored);
    for (const rootId of first.rootIds) restored.add(rootId);

    const second = planTabRestore(session, ["root-a", "root-b"], restored);
    for (const rootId of second.rootIds) restored.add(rootId);
    expect(second.rootIds).toEqual(["root-b"]);
    expect(second.tabs.map((t) => t.filePath)).toEqual(["b.md"]);
    expect(second.activeTabId).toBe("root-b::b.md");

    const third = planTabRestore(session, ["root-a", "root-b"], restored);
    expect(third).toEqual({ rootIds: [], tabs: [], activeTabId: null });
  });

  it("returns nothing to restore when no session was persisted", () => {
    const plan = planTabRestore(null, ["root-a"], new Set());
    expect(plan.rootIds).toEqual(["root-a"]);
    expect(plan.tabs).toEqual([]);
    expect(plan.activeTabId).toBeNull();
  });

  it("ignores the persisted active tab when it points at a tab outside the batch", () => {
    const plan = planTabRestore({ ...session, activeTabId: "root-c::c.md" }, ["root-a", "root-b"], new Set());
    expect(plan.tabs).toHaveLength(2);
    expect(plan.activeTabId).toBeNull();
  });
});
