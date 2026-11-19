import { createSignal } from "solid-js";
import type { FSEntry } from "@markdraw/core/types.ts";
import {
  type TabId,
  type TabState,
  type PersistedTabSession,
  makeTabId,
  getTabSession,
  setTabSession,
} from "@markdraw/core/tabs.ts";
import type { PaneViewSlice } from "./create-pane-store.ts";

type TabContent = Partial<Pick<TabState, "editorContent" | "savedContent" | "html" | "frontmatter" | "includePaths">>;

export interface TabStore {
  tabs: () => TabState[];
  activeTabId: () => TabId | null;

  /** Create a new tab (used by "Open in New Tab", middle-click,
   *  file-tree double-click, etc.). The result is **pinned by
   *  default** — explicit-open gestures are how the user signals
   *  "keep this around"; only `loadInActiveTab` creates the
   *  ephemeral preview slot. Pass `preview: true` if a caller
   *  genuinely wants a non-pinned tab (rare). */
  openTab(entry: FSEntry, rootId: string, opts?: { background?: boolean; append?: boolean; preview?: boolean }): TabId;
  /** Replace the active tab's file (used by single-click in file tree). Creates a tab if none exist. */
  loadInActiveTab(entry: FSEntry, rootId: string): TabId;
  /** Returns the replacement active tab, null when the pane becomes empty,
   * or undefined when the active tab is unchanged. */
  closeTab(tabId: TabId): TabState | null | undefined;
  closeTabs(tabIds: readonly TabId[]): TabState | null | undefined;
  closeOtherTabs(tabId: TabId): void;
  closeAllTabs(): void;
  closeTabsToRight(tabId: TabId): void;
  closeTabsByRoot(rootId: string): TabState | null | undefined;
  activateTab(tabId: TabId): void;
  reorderTabs(newOrder: TabId[]): void;
  /** Reopen the most recently closed tab. Returns the tab or undefined if stack is empty. */
  reopenClosedTab(): TabState | undefined;
  /** Pin a tab so it's no longer treated as a preview slot — VSCode
   *  semantics: pinned tabs are permanent (their italic name turns
   *  back to upright) and `loadInActiveTab` won't replace them. */
  pinTab(tabId: TabId): void;

  snapshotActiveTab(scrollPositions?: { editorScrollTop: number; previewScrollTop: number }): void;
  restoreActiveTab(): void;
  updateActiveTabContent(content: TabContent): void;
  updateTabContent(tabId: TabId, content: TabContent & Partial<Pick<TabState, "editorMode" | "needsLoad">>): void;
  updateTabFile(tabId: TabId, newFilePath: string, newFileName: string): TabState | undefined;
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
  /** Override the localStorage key the persisted tab list lives at.
   *  Used by `createPaneStore` to give each pane an isolated session
   *  blob. Defaults to the legacy single-pane key. */
  storageKey?: string;
  onTabSelected?: (tab: TabState | null) => void;
}

