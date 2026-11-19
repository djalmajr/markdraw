import type { TabState } from "@markdraw/core/tabs.ts";
import type { AppState } from "@markdraw/ui/composables/create-app-state.ts";
import type { PaneStore } from "@markdraw/ui/composables/create-pane-store.ts";
import { writeFile } from "./fs.ts";
import type { createFileLoader } from "./file-loader.ts";
import { SCRATCH_ROOT_ID } from "./scratch.ts";
import type { FileWatcher } from "./watcher.ts";

interface TabActionDeps {
  state: Pick<AppState, "paneManager" | "findEntryByPath" | "autoRefresh">;
  rootPaths: () => ReadonlyMap<string, string>;
  watcher: Pick<FileWatcher, "setTarget" | "start" | "stop">;
  loadTabContent: ReturnType<typeof createFileLoader>["loadTabContent"];
  confirmDirtyTab: (tab: TabState) => Promise<"confirm" | "deny" | "cancel">;
}

export function createTabActions({ state, rootPaths, watcher, loadTabContent, confirmDirtyTab }: TabActionDeps) {
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

  function closeTabs(pane: PaneStore, tabIds: readonly string[]) {
    pane.tabs.closeTabs(tabIds);
  }

  function closeRootTabs(rootId: string) {
    for (const pane of manager.panes()) {
      pane.tabs.closeTabsByRoot(rootId);
    }
  }

  type TabTarget = { pane: PaneStore; id: string };

  function dirtyTabs(targets: readonly TabTarget[]) {
    return targets.flatMap(({ pane, id }) => {
      const tab = pane.tabs.getTab(id);
      if (!tab || tab.needsLoad) return [];
      const active = pane.tabs.activeTabId() === id;
      const content = active ? pane.editorContent() : tab.editorContent;
      const saved = active ? pane.savedContent() : tab.savedContent;
      return content === saved ? [] : [{ pane, tab, content }];
    });
  }

  async function approveClose(targets: () => TabTarget[]) {
    const approved: Array<ReturnType<typeof dirtyTabs>[number] & { save: boolean }> = [];
    for (const pending of dirtyTabs(targets())) {
      const decision = await confirmDirtyTab(pending.tab);
      if (decision === "cancel") return false;
      approved.push({ ...pending, save: decision === "confirm" });
    }

    // A modal decision applies only to the version the user was asked about.
    const isApproved = (pending: ReturnType<typeof dirtyTabs>[number]) =>
      approved.find(({ pane, tab, content }) =>
        pane === pending.pane && tab.id === pending.tab.id && content === pending.content,
      );
    const pending = dirtyTabs(targets());
    if (!pending.every(isApproved)) return false;
    for (const item of pending) {
      if (!isApproved(item)?.save) continue;
      const root = rootPaths().get(item.tab.rootId);
      if (!root || !item.tab.filePath) return false;
      try {
        await writeFile(`${root}/${item.tab.filePath}`, item.content);
      } catch (error) {
        console.error("Failed to save file:", error);
        return false;
      }
    }
    return dirtyTabs(targets()).every(isApproved);
  }

  function approveTabClose(pane: PaneStore, id: string) {
    return approveClose(() => [{ pane, id }]);
  }

  function approveRootClose(rootId: string) {
    return approveClose(() => manager.panes().flatMap((pane) =>
      pane.tabs.tabs().filter((tab) => tab.rootId === rootId).map((tab) => ({ pane, id: tab.id })),
    ));
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

  return { selectTab, activateTab, closeTabs, closeRootTabs, approveTabClose, approveRootClose, moveTab };
}
