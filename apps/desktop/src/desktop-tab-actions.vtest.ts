import { afterEach, describe, expect, it, mock } from "bun:test";
import { createRoot, flush } from "solid-js";
import type { FSEntry } from "@markdraw/core/types.ts";
import type { AppState } from "@markdraw/ui/composables/create-app-state.ts";
import { createPaneManager } from "@markdraw/ui/composables/create-pane-manager.ts";
import { createTabActions } from "./lib/tab-actions.ts";

// navigation.ts reaches Tauri through ./fs.ts and the toast store through the
// UI package; neither is needed to prove the tab transition.
mock.module("@markdraw/ui/components/ui/toast.tsx", () => ({ showToast: () => {} }));
mock.module("./lib/fs.ts", () => ({
  readTree: async () => { throw new Error("not a directory"); },
  readFileContent: async () => "",
}));
const { createNavigation } = await import("./lib/navigation.ts");

// Bun's test runtime has no DOM storage; the pane/tab store needs a small
// in-memory localStorage to persist its session and layout.
const storage = new Map<string, string>();
if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, String(value)); },
      removeItem: (key: string) => { storage.delete(key); },
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() { return storage.size; },
    },
  });
}

const rootId = "/workspace";
const alpha: FSEntry = { kind: "file", name: "alpha.md", path: "alpha.md" };
const beta: FSEntry = { kind: "file", name: "beta.md", path: "beta.md" };
const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  storage.clear();
});

function fixture() {
  const loaded: Array<{ path: string; rootId?: string; pushHistory: boolean }> = [];
  const tabContentLoads: string[] = [];
  const rawLoads: string[] = [];
  return createRoot((dispose) => {
    disposers.push(dispose);
    const paneManager = createPaneManager();
    const findEntryByPath = (path: string, root?: string): FSEntry | null =>
      root === rootId && (path === alpha.path || path === beta.path)
        ? { kind: "file", name: path, path }
        : null;
    const state = {
      paneManager,
      findEntryByPath,
      setPendingFragment: () => {},
      setPendingHtmlNavigation: () => {},
      selectedRootId: () => rootId,
      rootsList: () => [{ id: rootId, name: "workspace" }],
      showHiddenEntries: () => false,
    } as unknown as AppState;
    const rootPaths = () => new Map([[rootId, rootId]]);
    const actions = createTabActions({
      state,
      rootPaths,
      syncWatcher: () => {},
      loadTabContent: async (pane, entry, tab) => {
        tabContentLoads.push(entry.path);
        pane.tabs.updateTabContent(tab.id, { needsLoad: false });
        pane.setSelectedFile(entry);
        pane.setSelectedRootId(rootId);
      },
      loadFileContent: async (entry, pushHistory, _force, forRoot) => {
        loaded.push({ path: entry.path, rootId: forRoot, pushHistory: pushHistory ?? true });
      },
    });
    const navigation = createNavigation({
      loadFileContent: async (entry) => { rawLoads.push(entry.path); },
      rootPaths,
      state,
      onOpenFile: (entry, forRoot, pinned, pushHistory) =>
        actions.openFile(entry, forRoot, pinned, pushHistory),
    });
    return { paneManager, navigation, loaded, tabContentLoads, rawLoads };
  });
}

async function openAlpha(fixtureResult: ReturnType<typeof fixture>) {
  // The fixture wires the link callback to the real tab actions; opening the
  // first document through the same path keeps the test on the public entry.
  await fixtureResult.navigation.handleNavigate("alpha.md");
  flush();
  expect(fixtureResult.paneManager.activePane().tabs.activeTabId()).not.toBeNull();
}

describe("link interno no preview → aba de destino", () => {
  it("troca activeTabId pelo destino e não chama o loader cru", async () => {
    const f = fixture();
    await openAlpha(f);
    const before = f.paneManager.activePane().tabs.activeTabId();

    await f.navigation.handleNavigate("beta.md", "secao");

    const pane = f.paneManager.activePane();
    expect(pane.tabs.activeTabId()).not.toBe(before);
    expect(pane.tabs.getActiveTab()?.filePath).toBe("beta.md");
    expect(f.tabContentLoads).toEqual(["alpha.md", "beta.md"]);
    expect(f.loaded).toEqual([]);
    expect(f.rawLoads).toEqual([]);
  });

  it("reativa uma aba já aberta em vez de duplicá-la", async () => {
    const f = fixture();
    await openAlpha(f);
    // A preview slot is replaced by the next single click; pin Alpha so it
    // survives Beta and can be reactivated by the following link.
    f.paneManager.activePane().tabs.pinTab(f.paneManager.activePane().tabs.activeTabId()!);
    await f.navigation.handleNavigate("beta.md");
    const betaId = f.paneManager.activePane().tabs.activeTabId();

    await f.navigation.handleNavigate("alpha.md");

    const pane = f.paneManager.activePane();
    expect(pane.tabs.activeTabId()).not.toBe(betaId);
    expect(pane.tabs.getActiveTab()?.filePath).toBe("alpha.md");
    expect(pane.tabs.tabs().filter((tab) => tab.filePath === "alpha.md")).toHaveLength(1);
    expect(f.tabContentLoads).toEqual(["alpha.md", "beta.md"]);
    // Reopening a loaded tab goes through the tab-aware file loader with
    // pushHistory=true — the same call the tree's single click makes.
    expect(f.loaded).toEqual([{ path: "alpha.md", rootId, pushHistory: true }]);
  });
});
