import { beforeEach, describe, expect, it } from "bun:test";
import {
  clearTabSession,
  getTabSession,
  makeTabId,
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
    const raw = JSON.parse(localStorage.getItem("asciimark-tab-session")!);
    expect(raw.tabs[0]).not.toHaveProperty("editorContent");
  });

  it("filters out malformed tab entries on read", () => {
    localStorage.setItem(
      "asciimark-tab-session",
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
    localStorage.setItem("asciimark-tab-session", JSON.stringify({ tabs: [], activeTabId: null }));
    expect(getTabSession()).toBeNull();
  });

  it("returns null on malformed JSON instead of throwing", () => {
    localStorage.setItem("asciimark-tab-session", "{not json");
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
    expect(localStorage.getItem("asciimark-tab-session")).toBeNull();
  });
});
