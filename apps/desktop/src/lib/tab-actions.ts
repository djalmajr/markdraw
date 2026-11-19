import type { TabState } from "@markdraw/core/tabs.ts";
import type { AppState } from "@markdraw/ui/composables/create-app-state.ts";
import type { PaneStore } from "@markdraw/ui/composables/create-pane-store.ts";
import { SCRATCH_ROOT_ID } from "./scratch.ts";
import type { FileWatcher } from "./watcher.ts";

interface TabActionDeps {
  state: Pick<AppState, "paneManager" | "findEntryByPath" | "autoRefresh">;
  rootPaths: () => ReadonlyMap<string, string>;
  watcher: Pick<FileWatcher, "setTarget" | "start" | "stop">;
}

export function createTabActions({ state, rootPaths, watcher }: TabActionDeps) {
  const manager = state.paneManager;

  function selectTab(pane: PaneStore, tab: TabState | null, paths = rootPaths()) {
    const entry = tab?.rootId === SCRATCH_ROOT_ID
      ? { path: tab.filePath, name: tab.fileName, kind: "file" as const }
      : tab?.filePath ? state.findEntryByPath(tab.filePath, tab.rootId) : null;
    pane.setSelectedFile(entry);
    pane.setSelectedRootId(entry && tab ? tab.rootId : null);

    const rootPath = entry && tab ? paths.get(tab.rootId) : undefined;
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

  function closeTabs(pane: PaneStore, tabIds: readonly string[]) {
    const next = pane.tabs.closeTabs(tabIds);
    if (next !== undefined && pane === manager.activePane()) selectTab(pane, next);
  }

  function closeRootTabs(rootId: string, paths: ReadonlyMap<string, string>) {
    const activePane = manager.activePane();
    for (const pane of manager.panes()) {
      const next = pane.tabs.closeTabsByRoot(rootId);
      if (pane === activePane && next !== undefined && paths.size > 0) {
        selectTab(pane, next, paths);
      }
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
    const content = source.tabs.activeTabId() === tabId
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
    selectTab(target, tab);
    source.tabs.closeTab(tabId);
  }

  return { closeTabs, closeRootTabs, moveTab };
}
