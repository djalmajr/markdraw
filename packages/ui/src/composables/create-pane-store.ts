import { createSignal, type Setter } from "solid-js";
import type { FSEntry } from "@markdraw/core/types.ts";
import type { Frontmatter } from "@markdraw/core/frontmatter.ts";
import { getStoredTableWrap } from "@markdraw/core/editor-prefs.ts";
import { migrateLegacyTabSession } from "@markdraw/core/tabs.ts";
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

/**
 * Build a fresh `PaneStore` with empty content and an attached
 * TabStore. The TabStore captures the slice's setters at creation
 * time so its snapshot/restore writes back to THIS pane's signals.
 */
export function createPaneStore(paneId: string): PaneStore {
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

  const tabs = createTabStore({ pane: slice, storageKey });

  return {
    paneId,
    ...slice,
    tabs,
    tableWrap,
    setTableWrap,
  };
}
