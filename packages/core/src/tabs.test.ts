import { beforeEach, describe, expect, it } from "bun:test";
import {
  LEGACY_STORAGE_KEY,
  clearTabSession,
  getTabSession,
  makeTabId,
  migrateLegacyTabSession,
  parseTabId,
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
