import { createSignal } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import {
  type TabId,
  type TabState,
  type PersistedTabSession,
  makeTabId,
  getTabSession,
  setTabSession,
} from "@asciimark/core/tabs.ts";
import type { PaneViewSlice } from "./create-pane-store.ts";

export interface TabStore {
  tabs: () => TabState[];
  activeTabId: () => TabId | null;

  /** Create a new tab (used by "Open in New Tab", middle-click, etc.) */
  openTab(entry: FSEntry, rootId: string, opts?: { background?: boolean; append?: boolean }): TabId;
  /** Replace the active tab's file (used by single-click in file tree). Creates a tab if none exist. */
  loadInActiveTab(entry: FSEntry, rootId: string): TabId;
  closeTab(tabId: TabId): boolean;
  closeOtherTabs(tabId: TabId): void;
  closeAllTabs(): void;
  closeTabsToRight(tabId: TabId): void;
  closeTabsByRoot(rootId: string): void;
  activateTab(tabId: TabId): void;
  reorderTabs(newOrder: TabId[]): void;
  /** Reopen the most recently closed tab. Returns the tab or undefined if stack is empty. */
  reopenClosedTab(): TabState | undefined;

  snapshotActiveTab(scrollPositions?: { editorScrollTop: number; previewScrollTop: number }): void;
  restoreActiveTab(): void;
  updateActiveTabContent(content: Partial<Pick<TabState, "editorContent" | "savedContent" | "html" | "frontmatter" | "includePaths">>): void;
  updateTabFile(tabId: TabId, newFilePath: string, newFileName: string): void;
  markTabNeedsLoad(tabId: TabId): void;

  getTab(tabId: TabId): TabState | undefined;
  findTabByFile(filePath: string, rootId: string): TabState | undefined;
  getActiveTab(): TabState | undefined;
  getDirtyTabs(): TabState[];

  persistSession(): void;
  getPersistedSession(): PersistedTabSession | null;
}

interface TabStoreConfig {
  /** The per-pane signal slice the tab store snapshots into and
   *  restores from. Tab content lives on the tabs themselves; the
   *  pane signals are the working copy that the editor + preview
   *  components actually read. */
  pane: PaneViewSlice;
}