export function createTabStore(config: TabStoreConfig): TabStore {
  const { pane, storageKey, onTabSelected } = config;

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
        if (t.id !== id || t.needsLoad) return t;
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
    restoreTab(tab);
  }

  function restoreTab(tab: TabState): void {
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
      // New tabs land in the "preview" slot — italic in the tab bar,
      // replaced by the next single-click. Promoted via `pinTab` on
      // double-click or the first edit (see Editor's onChange).
      isPinned: false,
      includePaths: [],
      needsLoad,
    };
  }

  function loadInActiveTab(entry: FSEntry, rootId: string): TabId {
    const tabId = makeTabId(rootId, entry.path);

    // Empty/scratch ("+") tab acts as a passthrough: opening a file
    // while it's active never leaves it behind, whether the target is
    // brand-new (we recycle the slot below) or already open elsewhere
    // (we drop the placeholder when activating the existing tab).
    const active = tabList().find((t) => t.id === activeId());
    const emptyActive = active && active.filePath === "" ? active : null;

    // If this file is already open in a tab, just activate it.
    const existing = getTab(tabId);
    if (existing) {
      if (emptyActive && emptyActive.id !== existing.id) {
        // Drop the empty placeholder silently — skip closedTabsStack,
        // there's nothing meaningful to reopen via Cmd+Shift+T.
        setTabList((prev) => prev.filter((t) => t.id !== emptyActive.id));
      }
      activateTab(tabId);
      return tabId;
    }

    // Empty tab takes priority over the preview slot — recycle it in
    // place so the file lands where the user expected.
    if (emptyActive) {
      snapshotActiveTab();
      const newTab = createTabState(entry, rootId);
      setTabList((prev) => prev.map((t) => (t.id === emptyActive.id ? newTab : t)));
      setActiveId(tabId);
      persistSession();
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

    // VSCode parity: there is **at most one preview slot per pane**,
    // regardless of which tab is currently active. So we recycle any
    // existing preview (`!isPinned`) tab — even when it isn't the
    // active one, e.g. the user opened A as preview, middle-clicked
    // B (pinned, becomes active), then single-clicks C: C must
    // replace the dormant preview A, not stack as a second preview.
    const previewIdx = tabList().findIndex((t) => !t.isPinned);
    if (previewIdx >= 0) {
      const previewTab = tabList()[previewIdx]!;
      // Snapshot the active tab's working buffer first — if the
      // active tab IS the preview we're about to recycle, the
      // snapshot keeps any in-flight content from being silently
      // dropped on the way out.
      snapshotActiveTab();
      const newTab = createTabState(entry, rootId);
      setTabList((prev) => prev.map((t) => (t.id === previewTab.id ? newTab : t)));
      setActiveId(tabId);
      persistSession();
      return tabId;
    }

    // No preview slot exists — create one fresh. `preview: true` is
    // critical here: the default `openTab` behaviour is to pin
    // (used by middle-click, tree dblclick, "Open in New Tab");
    // this is the only path that legitimately creates a preview.
    return openTab(entry, rootId, { preview: true });
  }

  function openTab(entry: FSEntry, rootId: string, opts?: { background?: boolean; append?: boolean; preview?: boolean }): TabId {
    const background = opts?.background ?? false;
    const append = opts?.append ?? false;
    const preview = opts?.preview ?? false;
    const baseId = makeTabId(rootId, entry.path);
    let tabId = baseId;
    const currentId = activeId();

    if (!background && currentId) {
      snapshotActiveTab();
    }

    setTabList((prev) => {
      // The updater includes tabs already opened in this turn (session restore).
      while (prev.some((tab) => tab.id === tabId)) {
        tabId = `${baseId}#${++tabCounter}`;
      }
      const newTab = { ...createTabState(entry, rootId), id: tabId, isPinned: !preview };
      const activeIdx = append ? -1 : prev.findIndex((tab) => tab.id === currentId);
      if (activeIdx < 0) return [...prev, newTab];
      const next = [...prev];
      next.splice(activeIdx + 1, 0, newTab);
      return next;
    });

    if (!background) {
      setActiveId(tabId);
    }

    persistSession();
    return tabId;
  }

  function closeTab(tabId: TabId): TabState | null | undefined {
    return closeTabs([tabId]);
  }

  function closeTabs(tabIds: readonly TabId[]): TabState | null | undefined {
    const currentId = activeId();
    let nextId = currentId;
    const remaining = [...tabList()];
    for (const id of tabIds) {
      const index = remaining.findIndex((tab) => tab.id === id);
      if (index < 0) continue;
      const [closed] = remaining.splice(index, 1);
      closedTabsStack.push({ ...closed!, needsLoad: true });
      if (closedTabsStack.length > MAX_CLOSED_TABS) closedTabsStack.shift();
      if (nextId === id) nextId = (remaining[index] ?? remaining.at(-1))?.id ?? null;
    }
    if (remaining.length === tabList().length) return;
    const closedIds = new Set(tabIds);
    setTabList((prev) => prev.filter((tab) => !closedIds.has(tab.id)));
    persistSession();
    if (nextId === currentId) return;

    const next = remaining.find((tab) => tab.id === nextId) ?? null;
    setActiveId(nextId);
    if (next) {
      // Bulk tab actions call the store directly. Keep the buffer and its
      // file identity paired even when the host has no close callback.
      pane.setSelectedFile(next.filePath ? { path: next.filePath, name: next.fileName, kind: "file" } : null);
      pane.setSelectedRootId(next.rootId || null);
      restoreTab(next);
    } else {
      clearPane();
    }
    onTabSelected?.(next);
    return next;
  }

  function closeOtherTabs(tabId: TabId): void {
    closeTabs(tabList().filter((tab) => tab.id !== tabId).map((tab) => tab.id));
  }

  function closeAllTabs(): void {
    setTabList([]);
    setActiveId(null);
    clearPane();
    persistSession();
    onTabSelected?.(null);
  }

  function clearPane(): void {
    pane.setSelectedFile(null);
    pane.setSelectedRootId(null);
    pane.setHtml("");
    pane.setFrontmatter(null);
    pane.setEditorContent("");
    pane.setSavedContent("");
    pane.setEditorMode("preview");
  }

  function closeTabsToRight(tabId: TabId): void {
    const tabs = tabList();
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    closeTabs(tabs.slice(idx + 1).map((tab) => tab.id));
  }

  function closeTabsByRoot(rootId: string): TabState | null | undefined {
    return closeTabs(tabList().filter((tab) => tab.rootId === rootId).map((tab) => tab.id));
  }

  function reopenClosedTab(): TabState | undefined {
    const tab = closedTabsStack.pop();
    if (!tab) return undefined;

    if (activeId()) snapshotActiveTab();

    // Re-add the tab (at the end)
    setTabList((prev) => [...prev, tab]);
    setActiveId(tab.id);
    restoreTab(tab);
    persistSession();
    onTabSelected?.(tab);
    return tab;
  }

  function activateTab(tabId: TabId): void {
    if (activeId() === tabId) return;
    const tab = getTab(tabId);
    if (!tab) return;
    snapshotActiveTab();
    setActiveId(tabId);
    restoreTab(tab);
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

  function updateActiveTabContent(content: TabContent): void {
    const id = activeId();
    if (id) updateTabContent(id, content);
  }

  function updateTabContent(tabId: TabId, content: Parameters<TabStore["updateTabContent"]>[1]): void {
    setTabList((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, ...content } : t)),
    );
  }

  function updateTabFile(tabId: TabId, newFilePath: string, newFileName: string): TabState | undefined {
    const tab = getTab(tabId);
    if (!tab) return;
    const newId = makeTabId(tab.rootId, newFilePath);
    // No-op when the rewrite would collide with an EXISTING tab id
    // (other than the one being renamed). Caught by the
    // create-tab-store.stateful property test: rename-to-an-already-
    // open-name used to drop two tabs into the same id, breaking the
    // tabs-are-unique invariant and corrupting later operations
    // keyed by id (close, activate). The FS layer rejects the rename
    // for the same reason — staying consistent at the store level.
    if (newId !== tabId && tabList().some((t) => t.id === newId)) return;
    const renamedFile = { id: newId, filePath: newFilePath, fileName: newFileName };
    setTabList((prev) => prev.map((t) => t.id === tabId ? { ...t, ...renamedFile } : t));
    if (activeId() === tabId) setActiveId(newId);
    persistSession();
    return { ...tab, ...renamedFile };
  }

  function markTabNeedsLoad(tabId: TabId): void {
    setTabList((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, needsLoad: true } : t)),
    );
  }

  function pinTab(tabId: TabId): void {
    const tab = getTab(tabId);
    if (!tab || tab.isPinned) return;
    setTabList((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, isPinned: true } : t)),
    );
    persistSession();
  }

  let persistTimer: ReturnType<typeof setTimeout> | undefined;

  function persistSession(): void {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const tabs = tabList();
      if (tabs.length === 0) {
        if (storageKey) {
          localStorage.removeItem(storageKey);
        } else {
          localStorage.removeItem("markdraw-tab-session");
        }
        return;
      }
      setTabSession(
        {
          tabs: tabs.map((t) => ({
            id: t.id,
            filePath: t.filePath,
            rootId: t.rootId,
            fileName: t.fileName,
            isPinned: t.isPinned,
            editorMode: t.editorMode,
          })),
          activeTabId: activeId(),
        },
        storageKey,
      );
    }, 500);
  }

  function getPersistedSession(): PersistedTabSession | null {
    return getTabSession(storageKey);
  }

  return {
    tabs: tabList,
    activeTabId: activeId,

    openTab,
    loadInActiveTab,
    closeTab,
    closeTabs,
    closeOtherTabs,
    closeAllTabs,
    closeTabsToRight,
    closeTabsByRoot,
    activateTab,
    reorderTabs,
    reopenClosedTab,
    pinTab,

    snapshotActiveTab,
    restoreActiveTab,
    updateActiveTabContent,
    updateTabContent,
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
