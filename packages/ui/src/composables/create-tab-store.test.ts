import { beforeEach, describe, expect, it } from "bun:test";
import { createRoot } from "solid-js";
import type { FSEntry } from "@markdraw/core/types.ts";
import { installLocalStorageMock } from "@markdraw/core/test-utils.ts";
import { createTabStore } from "./create-tab-store.ts";
import { createPaneStore } from "./create-pane-store.ts";

installLocalStorageMock();

function entry(name: string, path = name): FSEntry {
  return { name, path, kind: "file" };
}

function withStore<T>(fn: (store: ReturnType<typeof createTabStore>) => T): T {
  // The TabStore now binds to a PaneStore (the per-pane signal slice).
  // Tests that don't care about the pane just use a fresh one.
  return createRoot(() => fn(createTabStore({ pane: createPaneStore("test") })));
}

describe("createTabStore", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts with no tabs and no active id", () => {
    withStore((store) => {
      expect(store.tabs()).toEqual([]);
      expect(store.activeTabId()).toBeNull();
    });
  });

  it("loadInActiveTab creates the first tab and activates it", () => {
    withStore((store) => {
      const id = store.loadInActiveTab(entry("a.md"), "root1");
      expect(store.tabs()).toHaveLength(1);
      expect(store.activeTabId()).toBe(id);
      expect(id).toBe("root1::a.md");
    });
  });

  it("loadInActiveTab replaces the active tab when switching files", () => {
    withStore((store) => {
      store.loadInActiveTab(entry("a.md"), "root1");
      store.loadInActiveTab(entry("b.md"), "root1");
      expect(store.tabs()).toHaveLength(1);
      expect(store.activeTabId()).toBe("root1::b.md");
    });
  });

  it("openTab opens a new tab next to the active one and activates it by default", () => {
    withStore((store) => {
      store.openTab(entry("a.md"), "root1");
      const id = store.openTab(entry("b.md"), "root1");
      expect(store.tabs().map((t) => t.id)).toEqual(["root1::a.md", id]);
      expect(store.activeTabId()).toBe(id);
    });
  });

  it("openTab in background mode keeps the previously active tab focused", () => {
    withStore((store) => {
      const a = store.openTab(entry("a.md"), "root1");
      store.openTab(entry("b.md"), "root1", { background: true });
      expect(store.activeTabId()).toBe(a);
    });
  });

  it("opening the same file twice generates a unique id for the duplicate", () => {
    withStore((store) => {
      const a = store.openTab(entry("a.md"), "root1");
      const dup = store.openTab(entry("a.md"), "root1");
      expect(dup).not.toBe(a);
      expect(store.tabs()).toHaveLength(2);
    });
  });

  it("closeTab removes the tab and activates an adjacent one", () => {
    withStore((store) => {
      store.openTab(entry("a.md"), "r");
      const b = store.openTab(entry("b.md"), "r");
      const c = store.openTab(entry("c.md"), "r");
      store.closeTab(b);
      const ids = store.tabs().map((t) => t.id);
      expect(ids).toEqual(["r::a.md", c]);
    });
  });

  it("closeTab on the active tab focuses the nearest remaining tab", () => {
    withStore((store) => {
      const a = store.openTab(entry("a.md"), "r");
      const b = store.openTab(entry("b.md"), "r");
      store.activateTab(b);
      store.closeTab(b);
      expect(store.activeTabId()).toBe(a);
    });
  });

  it("closeAllTabs clears the list and active id", () => {
    withStore((store) => {
      store.openTab(entry("a.md"), "r");
      store.openTab(entry("b.md"), "r");
      store.closeAllTabs();
      expect(store.tabs()).toEqual([]);
      expect(store.activeTabId()).toBeNull();
    });
  });

  it("closeOtherTabs keeps only the target tab", () => {
    withStore((store) => {
      const a = store.openTab(entry("a.md"), "r");
      store.openTab(entry("b.md"), "r");
      store.openTab(entry("c.md"), "r");
      store.closeOtherTabs(a);
      expect(store.tabs().map((t) => t.id)).toEqual([a]);
    });
  });

  it("closeTabsToRight removes tabs to the right of the target", () => {
    withStore((store) => {
      const a = store.openTab(entry("a.md"), "r");
      const b = store.openTab(entry("b.md"), "r");
      store.openTab(entry("c.md"), "r");
      store.openTab(entry("d.md"), "r");
      store.closeTabsToRight(b);
      expect(store.tabs().map((t) => t.id)).toEqual([a, b]);
    });
  });

  it("closeTabsByRoot removes only tabs from the matching root", () => {
    withStore((store) => {
      store.openTab(entry("a.md"), "r1");
      store.openTab(entry("b.md"), "r2");
      store.openTab(entry("c.md"), "r1");
      store.closeTabsByRoot("r1");
      expect(store.tabs().map((t) => t.rootId)).toEqual(["r2"]);
    });
  });

  it("activateTab is a no-op when the tab is already active", () => {
    withStore((store) => {
      const a = store.openTab(entry("a.md"), "r");
      store.activateTab(a);
      expect(store.activeTabId()).toBe(a);
    });
  });

  it("reorderTabs respects the new order and keeps tabs not in newOrder", () => {
    withStore((store) => {
      const a = store.openTab(entry("a.md"), "r");
      const b = store.openTab(entry("b.md"), "r");
      const c = store.openTab(entry("c.md"), "r");
      store.reorderTabs([c, a]); // omit b — should still be present
      const ids = store.tabs().map((t) => t.id);
      expect(ids[0]).toBe(c);
      expect(ids[1]).toBe(a);
      expect(ids).toContain(b);
    });
  });

  it("reopenClosedTab restores the most recently closed tab", () => {
    withStore((store) => {
      const a = store.openTab(entry("a.md"), "r");
      store.closeTab(a);
      const reopened = store.reopenClosedTab();
      expect(reopened?.id).toBe(a);
      expect(store.tabs().some((t) => t.id === a)).toBe(true);
      expect(store.activeTabId()).toBe(a);
    });
  });

  it("reopenClosedTab returns undefined when stack is empty", () => {
    withStore((store) => {
      expect(store.reopenClosedTab()).toBeUndefined();
    });
  });

  it("findTabByFile uses (rootId, filePath) as the lookup key", () => {
    withStore((store) => {
      const a = store.openTab(entry("a.md"), "r");
      expect(store.findTabByFile("a.md", "r")?.id).toBe(a);
      expect(store.findTabByFile("a.md", "other")).toBeUndefined();
    });
  });

  it("updateTabFile renames the tab id and re-points active id", () => {
    withStore((store) => {
      const a = store.openTab(entry("a.md"), "r");
      store.updateTabFile(a, "renamed.md", "renamed.md");
      const tab = store.tabs()[0]!;
      expect(tab.id).toBe("r::renamed.md");
      expect(tab.filePath).toBe("renamed.md");
      expect(store.activeTabId()).toBe("r::renamed.md");
    });
  });

  it("getDirtyTabs returns tabs where editorContent != savedContent", () => {
    withStore((store) => {
      store.openTab(entry("a.md"), "r");
      store.updateActiveTabContent({ editorContent: "edited", savedContent: "" });
      expect(store.getDirtyTabs()).toHaveLength(1);

      store.updateActiveTabContent({ editorContent: "saved", savedContent: "saved" });
      expect(store.getDirtyTabs()).toHaveLength(0);
    });
  });

  it("markTabNeedsLoad sets the needsLoad flag on the target tab", () => {
    withStore((store) => {
      const a = store.openTab(entry("a.md"), "r");
      store.markTabNeedsLoad(a);
      expect(store.getTab(a)?.needsLoad).toBe(true);
    });
  });

  // ── VSCode-style preview tabs ────────────────────────────────────
  // Newly opened tabs land in the "preview" slot (`isPinned = false`).
  // Single-click on another file replaces the preview slot; pinning
  // (double-click, drag, or the first edit) makes the tab permanent
  // so subsequent file-tree clicks open a new preview alongside it.

  it("loadInActiveTab creates a tab in the preview slot (not pinned by default)", () => {
    // Mutation captured: flipping `isPinned: false` back to `true`
    // in createTabState breaks the entire preview-slot flow — the
    // first click would already pin the tab and the next click
    // would never reuse it.
    withStore((store) => {
      store.loadInActiveTab(entry("a.md"), "r");
      const tab = store.getActiveTab();
      expect(tab?.isPinned).toBe(false);
    });
  });

  it("loadInActiveTab replaces the active tab only when it's still a preview", () => {
    // Mutation captured: dropping the `!currentActive.isPinned`
    // guard would clobber a pinned tab the user explicitly committed
    // to (the whole point of pinning).
    withStore((store) => {
      store.loadInActiveTab(entry("a.md"), "r");
      store.loadInActiveTab(entry("b.md"), "r");
      // Two clicks on preview tabs leave a single tab — the second
      // file replaced the first because it was still preview.
      expect(store.tabs()).toHaveLength(1);
      expect(store.activeTabId()).toBe("r::b.md");
    });
  });

  it("loadInActiveTab opens a new tab when the active tab is pinned", () => {
    // Mutation: removing the `openTab` fallback in the pinned branch
    // would leave the user unable to open a second file once their
    // first tab was pinned (regression caught in this exact shape).
    withStore((store) => {
      store.loadInActiveTab(entry("a.md"), "r");
      const aId = store.activeTabId()!;
      store.pinTab(aId);
      store.loadInActiveTab(entry("b.md"), "r");
      expect(store.tabs()).toHaveLength(2);
      const ids = store.tabs().map((t) => t.id);
      expect(ids).toContain(aId);
      expect(store.activeTabId()).toBe("r::b.md");
    });
  });

  it("pinTab flips isPinned from false to true and is idempotent thereafter", () => {
    // Mutation: flipping the early-return condition would corrupt
    // already-pinned tabs (e.g. resetting them to false), and the
    // double-click handler would silently undo prior pins.
    withStore((store) => {
      const id = store.loadInActiveTab(entry("a.md"), "r");
      expect(store.getTab(id)?.isPinned).toBe(false);
      store.pinTab(id);
      expect(store.getTab(id)?.isPinned).toBe(true);
      store.pinTab(id);
      expect(store.getTab(id)?.isPinned).toBe(true);
    });
  });

  it("pinTab on a non-existent id is a safe no-op", () => {
    withStore((store) => {
      store.pinTab("missing::file");
      expect(store.tabs()).toHaveLength(0);
    });
  });

  it("openTab creates a pinned tab by default — never a second preview slot", () => {
    // Regression: bug where middle-click / file-tree dblclick alongside
    // a single-click left two italic preview tabs in the bar at once.
    // The invariant we hold now: at most one preview tab per pane.
    // Mutation captured: setting `isPinned: !preview` back to
    // `false` (or removing the `preview` opt entirely) reintroduces
    // the duplicate-preview bug.
    withStore((store) => {
      store.loadInActiveTab(entry("a.md"), "r");        // preview
      const aId = store.activeTabId()!;
      store.openTab(entry("b.md"), "r");                // explicit open → pinned
      const previews = store.tabs().filter((t) => !t.isPinned);
      expect(previews).toHaveLength(1);
      expect(previews[0]!.id).toBe(aId);
    });
  });

  it("loadInActiveTab recycles a dormant preview slot even when a different tab is active", () => {
    // Reproduces the user-reported bug:
    //   1) single-click A  → preview A (active)
    //   2) middle-click B  → pinned B (active, A is dormant preview)
    //   3) single-click C  → preview C SHOULD replace A
    //                        (NOT stack alongside, leaving 2 previews).
    // Mutation captured: removing the `findIndex(!isPinned)` recycle
    // step and falling back to "active tab only" (the previous fix)
    // brings the two-preview bug back.
    withStore((store) => {
      store.loadInActiveTab(entry("a.md"), "r");          // preview A active
      const aId = store.activeTabId()!;
      store.openTab(entry("b.md"), "r");                  // pinned B active
      const bId = store.activeTabId()!;
      expect(store.getTab(aId)?.isPinned).toBe(false);
      expect(store.getTab(bId)?.isPinned).toBe(true);

      store.loadInActiveTab(entry("c.md"), "r");          // single-click C
      const previews = store.tabs().filter((t) => !t.isPinned);
      // Invariant: at most one preview tab in the bar.
      expect(previews).toHaveLength(1);
      // The recycled slot now hosts C, A is gone.
      expect(previews[0]!.filePath).toBe("c.md");
      expect(store.getTab(aId)).toBeUndefined();
      // B remains pinned and untouched.
      expect(store.getTab(bId)?.isPinned).toBe(true);
    });
  });

  it("openTab honours preview:true when a caller explicitly opts in (used by loadInActiveTab fallback)", () => {
    withStore((store) => {
      const id = store.openTab(entry("a.md"), "r", { preview: true });
      expect(store.getTab(id)?.isPinned).toBe(false);
    });
  });

  it("loadInActiveTab on a file that's already open just activates it (regardless of pin state)", () => {
    // Existing behaviour — pinning shouldn't alter the
    // already-open-just-activate fast path.
    withStore((store) => {
      store.loadInActiveTab(entry("a.md"), "r");
      const aId = store.activeTabId()!;
      store.pinTab(aId);
      const bId = store.openTab(entry("b.md"), "r");
      expect(store.activeTabId()).toBe(bId);
      // Click a.md again in the tree — should reactivate, not replace.
      store.loadInActiveTab(entry("a.md"), "r");
      expect(store.activeTabId()).toBe(aId);
      expect(store.tabs()).toHaveLength(2);
    });
  });

  it("loadInActiveTab replaces the active empty (\"+\") tab regardless of its pin state", () => {
    // Mutation captured: removing the empty-tab branch makes the file
    // land in a new preview alongside, orphaning the "+" tab.
    withStore((store) => {
      const emptyEntry: FSEntry = { name: "New Tab", path: "", kind: "file" };
      store.openTab(emptyEntry, "r"); // pinned by default, like handleNewTab
      const emptyId = store.activeTabId()!;
      expect(store.getTab(emptyId)?.isPinned).toBe(true);

      store.loadInActiveTab(entry("a.md"), "r");

      expect(store.tabs()).toHaveLength(1);
      expect(store.activeTabId()).not.toBe(emptyId);
      expect(store.getTab(store.activeTabId()!)?.filePath).toBe("a.md");
      expect(store.getTab(emptyId)).toBeUndefined();
    });
  });

  it("loadInActiveTab drops the active empty tab when the file is already open elsewhere", () => {
    // Reproduces the screenshot bug: guide.adoc was the preview, user
    // clicked "+", then single-clicked guide.adoc in the tree. The
    // existing tab was activated but the empty placeholder lingered.
    // Mutation captured: skipping the placeholder-drop here brings the
    // orphaned "New Tab" back next to the activated existing file.
    withStore((store) => {
      store.loadInActiveTab(entry("guide.adoc"), "r"); // preview guide.adoc
      const guideId = store.activeTabId()!;
      const emptyEntry: FSEntry = { name: "New Tab", path: "", kind: "file" };
      store.openTab(emptyEntry, "r"); // pinned empty tab, now active
      const emptyId = store.activeTabId()!;
      expect(store.tabs()).toHaveLength(2);

      // User single-clicks guide.adoc in the file tree.
      store.loadInActiveTab(entry("guide.adoc"), "r");

      // Existing guide.adoc tab is reactivated, empty placeholder is gone.
      expect(store.activeTabId()).toBe(guideId);
      expect(store.getTab(emptyId)).toBeUndefined();
      expect(store.tabs()).toHaveLength(1);
    });
  });

  it("loadInActiveTab prefers the active empty tab over a dormant preview slot", () => {
    // Mutation captured: putting the empty-tab branch *after* the
    // preview-recycle branch would route the file into the dormant
    // preview and leave the active "+" tab orphaned.
    withStore((store) => {
      store.loadInActiveTab(entry("a.md"), "r"); // preview A
      const aId = store.activeTabId()!;
      const emptyEntry: FSEntry = { name: "New Tab", path: "", kind: "file" };
      store.openTab(emptyEntry, "r"); // pinned empty tab, now active
      const emptyId = store.activeTabId()!;

      store.loadInActiveTab(entry("b.md"), "r");

      // The empty slot got recycled, not the dormant preview A.
      expect(store.getTab(emptyId)).toBeUndefined();
      expect(store.getTab(aId)?.filePath).toBe("a.md");
      expect(store.getTab(aId)?.isPinned).toBe(false);
      expect(store.getTab(store.activeTabId()!)?.filePath).toBe("b.md");
      expect(store.tabs()).toHaveLength(2);
    });
  });
});
