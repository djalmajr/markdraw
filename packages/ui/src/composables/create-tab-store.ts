import { createSignal, getOwner, onCleanup } from "solid-js";
import type { FSEntry } from "@markdraw/core/types.ts";
import {
  type TabId,
  type TabState,
  type PersistedTab,
  type PersistedTabSession,
  type PreviewScrollAnchor,
  makeTabId,
  getTabSession,
  setTabSession,
} from "@markdraw/core/tabs.ts";
import * as m from "@markdraw/i18n";
import type { PaneViewSlice } from "./create-pane-store.ts";

type TabContent = Partial<Pick<TabState, "editorContent" | "savedContent" | "html" | "frontmatter" | "includePaths">>;

export interface TabScrollPositions {
  editorScrollTop?: number;
  previewScrollTop?: number;
  previewScrollAnchor?: PreviewScrollAnchor | null;
}

export interface TabStore {
  tabs: () => TabState[];
  activeTabId: () => TabId | null;
  /** Advances when a tab is selected, including after closing the active tab. */
  activationVersion: () => number;

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
  /** Reopen the most recently closed tab. Returns the tab or undefined if stack is empty.
   *  When a live tab already holds the closed tab's id (a file moved onto its
   *  path), no second tab with that id is created: the live tab is activated,
   *  unless the closed tab carries unsaved edits the live one does not hold,
   *  which come back as the draft `setReopenResolver` builds (and are dropped
   *  in favour of the live tab when no resolver is set). */
  reopenClosedTab(): TabState | undefined;
  /** Builds the draft with no file behind it that keeps the edits of a closed
   *  tab whose id is taken. It receives the closed tab as it was left, with
   *  `needsLoad` cleared when its buffer is worth keeping; null drops it. */
  setReopenResolver(resolve: ((closed: TabState) => TabState | null) | null): void;
  /** Pin a tab so it's no longer treated as a preview slot — VSCode
   *  semantics: pinned tabs are permanent (their italic name turns
   *  back to upright) and `loadInActiveTab` won't replace them. */
  pinTab(tabId: TabId): void;

  snapshotActiveTab(scrollPositions?: TabScrollPositions): void;
  /** Set by the pane view so the store can capture live DOM scroll state
   *  before any tab switch rewrites the pane's working copy. */
  setScrollCapture(capture: ((tabId: TabId) => TabScrollPositions) | null): void;
  restoreActiveTab(): void;
  updateActiveTabContent(content: TabContent): void;
  updateTabContent(tabId: TabId, content: TabContent & Partial<Pick<TabState, "editorMode" | "needsLoad" | "diskChange">>): void;
  clearTabDiskChange(tabId: TabId, change: symbol): void;
  /** `resolveCollision` lets the tab take an identity another tab already has.
   *  The tab it displaces is passed to the callback, which returns what the
   *  reopen stack keeps in its place (a draft with no file) or null to drop it. */
  updateTabFile(tabId: TabId, newFilePath: string, newFileName: string, newRootId?: string, content?: TabContent, resolveCollision?: (displaced: TabState) => TabState | null): TabState | undefined;
  markTabNeedsLoad(tabId: TabId): void;

  getTab(tabId: TabId): TabState | undefined;
  /** The tab showing a file: the one with the canonical id, else a tab of that
   *  root and path whose id carries a suffix (a tab moved onto the path while
   *  another held the name, or a duplicate). The active one wins among several. */
  findTabByFile(filePath: string, rootId: string): TabState | undefined;
  getActiveTab(): TabState | undefined;
  getDirtyTabs(): TabState[];

