import { createEffect, untrack } from "solid-js";
import { makeTabId, type TabState } from "@markdraw/core/tabs.ts";
import { getIncludePaths } from "@markdraw/core/asciidoc.ts";
import { getMarkdownIncludePaths } from "@markdraw/core/markdown.ts";
import { isMdFile } from "@markdraw/core/utils.ts";
import type { FSEntry } from "@markdraw/core/types.ts";
import type { AppState } from "@markdraw/ui/composables/create-app-state.ts";
import type { PaneStore } from "@markdraw/ui/composables/create-pane-store.ts";
import { tabDisplayName } from "@markdraw/ui/composables/create-tab-store.ts";
import type { createFileLoader } from "./file-loader.ts";
import { SCRATCH_ROOT_ID, scratchPath } from "./scratch.ts";

interface TabActionDeps {
  state: Pick<AppState, "paneManager" | "findEntryByPath" | "roots" | "transferReader" | "rekeyReader" | "carryEdit">;
  rootPaths: () => ReadonlyMap<string, string>;
  syncWatcher: ReturnType<typeof createFileLoader>["syncWatcher"];
  loadTabContent: ReturnType<typeof createFileLoader>["loadTabContent"];
  loadFileContent: ReturnType<typeof createFileLoader>["loadFileContent"];
}

