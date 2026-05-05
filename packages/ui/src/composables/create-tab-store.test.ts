import { beforeEach, describe, expect, it } from "bun:test";
import { createRoot } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import { installLocalStorageMock } from "@asciimark/core/test-utils.ts";
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
});
