import { createEffect, untrack } from "solid-js";
import type { TabState } from "@markdraw/core/tabs.ts";
import type { FSEntry } from "@markdraw/core/types.ts";
import type { AppState } from "@markdraw/ui/composables/create-app-state.ts";
import type { PaneStore } from "@markdraw/ui/composables/create-pane-store.ts";
import type { createFileLoader } from "./file-loader.ts";
import { SCRATCH_ROOT_ID } from "./scratch.ts";

interface TabActionDeps {
  state: Pick<AppState, "paneManager" | "findEntryByPath">;
  rootPaths: () => ReadonlyMap<string, string>;
  syncWatcher: ReturnType<typeof createFileLoader>["syncWatcher"];
  loadTabContent: ReturnType<typeof createFileLoader>["loadTabContent"];
  loadFileContent: ReturnType<typeof createFileLoader>["loadFileContent"];
}

export function createTabActions({
  state, rootPaths, syncWatcher, loadTabContent, loadFileContent,
}: TabActionDeps) {
  const manager = state.paneManager;

  // Focus changes republish the target for the newly focused pane. Only the
  // focused pane is a dependency: loaders and selection handlers already call
  // syncWatcher when they open a valid file, so the values read here are
  // current snapshots, not causes for a second publication.
  createEffect(manager.activePane, (pane) => untrack(() => {
    const tab = pane.tabs.getActiveTab();
    if (pane.loading() || tab?.needsLoad) {
      syncWatcher(null);
      return;
    }
    const entry = pane.selectedFile();
    const rootId = pane.selectedRootId();
    const includes = tab && tab.filePath === entry?.path && tab.rootId === rootId
      ? tab.includePaths
      : [];
    syncWatcher(entry, rootId ? rootPaths().get(rootId) : undefined, includes);
  }));

  // A state change outside a loader/handler (a scratch tab, a removed root,
  // a loading or unloaded tab) must stop a watcher still aimed at the old
  // file. These reads belong in the compute so the effect reacts to them;
  // returning to a valid target is published by the focus effect or loader.
  createEffect(
    () => {
      const pane = manager.activePane();
      const tab = pane.tabs.getActiveTab();
      const entry = pane.selectedFile();
      const rootId = pane.selectedRootId();
      const rootPath = rootId ? rootPaths().get(rootId) : undefined;
      return pane.loading() || !!tab?.needsLoad || !entry || !rootPath;
    },
    (invalid) => {
      if (invalid) syncWatcher(null);
    },
  );

  function selectTab(pane: PaneStore, tab: TabState | null, focused = pane === manager.activePane(), pushHistory = false) {
    const entry = tab?.rootId === SCRATCH_ROOT_ID
      ? { path: tab.filePath, name: tab.fileName, kind: "file" as const }
      : tab?.filePath ? state.findEntryByPath(tab.filePath, tab.rootId) : null;
    pane.setSelectedFile(entry);
    pane.setSelectedRootId(entry && tab ? tab.rootId : null);

    const rootPath = entry && tab ? rootPaths().get(tab.rootId) : undefined;
    if (tab?.needsLoad && entry && rootPath) {
      if (focused) syncWatcher(null);
      return loadTabContent(pane, entry, tab, pushHistory);
    }
    if (tab?.needsLoad && (tab.rootId === SCRATCH_ROOT_ID || !tab.filePath)) {
      pane.tabs.updateTabContent(tab.id, { needsLoad: false });
    }
    pane.setLoading(false);
    if (focused) syncWatcher(entry, rootPath, tab?.includePaths);
  }

  function activateTab(pane: PaneStore, tabId: string, pushHistory = false) {
    const tab = pane.tabs.getTab(tabId);
    if (!tab) return;
    pane.tabs.activateTab(tabId);
    return selectTab(pane, tab, pane === manager.activePane(), pushHistory);
  }

  function updateLoadedTabCache(pane: PaneStore, id: string) {
    if (pane.tabs.activeTabId() !== id || pane.tabs.getTab(id)?.needsLoad) return;
    pane.tabs.updateTabContent(id, {
      editorContent: pane.editorContent(),
      savedContent: pane.savedContent(),
      html: pane.html(),
      frontmatter: pane.frontmatter(),
    });
  }

  async function openFile(entry: FSEntry, rootId: string, pinned = false, pushHistory = true) {
    const pane = manager.activePane();
    const store = pane.tabs;
    const existing = store.findTabByFile(entry.path, rootId);
    if (pinned && existing) {
      store.pinTab(existing.id);
      if (existing.needsLoad) {
        await activateTab(pane, existing.id, pushHistory);
      } else {
        store.activateTab(existing.id);
        await loadFileContent(entry, pushHistory, false, rootId);
      }
      return;
    }
    const id = pinned ? store.openTab(entry, rootId) : store.loadInActiveTab(entry, rootId);
    if (!existing) {
      store.markTabNeedsLoad(id);
      await loadTabContent(pane, entry, { id, rootId }, pushHistory);
      return;
    }
    if (existing.needsLoad) {
      await selectTab(pane, existing, true, pushHistory);
      return;
    }
    await loadFileContent(entry, pushHistory, false, rootId);
    updateLoadedTabCache(pane, id);
  }

  function closeTabs(pane: PaneStore, tabIds: readonly string[]) {
    pane.tabs.closeTabs(tabIds);
  }

  function closeRootTabs(rootId: string) {
    manager.activePane().tabs.closeTabsByRoot(rootId);
  }

  function renameOpenTab(pane: PaneStore, rootId: string, oldPath: string, entry: FSEntry) {
    const activeTab = pane.tabs.getActiveTab();
    const active = activeTab?.rootId === rootId && activeTab.filePath === oldPath;
    const tab = active ? activeTab : pane.tabs.findTabByFile(oldPath, rootId);
    if (!tab) return;
    const renamedTab = pane.tabs.updateTabFile(tab.id, entry.path, entry.name);
    if (active && renamedTab?.needsLoad) {
      void loadTabContent(pane, entry, renamedTab);
    }
  }

  function moveTab(tabId: string, fromPaneIndex: number) {
    const panes = manager.panes();
    const source = panes[fromPaneIndex];
    const tab = source?.tabs.getTab(tabId);
    if (!source || !tab) return;
    const entry = state.findEntryByPath(tab.filePath, tab.rootId);
    if (!entry || entry.kind !== "file") return;
    const targetIndex = fromPaneIndex === 0 ? 1 : 0;
    const existingTarget = panes[targetIndex];
    const target = existingTarget ?? manager.splitFromActive();
    if (!target) return;

    // Only the active source tab owns the pane's live working buffer.
    const content = source.tabs.activeTabId() === tabId && !tab.needsLoad
      ? {
          editorContent: source.editorContent(),
          savedContent: source.savedContent(),
          html: source.html(),
          frontmatter: source.frontmatter(),
          editorMode: source.editorMode(),
        }
      : tab;
    const moved = {
      editorContent: content.editorContent,
      savedContent: content.savedContent,
      html: content.html,
      frontmatter: content.frontmatter,
      editorMode: content.editorMode,
      includePaths: tab.includePaths,
      needsLoad: tab.needsLoad,
    };

    if (existingTarget) manager.setActivePane(targetIndex);
    const targetId = target.tabs.openTab(entry, tab.rootId);
    target.tabs.updateTabContent(targetId, moved);
    target.setEditorContent(moved.editorContent);
    target.setSavedContent(moved.savedContent);
    target.setHtml(moved.html);
    target.setFrontmatter(moved.frontmatter);
    target.setEditorMode(moved.editorMode);
    source.tabs.closeTab(tabId);
    void selectTab(target, { ...tab, id: targetId }, true);
  }

  return {
    selectTab, activateTab, openFile, updateLoadedTabCache,
    closeTabs, closeRootTabs, renameOpenTab, moveTab,
  };
}