export function createTabActions({
  state, rootPaths, syncWatcher, loadTabContent, loadFileContent,
}: TabActionDeps) {
  const manager = state.paneManager;
  // Identity a renamed tab keeps (root -> path -> entry) while the tree still
  // shows the layout from before the rename. Each entry remembers the tree
  // object that was current when it was recorded. Tree reads that began before
  // the operation are rejected by the folder, so the first tree published for
  // the root afterwards is the one that confirms the operation: from then on
  // the tree alone decides what exists, and a file removed later is not
  // revived by this fallback. A closed or reopened root has no such tree.
  interface PendingEntry { entry: FSEntry; tree: FSEntry[] | undefined }
  const pendingEntries = new Map<string, Map<string, PendingEntry>>();
  let draftCounter = 0;

  function currentTree(rootId: string) {
    return state.roots().get(rootId)?.entries;
  }

  function pendingEntry(rootId: string, path: string) {
    const pending = pendingEntries.get(rootId)?.get(path);
    if (!pending) return null;
    const tree = currentTree(rootId);
    if (tree && tree === pending.tree) return pending.entry;
    releasePending(rootId, path);
    return null;
  }

  function releasePending(rootId: string, path: string) {
    const roots = pendingEntries.get(rootId);
    if (!roots?.delete(path)) return;
    if (roots.size === 0) pendingEntries.delete(rootId);
  }

  // Drop every record the tree has already confirmed or lost with its root.
  function pruneConfirmed() {
    for (const [rootId, paths] of Array.from(pendingEntries)) {
      for (const path of Array.from(paths.keys())) pendingEntry(rootId, path);
    }
  }

  // The edits of a destination tab displaced by a move keep no link to the
  // file that now holds the moved content: a draft in memory, saved only by
  // an explicit save-as. A tab with no edits has nothing to keep.
  function displacedAsDraft(stale: TabState): TabState | null {
    if (stale.needsLoad || stale.editorContent === stale.savedContent) return null;
    const dot = stale.fileName.lastIndexOf(".");
    const stem = dot > 0 ? stale.fileName.slice(0, dot) : stale.fileName;
    const ext = dot > 0 ? stale.fileName.slice(dot) : "";
    const n = ++draftCounter;
    // The path (and so the id) stays language-independent and carries the
    // recovery number; `fileName` keeps the base name. The visible suffix is
    // derived from both, in the language in use, by `tabDisplayName`.
    const path = scratchPath(`${stem} (recovered ${n})${ext}`);
    return {
      ...stale,
      id: makeTabId(SCRATCH_ROOT_ID, path),
      rootId: SCRATCH_ROOT_ID,
      filePath: path,
      savedContent: "",
      needsLoad: false,
      includePaths: [],
    };
  }

  // A tab reopened from the history onto an id a live tab now holds keeps its
  // edits as such a draft, in every pane.
  createEffect(manager.panes, (panes) => {
    for (const pane of panes) pane.tabs.setReopenResolver(displacedAsDraft);
  });

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
    let entry = tab?.rootId === SCRATCH_ROOT_ID
      ? { path: tab.filePath, name: tabDisplayName(tab), kind: "file" as const }
      : tab?.filePath ? state.findEntryByPath(tab.filePath, tab.rootId) : null;
    if (tab?.filePath && tab.rootId !== SCRATCH_ROOT_ID) {
      // The tree recognises the destination: the fallback has done its job.
      if (entry) releasePending(tab.rootId, tab.filePath);
      else entry = pendingEntry(tab.rootId, tab.filePath);
    }
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

  /**
   * Point a tab at the file's new path after a rename or move. The active tab
   * of the focused pane also re-aims the shared OS watcher (same file, new
   * absolute path) and restarts its first read when one is still pending; a
   * move across workspaces reopens the tab under the target root, since a tab
   * id embeds its root.
   */
  function renameOpenTab(pane: PaneStore, rootId: string, oldPath: string, entry: FSEntry, newRootId: string = rootId, tabId?: string) {
    const activeTab = pane.tabs.getActiveTab();
    const tab = tabId ? pane.tabs.getTab(tabId) : activeTab?.rootId === rootId && activeTab.filePath === oldPath
      ? activeTab : pane.tabs.findTabByFile(oldPath, rootId);
    const active = tab?.id === activeTab?.id;
    if (!tab) return;
    const watch = (includePaths: string[]) => {
      if (pane === manager.activePane()) syncWatcher(entry, rootPaths().get(newRootId), includePaths);
    };
    pruneConfirmed();
    releasePending(rootId, oldPath);
    let pending = pendingEntries.get(newRootId);
    if (!pending) pendingEntries.set(newRootId, pending = new Map());
    pending.set(entry.path, { entry, tree: currentTree(newRootId) });
    const content = active && !tab.needsLoad ? pane.editorContent() : tab.editorContent;
    const base = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
    const includePaths = isMdFile(entry.path)
      ? getMarkdownIncludePaths(content, base)
      : getIncludePaths(content, base);
    if (newRootId === rootId) {
      const renamedTab = pane.tabs.updateTabFile(tab.id, entry.path, entry.name, rootId, { includePaths }, displacedAsDraft);
      if (!renamedTab) return;
      // The loaded document keeps its include reader under the new path.
      if (!tab.needsLoad) state.rekeyReader(pane, rootId, oldPath, entry.path);
      if (active) {
        pane.setSelectedFile(entry);
        pane.setSelectedRootId(rootId);
      }
      // An edit still waiting for its preview follows the new identity.
      state.carryEdit(
        { pane, tabId: tab.id, rootId, filePath: oldPath },
        { pane, tabId: renamedTab.id, rootId, filePath: entry.path },
      );
      if (active && renamedTab.needsLoad) {
        void loadTabContent(pane, entry, renamedTab);
        return;
      }
      if (active) watch(renamedTab.includePaths);
      return;
    }
    // Replace the root-bearing identity in place; closing it would select a
    // neighbour and could start that tab's pending load during this move.
    const carried = active && !tab.needsLoad
      ? {
          editorContent: pane.editorContent(),
          savedContent: pane.savedContent(),
          html: pane.html(),
          frontmatter: pane.frontmatter(),
          editorMode: pane.editorMode(),
        }
      : {
          editorContent: tab.editorContent,
          savedContent: tab.savedContent,
          html: tab.html,
          frontmatter: tab.frontmatter,
          editorMode: tab.editorMode,
        };
    const renamedTab = pane.tabs.updateTabFile(tab.id, entry.path, entry.name, newRootId, { ...carried, includePaths }, displacedAsDraft);
    if (!renamedTab) return;
    state.carryEdit(
      { pane, tabId: tab.id, rootId, filePath: oldPath },
      { pane, tabId: renamedTab.id, rootId: newRootId, filePath: entry.path },
    );
    if (!active) return;
    const id = renamedTab.id;
    pane.setSelectedFile(entry);
    pane.setSelectedRootId(newRootId);
    if (tab.needsLoad) {
      void loadTabContent(pane, entry, { id, rootId: newRootId });
      return;
    }
    // The pane keeps the working buffer across the identity replacement.
    pane.setEditorContent(carried.editorContent);
    pane.setSavedContent(carried.savedContent);
    pane.setHtml(carried.html);
    pane.setFrontmatter(carried.frontmatter);
    pane.setEditorMode(carried.editorMode);
    watch(includePaths);
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
    // The include reader (root and cache) goes with a loaded tab; an unloaded
    // one builds its own when it loads.
    if (!tab.needsLoad) state.transferReader(source, target, tab.rootId, tab.filePath);
    state.carryEdit(
      { pane: source, tabId, rootId: tab.rootId, filePath: tab.filePath },
      { pane: target, tabId: targetId, rootId: tab.rootId, filePath: tab.filePath },
    );
    source.tabs.closeTab(tabId);
    void selectTab(target, { ...tab, id: targetId }, true);
  }

  return {
    selectTab, activateTab, openFile, updateLoadedTabCache,
    closeTabs, closeRootTabs, renameOpenTab, moveTab,
  };
}
