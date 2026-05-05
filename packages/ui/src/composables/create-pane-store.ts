import { createSignal, type Setter } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import type { Frontmatter } from "@asciimark/core/frontmatter.ts";

export type EditorMode = "edit" | "split" | "preview";

/**
 * The slice of viewer state that lives per-pane: which file is loaded,
 * the editor and converted-HTML content, the editor mode, and the
 * loading flag. Workspace data (roots, recents, theme, fonts) stays
 * outside on `AppState` because there's only one workspace tree at a
 * time. The TabStore is attached separately so the pane owns its own
 * tab list and snapshot/restore logic.
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
}

/**
 * Build a fresh `PaneStore` with empty content. Caller attaches a
 * TabStore separately (see `createTabStore`) — this keeps the
 * dependency one-way: TabStore needs a pane to snapshot to/from, but
 * the pane doesn't need to know the TabStore exists.
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

  return {
    paneId,
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
}
