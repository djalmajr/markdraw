import { createSignal, flush, type Setter } from "solid-js";
import type { FSEntry } from "@markdraw/core/types.ts";
import type { Frontmatter } from "@markdraw/core/frontmatter.ts";
import { getStoredTableWrap } from "@markdraw/core/editor-prefs.ts";
import { migrateLegacyTabSession, planTabRestore, type PersistedTabSession, type TabState } from "@markdraw/core/tabs.ts";
import { createTabStore, type TabStore } from "./create-tab-store.ts";

export type EditorMode = "edit" | "split" | "preview";

/**
 * The slice of viewer state that lives per-pane: which file is loaded,
 * the editor and converted-HTML content, the editor mode, and the
 * loading flag. Workspace data (roots, recents, theme, fonts) stays
 * outside on `AppState` because there's only one workspace tree at a
 * time. The TabStore composes on top of this slice — it's bundled
 * into the PaneStore so each pane carries its own tab list (see
 * `createPaneStore` below).
 */
export interface PaneViewSlice {
  editorContent: () => string;
  setEditorContent: Setter<string>;

  savedContent: () => string;
  setSavedContent: Setter<string>;

  html: () => string;
  setHtml: Setter<string>;

  frontmatter: () => Frontmatter | null;
  setFrontmatter: Setter<Frontmatter | null>;

  editorMode: () => EditorMode;
  setEditorMode: Setter<EditorMode>;

  selectedFile: () => FSEntry | null;
  setSelectedFile: Setter<FSEntry | null>;

  selectedRootId: () => string | null;
  setSelectedRootId: Setter<string | null>;

  loading: () => boolean;
  setLoading: Setter<boolean>;
}

export interface PaneStore extends PaneViewSlice {
  paneId: string;
  /** TabStore scoped to this pane. Each pane has its own tab list,
   *  active tab, and closed-tabs LIFO. */
  tabs: TabStore;
  /** Whether wide preview tables wrap to fit width (true) or scroll
   *  horizontally (false). Per-pane, NOT per-tab — deliberately kept off
   *  the PaneViewSlice so the TabStore doesn't snapshot it: split panes
   *  toggle wrap independently. Seeded from the saved default; the
   *  caller persists changes (as the seed for future panes). */
  tableWrap: () => boolean;
  setTableWrap: Setter<boolean>;
}

export type OnPaneTabSelected = (pane: PaneStore, tab: TabState | null) => void;

export interface RestoredTabs {
  /** The saved active tab, when this batch contains it. */
  activeTabId: string | null;
  /** First tab this batch opened (the fallback when the saved active tab
   *  never reopens). */
  firstTabId: string | null;
  /** Every tab this batch opened, in order: the candidates to activate once
   *  the ones before them have been closed again. */
  tabIds: string[];
}

/**
 * Restore the persisted tabs of the roots that just opened into `pane`'s tab
 * store, marking each tab `needsLoad` so activation reads it from disk.
 *
 * `session` is the snapshot the caller took before anything reopened, never
 * the live storage: the tab store rewrites that key while roots are still
 * opening. Restoring is idempotent per root: every root in the batch is
 * recorded in `restoredRootIds`, and a root already there contributes nothing.
 * That is what lets a webview reload restore the roots it reopened at startup
 * and, later, a folder opened from the menu restore only its own tabs.
 */
export function restoreTabsForRoots(
  pane: PaneStore,
  session: PersistedTabSession | null,
  openRootIds: Iterable<string>,
  restoredRootIds: Set<string>,
  findEntry: (filePath: string, rootId: string) => FSEntry | null,
): RestoredTabs {
  const plan = planTabRestore(session, openRootIds, restoredRootIds);
  if (plan.rootIds.length === 0) return { activeTabId: null, firstTabId: null, tabIds: [] };
  for (const rootId of plan.rootIds) restoredRootIds.add(rootId);

  // The IDs returned by openTab also cover tabs still pending publication.
  let firstTabId: string | undefined;
  let activeTabId: string | undefined;
  const tabIds: string[] = [];
  for (const persisted of plan.tabs) {
    const entry = findEntry(persisted.filePath, persisted.rootId);
    if (!entry || entry.kind !== "file") continue;

    const id = pane.tabs.openTab(entry, persisted.rootId, { background: true });
    pane.tabs.markTabNeedsLoad(id);
    firstTabId ??= id;
    tabIds.push(id);
    if (persisted.id === plan.activeTabId) activeTabId = id;
  }
  return { activeTabId: activeTabId ?? null, firstTabId: firstTabId ?? null, tabIds };
}

export interface SessionRestore {
  /** Roots are open (or more of them are): open their saved tabs in the
   *  background. Returns the tab to activate when that decision is now due. */
  rootsChanged(openRootIds: Iterable<string>): string | null;
  /** The initial batch of roots is final. `keepRootIds` are the roots still
   *  wanted for the next start (even if they did not open this time): their
   *  saved tabs stay in storage, every other pending tab is dropped. Returns
   *  the tab to activate: the saved active one, else the first restored, among
   *  the tabs that are still open. */
  settle(keepRootIds: Iterable<string>): string | null;
  /** The roots the saved session has tabs under, read before anything reopened. */
  rootIds(): string[];
}

/**
 * Restores the saved tab session of one pane across the roots that reopen at
 * startup, in whatever order they finish. It reads the saved session once,
 * before anything reopens, keeps the tabs of roots that are still pending in
 * the tab store's next writes, and decides the activation only after the whole
 * initial batch is known, so a persisted active tab whose root opens last still
 * wins. After `settle`, a root opened later activates (once) when nothing else
 * has taken the focus.
 */