  persistSession(): void;
  getPersistedSession(): PersistedTabSession | null;
  /** Saved tabs whose root has not reopened yet. Every write of the session
   *  appends them after the live tabs, so a reload that lands before a slow
   *  folder opens does not erase that folder's tabs from storage. `activeTabId`
   *  is the saved active tab, kept while no live tab is active. Pass `null`
   *  once nothing is pending. */
  holdPendingSession(pending: PersistedTabSession | null): void;
  /** The pane that owns this store is gone: drop the write that is waiting and
   *  ignore every later one, so the store cannot bring its storage key back. */
  discardSession(): void;
  isSessionDiscarded(): boolean;
  /** The id a tab has now: a tab renamed or moved while the saved session is
   *  still being restored gets a new id, and the snapshot only knows the old
   *  one. Ids that were never renamed come back unchanged. */
  resolveTabId(tabId: TabId): TabId;
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

// A recovered draft keeps only the base name in `fileName` and its number in
// the language-independent path (`scratch://alpha (recovered 2).md`); the
// visible suffix is derived here, in the language in use at that moment.
const RECOVERED_PATH = /^scratch:\/\/.* \(recovered (\d+)\)(?:\.[^./]*)?$/;

/** The name to show for a tab: the file name, plus the localized recovery
 *  suffix for a recovered draft. Reads the locale, so call it where the caller
 *  tracks `useLocale()` (JSX, a memo) or at the moment of a selection. */
export function tabDisplayName(tab: Pick<TabState, "fileName" | "filePath">): string {
  const n = RECOVERED_PATH.exec(tab.filePath)?.[1];
  if (!n) return tab.fileName;
  const dot = tab.fileName.lastIndexOf(".");
  const stem = dot > 0 ? tab.fileName.slice(0, dot) : tab.fileName;
  const ext = dot > 0 ? tab.fileName.slice(dot) : "";
  return `${stem} ${m.tab_recovered_draft({ n: Number(n) })}${ext}`;
}

export function createTabStore(config: TabStoreConfig): TabStore {
  const { pane, storageKey, onTabSelected } = config;

  const [tabList, setTabList] = createSignal<TabState[]>([]);
  const [activeId, setActiveId] = createSignal<TabId | null>(null);
  const [activationVersion, setActivationVersion] = createSignal(0);
  let scrollCapture: ((tabId: TabId) => TabScrollPositions) | null = null;
  let tabCounter = 0;
  const closedTabsStack: TabState[] = [];
  const MAX_CLOSED_TABS = 20;

  function selectActiveTab(tabId: TabId | null): void {
    setActiveId(tabId);
    if (tabId !== null) setActivationVersion((version) => version + 1);
  }

  function getTab(tabId: TabId): TabState | undefined {
    return tabList().find((t) => t.id === tabId);
  }

  function findTabByFile(filePath: string, rootId: string): TabState | undefined {
    const canonical = getTab(makeTabId(rootId, filePath));
    if (canonical) return canonical;
    const same = tabList().filter((t) => t.rootId === rootId && t.filePath === filePath);
    return same.find((t) => t.id === activeId()) ?? same[0];
  }

  function getActiveTab(): TabState | undefined {
    const id = activeId();
    return id ? getTab(id) : undefined;
  }

  function getDirtyTabs(): TabState[] {
    return tabList().filter((t) => t.editorContent !== t.savedContent);
  }

  function snapshotActiveTab(scrollPositions?: TabScrollPositions): void {
    const id = activeId();
    if (!id) return;

    const captured = scrollPositions ?? scrollCapture?.(id);
    const currentContent = pane.editorContent();
    const currentSaved = pane.savedContent();
    const currentHtml = pane.html();
    const currentFrontmatter = pane.frontmatter();
    const currentMode = pane.editorMode();
    const loading = pane.loading();

    setTabList((prev) =>
      prev.map((t) => {
        if (t.id !== id || t.needsLoad) return t;
        const reloading = t.diskChange && loading && !currentHtml;
        const positions = reloading ? undefined : captured;
        return {
          ...t,
          editorContent: currentContent,
          savedContent: currentSaved,
          html: reloading ? t.html : currentHtml,
          frontmatter: reloading ? t.frontmatter : currentFrontmatter,
          editorMode: currentMode,
          editorScrollTop: positions?.editorScrollTop ?? t.editorScrollTop,
          previewScrollTop: positions?.previewScrollTop ?? t.previewScrollTop,
          previewScrollAnchor: positions?.previewScrollAnchor !== undefined
            ? positions.previewScrollAnchor
            : t.previewScrollAnchor,
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
      previewScrollAnchor: null,
      // New tabs land in the "preview" slot — italic in the tab bar,
      // replaced by the next single-click. Promoted via `pinTab` on
      // double-click or the first edit (see Editor's onChange).
      isPinned: false,
      includePaths: [],
      needsLoad,
    };
  }

  function loadInActiveTab(entry: FSEntry, rootId: string): TabId {
    // The tab already showing the file keeps its id, suffix included.
    const existing = findTabByFile(entry.path, rootId);
    const tabId = existing?.id ?? makeTabId(rootId, entry.path);

    // Empty/scratch ("+") tab acts as a passthrough: opening a file
    // while it's active never leaves it behind, whether the target is
    // brand-new (we recycle the slot below) or already open elsewhere
    // (we drop the placeholder when activating the existing tab).
    const active = tabList().find((t) => t.id === activeId());
    const emptyActive = active && active.filePath === "" ? active : null;

    // If this file is already open in a tab, just activate it.
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
      selectActiveTab(tabId);
      persistSession();
      return tabId;
    }

    // If no tabs exist, create one
    if (tabList().length === 0) {
      const newTab = createTabState(entry, rootId);
      setTabList([newTab]);
      selectActiveTab(tabId);
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
      selectActiveTab(tabId);
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
      selectActiveTab(tabId);
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
    selectActiveTab(nextId);
    if (next) {
      // Bulk tab actions call the store directly. Keep the buffer and its
      // file identity paired even when the host has no close callback.
      pane.setSelectedFile(next.filePath ? { path: next.filePath, name: tabDisplayName(next), kind: "file" } : null);
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
    selectActiveTab(null);
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

  let reopenResolver: ((closed: TabState) => TabState | null) | null = null;

  function setReopenResolver(resolve: ((closed: TabState) => TabState | null) | null): void {
    reopenResolver = resolve;
  }

  function reopenClosedTab(): TabState | undefined {
    const closed = closedTabsStack.pop();
    if (!closed) return undefined;

    // The working buffer of the active tab is only in the pane until now.
    if (activeId()) snapshotActiveTab();

    let tab = closed;
    const live = getTab(closed.id);
    if (live) {
      // A tab id is the file identity: never two tabs with one id. Closing and
      // activation look tabs up by id, so a twin could not be told apart.
      const edits = closed.editorContent !== closed.savedContent
        && closed.editorContent !== live.editorContent;
      const draft = edits ? reopenResolver?.({ ...closed, needsLoad: false }) : null;
      if (!draft || getTab(draft.id)) {
        if (activeId() !== live.id) {
          selectActiveTab(live.id);
          restoreTab(live);
          persistSession();
          onTabSelected?.(live);
        }
        return live;
      }
      tab = draft;
    }

    // Re-add the tab (at the end)
    setTabList((prev) => [...prev, tab]);
    selectActiveTab(tab.id);
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
    selectActiveTab(tabId);
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

  function clearTabDiskChange(tabId: TabId, change: symbol): void {
    setTabList((prev) => prev.map((tab) =>
      tab.id === tabId && tab.diskChange === change ? { ...tab, diskChange: undefined } : tab,
    ));
  }

  function updateTabFile(tabId: TabId, newFilePath: string, newFileName: string, newRootId?: string, content?: TabContent, resolveCollision?: (displaced: TabState) => TabState | null): TabState | undefined {
    const tab = getTab(tabId);
    if (!tab) return;
    const rootId = newRootId ?? tab.rootId;
    const baseId = makeTabId(rootId, newFilePath);
    const active = activeId() === tabId;
    let renamed: TabState | undefined;
    let stale: TabState | undefined;
    setTabList((prev) => {
      let newId = baseId;
      const collision = newId !== tabId && prev.some((t) => t.id === newId);
      if (collision && !resolveCollision) return prev;
      // Keep both buffers when the moved tab is in the background; never
      // replace the working buffer of the currently active destination tab.
      if (collision && !active) {
        while (prev.some((t) => t.id === newId && t.id !== tabId)) newId = `${baseId}#${++tabCounter}`;
      } else if (collision) {
        let closedId: string;
        do closedId = `${baseId}#${++tabCounter}`;
        while (prev.some((t) => t.id === closedId));
        stale = { ...prev.find((t) => t.id === baseId)!, id: closedId };
      }
      renamed = { ...tab, ...content, id: newId, rootId, filePath: newFilePath, fileName: newFileName };
      return prev.filter((t) => !(collision && active && t.id === baseId))
        .map((t) => t.id === tabId ? { ...t, ...renamed! } : t);
    });
    if (!renamed) return;
    // The callback runs outside the list updater: it may read other state.
    const displaced = stale ? resolveCollision?.(stale) : null;
    if (displaced) {
      closedTabsStack.push(displaced);
      if (closedTabsStack.length > MAX_CLOSED_TABS) closedTabsStack.shift();
    }
    if (active) setActiveId(renamed.id);
    if (renamed.id !== tabId) {
      // Everything that already pointed at the old id (an earlier rename of
      // the same tab) now points at the new one, so the chain stays flat.
      // The id is the one the tab really got: a background move onto a
      // taken name gets a suffixed id.
      for (const [from, to] of renamedIds) if (to === tabId) renamedIds.set(from, renamed.id);
      renamedIds.set(tabId, renamed.id);
    }
    persistSession();
    return renamed;
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
  // A save still pending when the owner goes away (app teardown, a test's
  // root disposed) must not fire later against a torn-down environment.
  if (getOwner()) onCleanup(() => clearTimeout(persistTimer));
  let pendingSession: PersistedTabSession | null = null;
  let discarded = false;
  // Old id -> current id of tabs renamed during this store's life: the saved
  // active tab of the snapshot is looked up through it.
  const renamedIds = new Map<TabId, TabId>();

  function resolveTabId(tabId: TabId): TabId {
    return renamedIds.get(tabId) ?? tabId;
  }

  function persistSession(): void {
    if (discarded) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const live: PersistedTab[] = tabList().map((t) => ({
        id: t.id,
        filePath: t.filePath,
        rootId: t.rootId,
        fileName: t.fileName,
        isPinned: t.isPinned,
        editorMode: t.editorMode,
      }));
      const liveIds = new Set(live.map((t) => t.id));
      const held = pendingSession?.tabs.filter((t) => !liveIds.has(t.id)) ?? [];
      const tabs = [...live, ...held];
      if (tabs.length === 0) {
        if (storageKey) {
          localStorage.removeItem(storageKey);
        } else {
          localStorage.removeItem("markdraw-tab-session");
        }
        return;
      }
      // While nothing is active yet (the saved batch is still reopening) the
      // saved active tab stays the saved one.
      const savedActive = pendingSession?.activeTabId == null ? null : resolveTabId(pendingSession.activeTabId);
      const activeTabId = activeId()
        ?? (savedActive !== null && tabs.some((t) => t.id === savedActive) ? savedActive : null);
      if (typeof localStorage === "undefined") return;
      setTabSession({ tabs, activeTabId }, storageKey);
    }, 500);
  }

  function holdPendingSession(pending: PersistedTabSession | null): void {
    pendingSession = pending;
  }

  function isSessionDiscarded(): boolean {
    return discarded;
  }

  function discardSession(): void {
    discarded = true;
    clearTimeout(persistTimer);
    pendingSession = null;
  }

  function getPersistedSession(): PersistedTabSession | null {
    return getTabSession(storageKey);
  }

  return {
    tabs: tabList,
    activeTabId: activeId,
    activationVersion,

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
    setReopenResolver,
    pinTab,

    snapshotActiveTab,
    setScrollCapture: (capture) => { scrollCapture = capture; },
    restoreActiveTab,
    updateActiveTabContent,
    updateTabContent,
    clearTabDiskChange,
    updateTabFile,
    markTabNeedsLoad,

    getTab,
    findTabByFile,
    getActiveTab,
    getDirtyTabs,

    persistSession,
    getPersistedSession,
    holdPendingSession,
    discardSession,
    isSessionDiscarded,
    resolveTabId,
  };
}
