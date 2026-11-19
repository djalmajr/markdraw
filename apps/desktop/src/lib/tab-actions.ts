import type { TabState } from "@markdraw/core/tabs.ts";
import type { FSEntry } from "@markdraw/core/types.ts";
import type { AppState } from "@markdraw/ui/composables/create-app-state.ts";
import type { PaneStore } from "@markdraw/ui/composables/create-pane-store.ts";
import { writeFile } from "./fs.ts";
import type { createFileLoader } from "./file-loader.ts";
import type { FinishRootClose } from "./folder.ts";
import { SCRATCH_ROOT_ID } from "./scratch.ts";
import type { FileWatcher } from "./watcher.ts";

interface TabActionDeps {
  state: Pick<AppState, "paneManager" | "findEntryByPath" | "autoRefresh">;
  rootPaths: () => ReadonlyMap<string, string>;
  watcher: Pick<FileWatcher, "setTarget" | "start" | "stop">;
  loadTabContent: ReturnType<typeof createFileLoader>["loadTabContent"];
  loadFileContent: ReturnType<typeof createFileLoader>["loadFileContent"];
  confirmDirtyTab: (tab: TabState) => Promise<"confirm" | "deny" | "cancel">;
  notifyCloseConflict: (name: string) => void;
}

export function createTabActions({
  state, rootPaths, watcher, loadTabContent, loadFileContent, confirmDirtyTab, notifyCloseConflict,
}: TabActionDeps) {
  const manager = state.paneManager;

  function selectTab(pane: PaneStore, tab: TabState | null, focused = pane === manager.activePane(), pushHistory = false) {
    const entry = tab?.rootId === SCRATCH_ROOT_ID
      ? { path: tab.filePath, name: tab.fileName, kind: "file" as const }
      : tab?.filePath ? state.findEntryByPath(tab.filePath, tab.rootId) : null;
    pane.setSelectedFile(entry);
    pane.setSelectedRootId(entry && tab ? tab.rootId : null);

    const rootPath = entry && tab ? rootPaths().get(tab.rootId) : undefined;
    if (tab?.needsLoad && entry && rootPath) {
      if (focused) void watcher.stop();
      return loadTabContent(pane, entry, tab, pushHistory);
    }
    if (tab?.needsLoad && (tab.rootId === SCRATCH_ROOT_ID || !tab.filePath)) {
      pane.tabs.updateTabContent(tab.id, { needsLoad: false });
    }
    pane.setLoading(false);
    if (!focused) return;
    if (tab && rootPath) {
      watcher.setTarget({
        filePath: `${rootPath}/${tab.filePath}`,
        includePaths: tab.includePaths,
        rootPath,
      });
      if (state.autoRefresh()) void watcher.start();
    } else {
      void watcher.stop();
    }
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
    for (const pane of manager.panes()) {
      pane.tabs.closeTabsByRoot(rootId);
    }
  }

  type TabTarget = { pane: PaneStore; id: string };
  type DirtyTab = { pane: PaneStore; tab: TabState; content: string };

  function dirtyTabs(targets: readonly TabTarget[]): DirtyTab[] {
    return targets.flatMap(({ pane, id }) => {
      const tab = pane.tabs.getTab(id);
      if (!tab || tab.needsLoad) return [];
      const active = pane.tabs.activeTabId() === id;
      const content = active ? pane.editorContent() : tab.editorContent;
      const saved = active ? pane.savedContent() : tab.savedContent;
      return content === saved ? [] : [{ pane, tab, content }];
    });
  }

  function groupByDestination(items: DirtyTab[]) {
    const groups = new Map<string, DirtyTab[]>();
    for (const item of items) {
      const root = rootPaths().get(item.tab.rootId);
      const path = `${(root ?? item.tab.rootId).replace(/\/+$/, "")}/${item.tab.filePath}`;
      const group = groups.get(path);
      if (group && group[0]!.content !== item.content) {
        notifyCloseConflict(item.tab.fileName);
        return null;
      }
      if (group) group.push(item);
      else groups.set(path, [item]);
    }
    return groups;
  }

  async function saveBuffer(path: string, item: DirtyTab): Promise<boolean> {
    if (!rootPaths().has(item.tab.rootId) || !item.tab.filePath) return false;
    try {
      await writeFile(path, item.content);
      return true;
    } catch (error) {
      console.error("Failed to save file:", error);
      return false;
    }
  }

  async function prepareClose(targets: () => TabTarget[], allowChanges: boolean) {
    const initial = dirtyTabs(targets());
    if (!groupByDestination(initial)) return null;
    const approved: Array<DirtyTab & { save: boolean }> = [];
    for (const pending of initial) {
      const decision = await confirmDirtyTab(pending.tab);
      if (decision === "cancel") return null;
      approved.push({ ...pending, save: decision === "confirm" });
    }

    // A modal decision applies only to the version the user was asked about.
    const isApproved = (pending: DirtyTab) =>
      approved.find(({ pane, tab, content }) =>
        pane === pending.pane && tab.id === pending.tab.id && content === pending.content,
      );
    const pending = dirtyTabs(targets());
    const groups = groupByDestination(pending);
    if (!groups || (!allowChanges && !pending.every(isApproved))) return null;
    const saved = new Map<string, string>();
    for (const [path, group] of groups) {
      const item = group.find((candidate) => isApproved(candidate)?.save);
      if (!item) continue;
      if (!await saveBuffer(path, item)) return null;
      saved.set(path, item.content);
    }
    return { isApproved, saved };
  }

  async function approveTabClose(pane: PaneStore, id: string) {
    const targets = () => [{ pane, id }];
    const decision = await prepareClose(targets, false);
    return decision !== null && dirtyTabs(targets()).every(decision.isApproved);
  }

  async function prepareRootClose(rootId: string): Promise<FinishRootClose | null> {
    const targets = () => manager.panes().flatMap((pane) =>
      pane.tabs.tabs().filter((tab) => tab.rootId === rootId).map((tab) => ({ pane, id: tab.id })),
    );
    const decision = await prepareClose(targets, true);
    if (!decision) return null;

    return async (commit) => {
      while (true) {
        const groups = groupByDestination(dirtyTabs(targets()));
        if (!groups) return;
        const next = [...groups].find(([path, group]) =>
          decision.saved.get(path) !== group[0]!.content
          && group.some((item) => decision.isApproved(item)?.save !== false),
        );
        if (!next) {
          // No await between the last scan and removing the tabs.
          commit();
          return;
        }
        const [path, group] = next;
        const item = group[0]!;
        if (!await saveBuffer(path, item)) return;
        decision.saved.set(path, item.content);
      }
    };
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
    closeTabs, closeRootTabs, approveTabClose, prepareRootClose, moveTab,
  };
}