export function createSessionRestore(
  pane: PaneStore,
  findEntry: (filePath: string, rootId: string) => FSEntry | null,
): SessionRestore {
  const snapshot = pane.tabs.getPersistedSession();
  const restoredRoots = new Set<string>();
  // null: keep every pending tab (before settling).
  let keep: Set<string> | null = null;
  let activeTabId: string | null = null;
  const restoredTabIds: string[] = [];
  let settled = false;
  let activated = false;

  function hold(): void {
    const tabs = snapshot?.tabs.filter((tab) =>
      !restoredRoots.has(tab.rootId) && (keep === null || keep.has(tab.rootId))) ?? [];
    // The saved active tab outlives the saved tabs: all of them can be live
    // already (their roots opened) while another root still reads, and the
    // write of that moment must not forget which one was active. The tab store
    // only uses it while no tab is active, so a choice made meanwhile wins.
    // Once the saved active tab reopened, the id the restore gave it is the one
    // to save: a duplicate gets a new suffix, and the tab store follows that id
    // if the tab is moved before the last root opens. Until then the saved id
    // stays (the tab store ignores one that no live tab has).
    const savedActive = activeTabId ?? snapshot?.activeTabId ?? null;
    pane.tabs.holdPendingSession(snapshot && (tabs.length > 0 || savedActive !== null)
      ? { tabs, activeTabId: savedActive }
      : null);
  }

  /** `fresh` are the tabs this very call opened: the store publishes them at
   *  the next flush, so reading them back now would miss them. */
  function activation(fresh: readonly string[] = []): string | null {
    if (!settled || activated) return null;
    // Tabs can be closed while the folders reopen (the user closes a folder):
    // the candidate is chosen among those still open, saved active tab first,
    // and the activation is only spent on one that exists.
    // A tab renamed or moved meanwhile is still the one that was saved: follow
    // it to its new id.
    const candidates = (activeTabId === null ? restoredTabIds : [activeTabId, ...restoredTabIds])
      .map((candidate) => pane.tabs.resolveTabId(candidate));
    const id = candidates.find((candidate) =>
      fresh.includes(candidate) || pane.tabs.getTab(candidate) !== undefined);
    if (id === undefined) return null;
    activated = true;
    // The user already picked a tab while the folders were reopening: theirs
    // wins (the tab store writes its own active tab before the saved one).
    return pane.tabs.activeTabId() === null ? id : null;
  }

  hold();

  return {
    rootsChanged(openRootIds) {
      // The pane was collapsed while its folders reopened: nothing to restore.
      if (pane.tabs.isSessionDiscarded()) return null;
      const restored = restoreTabsForRoots(pane, snapshot, openRootIds, restoredRoots, findEntry);
      activeTabId ??= restored.activeTabId;
      restoredTabIds.push(...restored.tabIds);
      hold();
      return activation(restored.tabIds);
    },
    rootIds() {
      return [...new Set(snapshot?.tabs.map((tab) => tab.rootId))];
    },
    settle(keepRootIds) {
      if (pane.tabs.isSessionDiscarded()) return null;
      keep = new Set(keepRootIds);
      settled = true;
      hold();
      // Called from async code, never from a computation: publish what the
      // last roots just opened (or the user just closed) before judging it.
      flush();
      // Flush now: pending tabs of unreachable roots stay, the rest are gone.
      pane.tabs.persistSession();
      return activation();
    },
  };
}

/**
 * Build a fresh `PaneStore` with empty content and an attached
 * TabStore. The TabStore captures the slice's setters at creation
 * time so its snapshot/restore writes back to THIS pane's signals.
 */
export function createPaneStore(paneId: string, onTabSelected?: OnPaneTabSelected): PaneStore {
  const [editorContent, setEditorContent] = createSignal("");
  const [savedContent, setSavedContent] = createSignal("");
  const [html, setHtml] = createSignal("");
  const [frontmatter, setFrontmatter] = createSignal<Frontmatter | null>(null);
  const [editorMode, setEditorMode] = createSignal<EditorMode>("preview");
  const [selectedFile, setSelectedFile] = createSignal<FSEntry | null>(null);
  const [selectedRootId, setSelectedRootId] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  // Per-pane view pref (not part of the tab-snapshotted slice). Seeded
  // from the saved default so a fresh pane respects the last choice.
  const [tableWrap, setTableWrap] = createSignal(getStoredTableWrap());

  const slice: PaneViewSlice = {
    editorContent,
    setEditorContent,
    savedContent,
    setSavedContent,
    html,
    setHtml,
    frontmatter,
    setFrontmatter,
    editorMode,
    setEditorMode,
    selectedFile,
    setSelectedFile,
    selectedRootId,
    setSelectedRootId,
    loading,
    setLoading,
  };

  // Each pane gets its own localStorage slot so two panes can save
  // independent tab lists. The first pane (paneId="pane-0") also
  // absorbs any session left by an older single-pane build via
  // `migrateLegacyTabSession` — idempotent and harmless when there
  // is nothing to migrate.
  const storageKey = `markdraw-tab-session-${paneId}`;
  if (paneId === "pane-0") {
    migrateLegacyTabSession(storageKey);
  }

  const tabs = createTabStore({
    pane: slice,
    storageKey,
    onTabSelected: (tab) => onTabSelected?.(pane, tab),
  });
  const pane: PaneStore = {
    paneId,
    ...slice,
    tabs,
    tableWrap,
    setTableWrap,
  };
  return pane;
}