export function createTabStore(config: TabStoreConfig): TabStore {
  const { pane } = config;

  const [tabList, setTabList] = createSignal<TabState[]>([]);
  const [activeId, setActiveId] = createSignal<TabId | null>(null);
  let tabCounter = 0;
  const closedTabsStack: TabState[] = [];
  const MAX_CLOSED_TABS = 20;

  function getTab(tabId: TabId): TabState | undefined {
    return tabList().find((t) => t.id === tabId);
  }

  function findTabByFile(filePath: string, rootId: string): TabState | undefined {
    const id = makeTabId(rootId, filePath);
    return getTab(id);
  }

  function getActiveTab(): TabState | undefined {
    const id = activeId();
    return id ? getTab(id) : undefined;
  }

  function getDirtyTabs(): TabState[] {
    return tabList().filter((t) => t.editorContent !== t.savedContent);
  }

  function snapshotActiveTab(scrollPositions?: { editorScrollTop: number; previewScrollTop: number }): void {
    const id = activeId();
    if (!id) return;

    const currentContent = pane.editorContent();
    const currentSaved = pane.savedContent();
    const currentHtml = pane.html();
    const currentFrontmatter = pane.frontmatter();
    const currentMode = pane.editorMode();

    setTabList((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        return {
          ...t,
          editorContent: currentContent,
          savedContent: currentSaved,
          html: currentHtml,
          frontmatter: currentFrontmatter,
          editorMode: currentMode,
          editorScrollTop: scrollPositions?.editorScrollTop ?? t.editorScrollTop,
          previewScrollTop: scrollPositions?.previewScrollTop ?? t.previewScrollTop,
        };
      }),
    );
  }

  function restoreActiveTab(): void {
    const tab = getActiveTab();
    if (!tab) return;

    pane.setEditorContent(tab.editorContent);
    pane.setSavedContent(tab.savedContent);
    pane.setHtml(tab.html);
    pane.setFrontmatter(tab.frontmatter);
    pane.setEditorMode(tab.editorMode);
  }

  function createTabState(entry: FSEntry, rootId: string, needsLoad = false): TabState {
    return {
      id: makeTabId(rootId, entry.path),
      filePath: entry.path,
      rootId,
      fileName: entry.name,
      editorContent: "",
      savedContent: "",
      html: "",
      frontmatter: null,
      editorMode: "preview",
      editorScrollTop: 0,
      previewScrollTop: 0,
      isPinned: true,
      includePaths: [],
      needsLoad,
    };
  }

  function loadInActiveTab(entry: FSEntry, rootId: string): TabId {
    const tabId = makeTabId(rootId, entry.path);

    // If this file is already open in a tab, just activate it
    const existing = getTab(tabId);
    if (existing) {
      activateTab(tabId);
      return tabId;
    }

    // If no tabs exist, create one
    if (tabList().length === 0) {
      const newTab = createTabState(entry, rootId);
      setTabList([newTab]);
      setActiveId(tabId);
      persistSession();
      return tabId;
    }

    // Replace the active tab's identity with the new file
    const currentActiveId = activeId();
    if (currentActiveId) {
      snapshotActiveTab();
      const newTab = createTabState(entry, rootId);
      setTabList((prev) => prev.map((t) => (t.id === currentActiveId ? newTab : t)));
      setActiveId(tabId);
    }

    persistSession();
    return tabId;
  }

  function openTab(entry: FSEntry, rootId: string, opts?: { background?: boolean; append?: boolean }): TabId {
    const background = opts?.background ?? false;
    const append = opts?.append ?? false;
    let tabId = makeTabId(rootId, entry.path);

    // If already open, generate a unique ID for the duplicate
    if (getTab(tabId)) {
      tabCounter++;
      tabId = `${tabId}#${tabCounter}`;
    }

    const newTab = { ...createTabState(entry, rootId), id: tabId };

    if (!background && activeId()) {
      snapshotActiveTab();
    }

    if (append) {
      setTabList((prev) => [...prev, newTab]);
    } else {
      // Add new tab after the active tab (or at end)
      setTabList((prev) => {
        const activeIdx = prev.findIndex((t) => t.id === activeId());
        if (activeIdx >= 0) {
          const next = [...prev];
          next.splice(activeIdx + 1, 0, newTab);
          return next;
        }
        return [...prev, newTab];
      });
    }

    if (!background) {
      setActiveId(tabId);
    }

    persistSession();
    return tabId;
  }

  function closeTab(tabId: TabId): boolean {
    const tab = getTab(tabId);
    if (!tab) return true;

    // Push to closed tabs stack for reopen
    closedTabsStack.push({ ...tab, needsLoad: true });
    if (closedTabsStack.length > MAX_CLOSED_TABS) closedTabsStack.shift();

    const tabs = tabList();
    const idx = tabs.findIndex((t) => t.id === tabId);

    setTabList((prev) => prev.filter((t) => t.id !== tabId));

    // If closing the active tab, activate the nearest tab
    if (activeId() === tabId) {
      const remaining = tabs.filter((t) => t.id !== tabId);
      if (remaining.length === 0) {
        setActiveId(null);
        pane.setSelectedFile(null);
        pane.setSelectedRootId(null);
        pane.setHtml("");
        pane.setFrontmatter(null);
        pane.setEditorContent("");
        pane.setSavedContent("");
        pane.setEditorMode("preview");
      } else {
        const nextIdx = Math.min(idx, remaining.length - 1);
        setActiveId(remaining[nextIdx]!.id);
        restoreActiveTab();
      }
    }

    persistSession();
    return true;
  }

  function closeOtherTabs(tabId: TabId): void {
    const tabs = tabList();
    for (const t of tabs) {
      if (t.id !== tabId) {
        closeTab(t.id);
      }
    }
  }

  function closeAllTabs(): void {
    setTabList([]);
    setActiveId(null);
    pane.setSelectedFile(null);
    pane.setSelectedRootId(null);
    pane.setHtml("");
    pane.setFrontmatter(null);
    pane.setEditorContent("");
    pane.setSavedContent("");
    pane.setEditorMode("preview");
    persistSession();
  }

  function closeTabsToRight(tabId: TabId): void {
    const tabs = tabList();
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    const toClose = tabs.slice(idx + 1);
    for (const t of toClose) {
      closeTab(t.id);
    }
  }

  function closeTabsByRoot(rootId: string): void {
    const tabs = tabList().filter((t) => t.rootId === rootId);
    for (const t of tabs) {
      closeTab(t.id);
    }
  }

  function reopenClosedTab(): TabState | undefined {
    const tab = closedTabsStack.pop();
    if (!tab) return undefined;

    if (activeId()) snapshotActiveTab();

    // Re-add the tab (at the end)
    setTabList((prev) => [...prev, tab]);
    setActiveId(tab.id);
    restoreActiveTab();
    persistSession();
    return tab;
  }

  function activateTab(tabId: TabId): void {
    if (activeId() === tabId) return;
    snapshotActiveTab();
    setActiveId(tabId);
    restoreActiveTab();
    persistSession();
  }

  function reorderTabs(newOrder: TabId[]): void {
    setTabList((prev) => {
      const tabMap = new Map(prev.map((t) => [t.id, t]));
      const reordered: TabState[] = [];
      for (const id of newOrder) {
        const tab = tabMap.get(id);
        if (tab) reordered.push(tab);
      }
      for (const tab of prev) {
        if (!newOrder.includes(tab.id)) reordered.push(tab);
      }
      return reordered;
    });
    persistSession();
  }

  function updateActiveTabContent(content: Partial<Pick<TabState, "editorContent" | "savedContent" | "html" | "frontmatter" | "includePaths">>): void {
    const id = activeId();
    if (!id) return;
    setTabList((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...content, needsLoad: false } : t)),
    );
  }

  function updateTabFile(tabId: TabId, newFilePath: string, newFileName: string): void {
    const tab = getTab(tabId);
    if (!tab) return;
    const newId = makeTabId(tab.rootId, newFilePath);
    setTabList((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        return { ...t, id: newId, filePath: newFilePath, fileName: newFileName };
      }),
    );
    if (activeId() === tabId) setActiveId(newId);
    persistSession();
  }

  function markTabNeedsLoad(tabId: TabId): void {
    setTabList((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, needsLoad: true } : t)),
    );
  }

  let persistTimer: ReturnType<typeof setTimeout> | undefined;

  function persistSession(): void {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const tabs = tabList();
      if (tabs.length === 0) {
        localStorage.removeItem("asciimark-tab-session");
        return;
      }
      setTabSession({
        tabs: tabs.map((t) => ({
          id: t.id,
          filePath: t.filePath,
          rootId: t.rootId,
          fileName: t.fileName,
          isPinned: true,
          editorMode: t.editorMode,
        })),
        activeTabId: activeId(),
      });
    }, 500);
  }

  function getPersistedSession(): PersistedTabSession | null {
    return getTabSession();
  }

  return {
    tabs: tabList,
    activeTabId: activeId,

    openTab,
    loadInActiveTab,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    closeTabsToRight,
    closeTabsByRoot,
    activateTab,
    reorderTabs,
    reopenClosedTab,

    snapshotActiveTab,
    restoreActiveTab,
    updateActiveTabContent,
    updateTabFile,
    markTabNeedsLoad,

    getTab,
    findTabByFile,
    getActiveTab,
    getDirtyTabs,

    persistSession,
    getPersistedSession,
  };
}
