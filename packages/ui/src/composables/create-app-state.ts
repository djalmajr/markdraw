import { createEffect, createMemo, createSignal, flush, onSettled, runWithOwner, type Setter } from "solid-js";
import type { FSEntry, QualifiedPath, WorkspaceRoot } from "@markdraw/core/types.ts";
import { getIncludePaths } from "@markdraw/core/asciidoc.ts";
import { getMarkdownIncludePaths } from "@markdraw/core/markdown.ts";
import { createPaneManager, type PaneManager } from "./create-pane-manager.ts";
import type { PaneStore } from "./create-pane-store.ts";
import { createAiChatSessions } from "./create-ai-chat-sessions.ts";
import type { ChatTurn } from "./create-ai-chat-store.ts";
import { createAiInlineStore } from "./create-ai-inline-store.ts";
import {
  type AiContextItem,
  type AiInlineReference,
  buildContextPreamble,
  dedupeTokenLabel,
} from "./ai-context.ts";
import { getChatSessionsIndex } from "@markdraw/core/ai-chat-sessions.ts";
import {
  getRightPanelTabsState,
  setRightPanelTabsState,
  type SpecialTabState,
} from "@markdraw/core/right-panel-tabs.ts";
import { getStoredAiMode, setStoredAiMode, type AIChatMode } from "@markdraw/core/ai-prefs.ts";
import { formatChatTranscript } from "../lib/chat-export.ts";
import type { AIProvider, AITool } from "@markdraw/ai/types.ts";
import type { CustomInstructions } from "@markdraw/ai/slash-commands.ts";
import type { ReadFiles } from "@markdraw/core/asciidoc.ts";
import type { ConvertOptions, ConvertResult } from "@markdraw/core/converter.ts";
import type { Frontmatter } from "@markdraw/core/frontmatter.ts";
import {
  applyCodeTheme,
} from "@markdraw/core/code-theme.ts";
import {
  computeReadingMetrics,
  computeReadingMetricsFromHtml,
  formatReadingTime,
  type ReadingMetrics,
} from "@markdraw/core/reading-metrics.ts";
import {
  getReaderMode,
  setReaderMode as persistReaderMode,
} from "@markdraw/core/reader-mode.ts";
import {
  type BacklinkIndex,
  findBacklinks,
} from "@markdraw/core/backlinks.ts";
import {
  type RecentFile,
  addRecentFile,
  clearRecentFiles,
  getRecentFiles,
  removeRecentFile,
} from "@markdraw/core/recent-files.ts";
import {
  type RecentFolder,
  addRecentFolder,
  clearRecentFolders,
  getRecentFolders,
  removeRecentFolder,
} from "@markdraw/core/recent-folders.ts";
import {
  type FontPrefs,
  FontFamilies,
  FontSizes,
  applyFontPrefs,
  getStoredFontPrefs,
  setStoredFontPrefs,
} from "@markdraw/core/font-prefs.ts";
import {
  type IndentMode,
  getStoredIndentMode,
  getStoredIndentSize,
  getStoredLineNumbers,
  getStoredShowInvisibles,
  getStoredSyncScroll,
  getStoredWrapText,
  setStoredIndentMode,
  setStoredIndentSize,
  setStoredLineNumbers,
  setStoredShowInvisibles,
  setStoredSyncScroll,
  setStoredWrapText,
} from "@markdraw/core/editor-prefs.ts";
import {
  getStoredRespectGitignore,
  getStoredShowAllDirs,
  getStoredShowAllFiles,
  getStoredShowHiddenEntries,
  setStoredRespectGitignore,
  setStoredShowAllDirs,
  setStoredShowAllFiles,
  setStoredShowHiddenEntries,
} from "@markdraw/core/file-tree-prefs.ts";
import {
  type CloseBehavior,
  getStoredCloseBehavior,
  setStoredCloseBehavior,
} from "@markdraw/core/window-prefs.ts";
import {
  type FavoriteFile,
  addFavorite,
  getFavorites,
  isFavorite,
  removeFavorite,
} from "@markdraw/core/favorites.ts";
import { fileKind, isMdFile, UNSUPPORTED_CONTENT } from "@markdraw/core/utils.ts";

export type ThemeMode = "system" | "light" | "dark";

/** An in-progress inline create in the file tree. `parentPath` is the
 *  workspace-relative directory the new entry goes into ("" = workspace root). */
export type CreatingAt = {
  parentPath: string;
  rootId: string;
  kind: "file" | "folder";
};

/** An entry placed on the tree clipboard via "Cut" (move) or "Copy"
 *  (duplicate), waiting for a "Paste" into a target directory. Scoped to a
 *  single root — pasting is only offered on directories of the same `rootId`.
 *  `mode` decides whether Paste moves the original or copies it. */
export type MoveClipboard = {
  entry: FSEntry;
  rootId: string;
  mode: "cut" | "copy";
};

/** A resolved file/folder reference attached to the chat as a context chip
 *  (@-mention and the file-tree "Add to chat" share this single path). For
 *  `kind: "folder"` the content is a subtree listing the host built from the
 *  workspace tree; otherwise it's the file's text. */
export interface AiMentionContext {
  /** The resolved text injected into the prompt (file content / folder listing). */
  content: string;
  kind?: "file" | "folder";
  /** Chip label — the file name, or "dir/" for a folder listing. */
  label: string;
  path?: string;
  rootId?: string;
  rootPath?: string;
  absolutePath?: string;
}

/** The document an edit conversion belongs to, as it is named when the edit
 *  runs (after a rename that is the new path, not the one it loaded under). */
export interface ConvertedDoc {
  filePath: string;
  rootId: string | null;
  tabId: string | null;
}

/** How one open document reads its includes: its workspace root and cache. */
export interface DocReader {
  readFile: (path: string) => Promise<string | null>;
  /** Batched read, one call per layer of nested includes. */
  readFiles?: ReadFiles;
  /** Called after an edit conversion of this document was published (to the
   *  pane, or to the snapshot of its background tab): the loader refreshes what
   *  the document depends on (watched includes). `consulted` is every path that
   *  accepted conversion asked the reader for, missing files included, and
   *  nothing the reader's cache holds from older versions of the text. */
  converted?: (pane: PaneStore, content: string, doc: ConvertedDoc, consulted: ReadonlySet<string>) => void;
}

/** One checklist entry of the live AI plan (model-maintained, user-steered). */
export interface AiPlanItem {
  done: boolean;
  text: string;
}

/** The live plan the model maintains via app__update_plan. */
export interface AiPlanState {
  items: AiPlanItem[];
}

interface AppStateConfig {
  applyTheme: (mode: ThemeMode) => void;
  convertAdoc: (opts: ConvertOptions) => Promise<ConvertResult>;
  convertMarkdown: (opts: ConvertOptions) => Promise<ConvertResult>;
  getStoredTheme: () => ThemeMode;
  printPage?: () => void | Promise<void>;
  /** When provided, the per-document signals on AppState (html,
   *  editorContent, …) proxy through this manager's active pane. The
   *  Phase 1 hosts pass an explicit instance; falling back to a fresh
   *  manager keeps standalone callers (tests, the storybook ext if
   *  any) working without any boilerplate. */
  paneManager?: PaneManager;
  /** Builds the active AI provider for chat/inline/diagram, or null when none
   *  is configured. The single DI seam every AI surface consumes. M1 hosts
   *  inject the MockProvider; DJA-11F swaps in a real engine. */
  createAIProvider?: () => AIProvider | null;
  /** Resolves the tools the chat may call this turn (MCP servers via the Rust
   *  manager + in-process app tools). Injected by the host so packages/ui stays
   *  free of Tauri. Resolved lazily per send. */
  getAITools?: () => AITool[] | Promise<AITool[]>;
  /** Custom instructions merged into the chat system prompt (omp#1 — e.g. the
   *  workspace's `.markdraw/instructions.md`). Read fresh per send. */
  getCustomInstructions?: () => CustomInstructions | undefined;
  /** Optional host-built skill instructions for the current chat turn. The host
   *  owns filesystem discovery; packages/ui only injects the returned text. */
  getSkillContext?: (request: {
    history: ChatTurn[];
    mode: AIChatMode;
    userMessage: string;
  }) => string | undefined;
  /** Persist a plan produced in Plan mode (the host writes it to
   *  `.markdraw/plans`). Called with the assistant's plan text. */
  onPlanComplete?: (content: string) => void;
  /** Export a chat transcript (the host shows a Save dialog + writes the file). */
  onExportChat?: (payload: { title: string; markdown: string }) => void;
  /** Host Accept/Reject gate for prompt-tier tool calls, enforced by the
   *  engine (ChatOptions.onApprovalRequest) — tools are passed unwrapped. */
  onToolApprovalRequest?: (req: {
    args: unknown;
    signal?: AbortSignal;
    source?: string;
    toolName: string;
  }) => Promise<boolean>;
}

export { FontFamilies, FontSizes };

export function findEntryInTree(entries: FSEntry[], path: string): FSEntry | null {
  for (const entry of entries) {
    if (entry.path === path) return entry;
    if (entry.children) {
      const found = findEntryInTree(entry.children, path);
      if (found) return found;
    }
  }
  return null;
}

/** One ordered right-panel strip tab (an open special pane or a chat session). */
export interface RightPanelTabModel {
  /** "toc" | "backlinks" | chat session id. */
  id: string;
  kind: "toc" | "backlinks" | "chat";
  /** Chat title (empty for specials — the strip derives their label). */
  title: string;
  streaming: boolean;
  pinned: boolean;
  /** Sort key: special.openedAt or chat.createdAt (pinned float left first). */
  orderKey: number;
}

export function effectivePaneEditorMode(pane: PaneStore): "edit" | "split" | "preview" {
  const file = pane.selectedFile();
  const kind = file ? fileKind(file.name) : null;
  if (kind === "image" || kind === "pdf") return "preview";
  const mode = kind === "other" && pane.html() !== UNSUPPORTED_CONTENT ? "edit" : pane.editorMode();
  // Keep the preview's loading/error display available without mounting an
  // editor on a restored tab whose working buffer has not been read yet.
  if (mode !== "preview" && pane.tabs.getActiveTab()?.needsLoad) return "preview";
  return mode;
}

/** Host side of the composer's inline references (a selection chip becomes an
 *  inline "@token" in the chat message). The mounted composer registers a
 *  consumer while it lives; the host hands each request to it directly, so no
 *  effect has to watch a request signal and clear it — that self-write is
 *  Solid's EFFECT_WRITES_OWN_SOURCE. A request made with no mounted composer
 *  (the chat tab was closed when the user hit ⌘I) waits in a pending slot and
 *  the next composer drains it. */
export interface AiInlineReferenceHost {
  /** Register the mounted composer's consumer; returns its unregister. The
   *  consumer answers whether it inserted the token (a detached panel says
   *  no and leaves the request pending for the visible one). */
  register(consumer: (reference: AiInlineReference) => boolean): () => void;
  /** Take the request that arrived while no composer was mounted, if any. */
  takePending(): AiInlineReference | null;
}

export function createAppState(config: AppStateConfig) {
  // ── Pane manager (per-document signals proxy through here) ─────────────
  // Per the split-panes feature plan, every signal that describes
  // "the file being viewed" — html, editorContent, savedContent,
  // frontmatter, editorMode, selectedFile, selectedRootId, loading —
  // lives inside the PaneStore for whichever pane is currently active.
  // AppState exposes proxy getters/setters with the same names so
  // existing consumers (Editor, Preview, file-loader, navigation)
  // don't need to know about panes.
  const paneManager: PaneManager = config.paneManager ?? createPaneManager();

  // ── Core signals ────────────────────────────────────────────────────────

  const html = (): string => paneManager.activePane().html();
  const setHtml = ((value: unknown) =>
    (paneManager.activePane().setHtml as (v: unknown) => unknown)(value)) as Setter<string>;
  const frontmatter = (): Frontmatter | null => paneManager.activePane().frontmatter();
  const setFrontmatter = ((value: unknown) =>
    (paneManager.activePane().setFrontmatter as (v: unknown) => unknown)(value)) as Setter<Frontmatter | null>;
  const [editingPath, setEditingPath] = createSignal<string | null>(null);
  const [creatingAt, setCreatingAt] = createSignal<CreatingAt | null>(null);
  const [moveClipboard, setMoveClipboard] = createSignal<MoveClipboard | null>(null);
  const loading = (): boolean => paneManager.activePane().loading();
  const setLoading = ((value: unknown) =>
    (paneManager.activePane().setLoading as (v: unknown) => unknown)(value)) as Setter<boolean>;
  const [autoRefresh, setAutoRefresh] = createSignal(true);
  const [tocVisible, setTocVisible] = createSignal(true);
  const [tocLevels, setTocLevels] = createSignal(3);
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(
    config.getStoredTheme(),
  );
  const [darkMode, setDarkMode] = createSignal(
    document.documentElement.classList.contains("dark"),
  );

  onSettled(() => {
    applyCodeTheme("github-light", false);
  });

  // ── Font preferences ────────────────────────────────────────────────────

  const [fontPrefs, setFontPrefs] = createSignal<FontPrefs>(
    getStoredFontPrefs(),
  );

  createEffect(
    () => fontPrefs(),
    (prefs) => {
      applyFontPrefs(prefs);
    },
  );

  // ── Recent files ────────────────────────────────────────────────────────

  const [recentFiles, setRecentFiles] = createSignal<RecentFile[]>(
    getRecentFiles(),
  );
  const [recentFolders, setRecentFolders] = createSignal<RecentFolder[]>(
    getRecentFolders(),
  );
  const [favorites, setFavorites] = createSignal<FavoriteFile[]>(
    getFavorites(),
  );

  // ── Editor state ────────────────────────────────────────────────────────

  const editorMode = createMemo(() => effectivePaneEditorMode(paneManager.activePane()));
  const setEditorMode = ((value: unknown) =>
    (paneManager.activePane().setEditorMode as (v: unknown) => unknown)(value)) as Setter<"edit" | "split" | "preview">;
  const editorVisible = () => editorMode() !== "preview";
  const [showLineNumbers, setShowLineNumbers] = createSignal(getStoredLineNumbers());
  const [showInvisibles, setShowInvisibles] = createSignal(getStoredShowInvisibles());
  const [indentMode, setIndentMode] = createSignal<IndentMode>(getStoredIndentMode());
  const [indentSize, setIndentSize] = createSignal(getStoredIndentSize());
  const [editorSearchOpen, setEditorSearchOpen] = createSignal(false);
  const [editorFindTrigger, setEditorFindTrigger] = createSignal(0);
  const [wrapText, setWrapText] = createSignal(getStoredWrapText());
  const [syncScroll, setSyncScroll] = createSignal(getStoredSyncScroll());
  const editorContent = (): string => paneManager.activePane().editorContent();
  const setEditorContent = ((value: unknown) =>
    (paneManager.activePane().setEditorContent as (v: unknown) => unknown)(value)) as Setter<string>;
  const savedContent = (): string => paneManager.activePane().savedContent();
  const setSavedContent = ((value: unknown) =>
    (paneManager.activePane().setSavedContent as (v: unknown) => unknown)(value)) as Setter<string>;

  // ── Workspace roots ─────────────────────────────────────────────────────

  const [roots, setRoots] = createSignal<Map<string, WorkspaceRoot>>(new Map());
  const [rootOrder, setRootOrder] = createSignal<string[]>([]);
  const selectedRootId = (): string | null => paneManager.activePane().selectedRootId();
  const setSelectedRootId = ((value: unknown) =>
    (paneManager.activePane().setSelectedRootId as (v: unknown) => unknown)(value)) as Setter<string | null>;
  const selectedFile = (): FSEntry | null => paneManager.activePane().selectedFile();
  const setSelectedFile = ((value: unknown) =>
    (paneManager.activePane().setSelectedFile as (v: unknown) => unknown)(value)) as Setter<FSEntry | null>;
  const DEFAULT_SIDEBAR_WIDTH = 280;
  const [sidebarWidth, setSidebarWidth] = createSignal(DEFAULT_SIDEBAR_WIDTH);
  const DEFAULT_TOC_WIDTH = 340;
  const [tocWidth, setTocWidth] = createSignal(DEFAULT_TOC_WIDTH);
  const [sidebarVisible, setSidebarVisible] = createSignal(true);
  const [showAllDirs, setShowAllDirs] = createSignal(getStoredShowAllDirs());
  const [showAllFiles, setShowAllFiles] = createSignal(getStoredShowAllFiles());
  const [showHiddenEntries, setShowHiddenEntries] = createSignal(getStoredShowHiddenEntries());
  // Persist via effects rather than in a handler: these setters are
  // toggled from several call sites (app-shell menu, command palette,
  // __DEV__ helpers), and an effect catches every one of them.
  createEffect(() => showAllDirs(), (value) => {
    setStoredShowAllDirs(value);
  });
  createEffect(() => showAllFiles(), (value) => {
    setStoredShowAllFiles(value);
  });
  createEffect(() => showHiddenEntries(), (value) => {
    setStoredShowHiddenEntries(value);
  });
  const [respectGitignore, setRespectGitignore] = createSignal(getStoredRespectGitignore());
  const [closeBehavior, setCloseBehavior] = createSignal<CloseBehavior>(getStoredCloseBehavior());

  // Derived: list of all roots ordered by rootOrder
  const rootsList = () => {
    const order = rootOrder();
    const rootsMap = roots();
    const allRoots = Array.from(rootsMap.values());
    
    if (order.length === 0) return allRoots;
    
    // Create a map for O(1) lookup
    const orderMap = new Map(order.map((id, idx) => [id, idx]));
    
    return allRoots.sort((a, b) => {
      const idxA = orderMap.get(a.id) ?? Infinity;
      const idxB = orderMap.get(b.id) ?? Infinity;
      return idxA - idxB;
    });
  };

  // Derived: active root (where selected file lives)
  const activeRoot = (): WorkspaceRoot | null => {
    const id = selectedRootId();
    return id ? roots().get(id) ?? null : null;
  };

  // Backward-compat: tree of active root
  const tree = () => activeRoot()?.entries ?? [];

  // Backward-compat: name of active root
  const rootName = () => activeRoot()?.name ?? "";

  // ── Navigation state ────────────────────────────────────────────────────

  // Preview heading-target — set when the Workspace Symbol search
  // (or similar cross-file jumps) navigates to a specific heading.
  // Preview's afterSwap walks the rendered article's h1-h6 nodes
  // and scrolls the matching one into view, then the TOC scroll
  // tracker auto-updates the active highlight.
  const [pendingHeadingText, setPendingHeadingText] = createSignal<string | null>(null);
  const [pendingFragment, setPendingFragment] = createSignal<string | null>(
    null,
  );
  type HtmlNavigation = { rootId: string; path: string; fragment: string };
  const [pendingHtmlNavigation, updatePendingHtmlNavigation] = createSignal<Record<string, HtmlNavigation>>({});
  const [appliedHtmlNavigation, updateAppliedHtmlNavigation] = createSignal<Record<string, HtmlNavigation>>({});
  function clearAppliedHtmlNavigation(paneId: string) {
    updateAppliedHtmlNavigation((current) => {
      const next = { ...current };
      delete next[paneId];
      return next;
    });
  }
  function setPendingHtmlNavigation(paneId: string, target: HtmlNavigation | null) {
    updatePendingHtmlNavigation((current) => {
      const next = { ...current };
      if (target) next[paneId] = target;
      else delete next[paneId];
      return next;
    });
    clearAppliedHtmlNavigation(paneId);
  }
  function consumePendingHtmlNavigation(paneId: string, target: HtmlNavigation) {
    updatePendingHtmlNavigation((current) => {
      if (current[paneId] !== target) return current;
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    updateAppliedHtmlNavigation((current) => ({ ...current, [paneId]: target }));
  }
  const [previewSearchOpen, setPreviewSearchOpen] = createSignal(false);
  const [previewFindTrigger, setPreviewFindTrigger] = createSignal(0);
  const [navStack, setNavStack] = createSignal<QualifiedPath[]>([]);
  const [navIndex, setNavIndex] = createSignal(-1);

  // ── Drag-and-drop ──────────────────────────────────────────────────────

  const [dragOver, setDragOver] = createSignal(false);

  // ── Derived signals ─────────────────────────────────────────────────────

  const canGoBack = () => navIndex() > 0;
  const canGoForward = () => navIndex() < navStack().length - 1;
  const hasFile = () => !!selectedFile();
  const [hasToc, setHasToc] = createSignal(false);
  const isDirty = () => editorContent() !== savedContent();
  /** Word count + reading-time pill for the status bar. Counts the
   *  rendered HTML when available (asciidoc `include::` / markdown
   *  transcludes are expanded by then — the user reads the result,
   *  not the literal directive in the source). Falls back to raw
   *  `editorContent` while a load is in flight or for non-preview
   *  formats with no rendered output. */
  const readingMetrics = (): ReadingMetrics => {
    const renderedHtml = html();
    if (renderedHtml) return computeReadingMetricsFromHtml(renderedHtml);
    return computeReadingMetrics(editorContent());
  };
  const readingTimeLabel = (): string => formatReadingTime(readingMetrics().readingTimeMs);
  // Reader / Zen mode — collapses every chrome surface (toolbar,
  // sidebar, TOC, status bar) so only the rendered preview shows.
  // Restored from localStorage so a reload preserves the focus
  // session.
  const [readerMode, setReaderModeSignal] = createSignal<boolean>(getReaderMode());
  function setReaderMode(value: boolean | ((v: boolean) => boolean)): void {
    setReaderModeSignal((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      persistReaderMode(next);
      return next;
    });
  }
  // Backlink index — host (desktop / extension) builds it by reading
  // every workspace file. AppState owns the signal so the right
  // gutter can read incoming-references for the active doc without
  // bothering with rebuild scheduling. Empty Map = "not built yet".
  const [backlinkIndex, setBacklinkIndex] = createSignal<BacklinkIndex>(new Map());
  const activeBacklinks = (): string[] => {
    const f = selectedFile();
    if (!f) return [];
    return findBacklinks(f.path, backlinkIndex());
  };
  /**
   * Whether the currently selected file can be previewed (markdown or
   * asciidoc). Other formats (json, txt, yaml, …) are edit-only.
   */
  /**
   * Which builtin view the selected file opens in. `document` rides the
   * editor/preview pipeline; `image`/`pdf` route to the media viewer
   * (PaneView swaps the whole content area); `other` is edit-only text.
   * Null when no file is selected.
   */
  const viewerKind = () => {
    const f = selectedFile();
    return f ? fileKind(f.name) : null;
  };

  /**
   * Capabilities that drive the edit/split/preview toggle (and the matching
   * command-palette entries — keep the three surfaces in sync). Three tiers:
   *   document (md/adoc)     → edit + preview (split allowed)
   *   html (.html/.htm)      → edit + sandboxed iframe preview (split allowed)
   *   image / pdf / svg      → preview only (the media viewer; not editable)
   *   other text (txt/json…) → edit only (no rendered preview)
   * With no file selected both are false (the toggle is disabled anyway).
   */
  /**
   * The loaded file is a binary the app can neither render nor edit (not an
   * image/PDF, not valid UTF-8 text). The file-loader marks this by writing
   * `UNSUPPORTED_CONTENT` into the pane's `html`; PaneView shows the
   * "unsupported format" notice and both capabilities below go false.
   */
  const isUnsupported = () => html() === UNSUPPORTED_CONTENT;

  const canEdit = () => {
    if (isUnsupported() || paneManager.activePane().tabs.getActiveTab()?.needsLoad) return false;
    const k = viewerKind();
    return k === "document" || k === "html" || k === "other";
  };
  const canPreview = () => {
    if (isUnsupported()) return false;
    const k = viewerKind();
    return k === "document" || k === "html" || k === "image" || k === "pdf";
  };

  // ── System theme listener ───────────────────────────────────────────────

  onSettled(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (config.getStoredTheme() === "system") {
        setDarkMode(document.documentElement.classList.contains("dark"));
      }
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  });

  // ── Handlers ────────────────────────────────────────────────────────────

  function handleThemeChange(mode: string) {
    setThemeMode(mode as ThemeMode);
    config.applyTheme(mode as ThemeMode);
    setDarkMode(document.documentElement.classList.contains("dark"));
  }

  function handleFontPrefsChange(partial: Partial<FontPrefs>) {
    const updated = { ...fontPrefs(), ...partial };
    setFontPrefs(updated);
    setStoredFontPrefs(updated);
  }

  function handleWrapTextChange(enabled: boolean) {
    setWrapText(enabled);
    setStoredWrapText(enabled);
  }

  function handleLineNumbersChange(enabled: boolean) {
    setShowLineNumbers(enabled);
    setStoredLineNumbers(enabled);
  }

  function handleShowInvisiblesChange(enabled: boolean) {
    setShowInvisibles(enabled);
    setStoredShowInvisibles(enabled);
  }

  function handleSyncScrollChange(enabled: boolean) {
    setSyncScroll(enabled);
    setStoredSyncScroll(enabled);
  }

  function handleIndentModeChange(mode: IndentMode) {
    setIndentMode(mode);
    setStoredIndentMode(mode);
  }

  function handleIndentSizeChange(size: number) {
    setIndentSize(size);
    setStoredIndentSize(size);
  }

  function handleRespectGitignoreChange(enabled: boolean) {
    setRespectGitignore(enabled);
    setStoredRespectGitignore(enabled);
  }

  function handleCloseBehaviorChange(value: CloseBehavior) {
    setCloseBehavior(value);
    setStoredCloseBehavior(value);
  }

  function triggerEditorFind() {
    setEditorSearchOpen(true);
    setEditorFindTrigger((value) => value + 1);
  }

  function triggerPreviewFind() {
    setPreviewSearchOpen(true);
    setPreviewFindTrigger((value) => value + 1);
  }

  // ── AI context (chips) ─────────────────────────────────────────────
  // Explicit context the user attaches to the chat (files via the tree menu /
  // drag-and-drop / @mention, or an editor selection). Hybrid model: the ACTIVE
  // document is shown as a chip but read by the `getActiveDoc` tool (not
  // injected — no double tokens); these items carry resolved content that IS
  // injected into the message sent to the model.
  const [aiContextItems, setAiContextItems] = createSignal<AiContextItem[]>([]);
  const [activeFileContextDismissed, setActiveFileContextDismissed] = createSignal(false);

  // The active-document chip (Markdown/AsciiDoc, plus Excalidraw — the chip is
  // label-only and the desktop read tool serves a scene outline for diagrams;
  // images/PDFs stay out since there's nothing textual to read). Re-appears
  // when the user switches files.
  const activeFileContext = createMemo<{ label: string; path: string } | null>(() => {
    if (activeFileContextDismissed()) return null;
    const f = selectedFile();
    const k = f ? fileKind(f.name) : null;
    if (!f || (k !== "document" && k !== "excalidraw")) return null;
    return { label: f.name, path: f.path };
  });
  createEffect(
    () => selectedFile()?.path, // re-show the active-file chip on a file switch
    () => {
      setActiveFileContextDismissed(false);
    },
  );

  function addAiContext(item: AiContextItem): void {
    setAiContextItems((prev) => (prev.some((i) => i.id === item.id) ? prev : [...prev, item]));
  }
  function removeAiContext(id: string): void {
    setAiContextItems((prev) => prev.filter((i) => i.id !== id));
  }
  /** Reorder the context for a send: items whose ID is in `ids` (the
   *  composer's inline tokens — @-mentions and selection references — in
   *  textual order) move to the END in that order; everything else keeps its
   *  relative order, first. The context preamble (buildContextPreamble via
   *  getContext below) injects items in ARRAY order, so this is the order the
   *  model receives the references in. */
  function reorderAiContext(ids: string[]): void {
    setAiContextItems((prev) => {
      const rank = new Map(ids.map((id, i) => [id, i]));
      const rest = prev.filter((item) => !rank.has(item.id));
      const tokened = prev
        .filter((item) => rank.has(item.id))
        .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
      return [...rest, ...tokened];
    });
  }

  // Inline composer references: a selection chip becomes an inline "@token"
  // in the chat composer with the same per-message lifecycle as @-mentions.
  // Handed to the mounted composer explicitly (see AiInlineReferenceHost):
  // a signal the panel watched and then cleared in the same effect re-ran the
  // effect through its own write (EFFECT_WRITES_OWN_SOURCE).
  let aiInlineReferenceSeq = 0;
  /** Requested while no composer was mounted (chat tab closed) — drained by
   *  the next composer that mounts. */
  let pendingAiInlineReference: AiInlineReference | null = null;
  const aiInlineReferenceConsumers = new Set<(reference: AiInlineReference) => boolean>();
  const aiInlineReferenceHost: AiInlineReferenceHost = {
    register(consumer) {
      aiInlineReferenceConsumers.add(consumer);
      return () => {
        aiInlineReferenceConsumers.delete(consumer);
      };
    },
    takePending() {
      const pending = pendingAiInlineReference;
      pendingAiInlineReference = null;
      return pending;
    },
  };
  /** Ask the composer to insert an inline "@token" referencing `itemId`.
   *  `seq` is monotonic so two requests for the same item still read as two.
   *  A consumer that cannot take it (a detached instance) answers false, so
   *  the request stays pending for the connected composer. */
  function requestAiInlineReference(itemId: string, token: string): void {
    aiInlineReferenceSeq += 1;
    const reference: AiInlineReference = { itemId, seq: aiInlineReferenceSeq, token };
    for (const consumer of aiInlineReferenceConsumers) {
      if (consumer(reference)) return;
    }
    pendingAiInlineReference = reference;
  }
  function dismissActiveFileContext(): void {
    setActiveFileContextDismissed(true);
  }

  // Selection popover (Add to chat / Quick Edit) — the editor (CodeMirror
  // offsets) and the rendered preview (a DOM selection over `.doc-body`,
  // tagged `source: "preview"`) both emit the current selection + its screen
  // coords; the AppShell renders a small floating menu fed by whichever
  // source selected last.
  const [selectionPopover, setSelectionPopover] = createSignal<
    | { from: number; to: number; text: string; left: number; bottom: number }
    | { bottom: number; left: number; source: "preview"; text: string }
    | null
  >(null);

  /** Add an editor selection to the chat as a context chip (labelled
   *  file:lines) and request its inline composer token. */
  function addSelectionToContext(sel: { from: number; to: number; text: string }): void {
    if (!sel.text.trim()) return;
    const file = selectedFile();
    const fileName = file?.name ?? "selection";
    const content = editorContent();
    const lineOf = (off: number) => content.slice(0, Math.max(0, off)).split("\n").length;
    const id = `selection:${file?.path ?? ""}:${sel.from}-${sel.to}`;
    const label = `${fileName}:${lineOf(sel.from)}-${lineOf(sel.to)}`;
    addAiContext({
      id,
      kind: "selection",
      label,
      ...(file ? { path: file.path } : {}),
      content: sel.text,
    });
    requestAiInlineReference(id, label);
  }

  /** Add a rendered-preview (DOM) selection to the chat as a context chip and
   *  request its inline composer token. No editor offsets exist for the
   *  rendered article, so the label is a short token-friendly
   *  "<file>:sel"(-N) — the selected text itself lives in `content`. */
  function addPreviewSelectionToContext(text: string): void {
    const flat = text.trim().replace(/\s+/g, " ");
    if (!flat) return;
    const id = `selection:preview:${flat.slice(0, 60)}:${text.length}`;
    // Re-adding the SAME selection keeps its existing label, so the requested
    // token matches the chip instead of deduping against itself.
    const existing = aiContextItems().find((item) => item.id === id);
    const label =
      existing?.label ??
      dedupeTokenLabel(`${selectedFile()?.name ?? "preview"}:sel`, aiContextItems());
    addAiContext({
      id,
      kind: "selection",
      label,
      content: text,
    });
    requestAiInlineReference(id, label);
  }

  /** Attach a resolved file (or folder listing) to the chat as a context chip
   *  — the single canonical channel shared by the composer's @-mention and the
   *  file-tree "Add to chat". Deduped by id via addAiContext; the chip's ×
   *  (removeAiContext) drops the reference. */
  function addFileMention(file: AiMentionContext): void {
    const kind = file.kind ?? "file";
    addAiContext({
      id: `${kind === "folder" ? "folder" : "mention"}:${file.rootId ?? ""}:${file.path ?? ""}`,
      kind,
      label: file.label,
      content: file.content,
      // `!== undefined`, not truthiness: a workspace-root mention has path ""
      // and the chip must still carry it (the panel matches mention items by
      // path+rootId identity, since labels collide across roots).
      ...(file.path !== undefined ? { path: file.path } : {}),
      ...(file.rootId !== undefined ? { rootId: file.rootId } : {}),
      ...(file.rootPath !== undefined ? { rootPath: file.rootPath } : {}),
      ...(file.absolutePath !== undefined ? { absolutePath: file.absolutePath } : {}),
    });
  }

  // Chat mode: "build" (full tools, auto-run), "ask" (full tools, prompt for
  // every tool call), or "plan" (no tools — produce a plan saved to
  // .markdraw/plans).
  const [aiMode, setAiModeSig] = createSignal<AIChatMode>(getStoredAiMode());
  function setAiMode(mode: AIChatMode): void {
    setAiModeSig(mode);
    setStoredAiMode(mode);
  }
  const PLAN_SYSTEM_PROMPT =
    "You are in PLAN mode. Do NOT call tools or modify any files. Using the " +
    "attached context, produce a clear, structured implementation plan in " +
    "Markdown (goal, steps, files to touch, risks). The plan will be saved for " +
    "the user to execute later in Build mode. Output only the plan.";

  /** Build-mode base system prompt — none today (the tool set speaks for
   *  itself); typed so the custom-instructions merge below composes correctly
   *  the day a base is introduced. */
  function buildBaseSystemPrompt(): string | undefined {
    return undefined;
  }

  // ── AI live plan (omp#3) ────────────────────────────────────────────
  // The checklist the model maintains via app__update_plan and the user
  // steers by checking items off. Per-app-session ONLY — deliberately NOT
  // persisted: a plan is a working agreement for the current run of the app,
  // not durable state, so a restart starts clean (no stale checklist).
  const [aiPlan, setAiPlanSig] = createSignal<AiPlanState | null>(null);

  /** Replace the whole plan (host/tool writes). `null` clears it. */
  function setAiPlanItems(items: AiPlanItem[] | null): void {
    setAiPlanSig(
      items === null
        ? null
        : { items: items.map((item) => ({ done: item.done, text: item.text })) },
    );
  }
  /** Flip one item's done flag (user click). Out-of-range indices are ignored. */
  function toggleAiPlanItem(index: number): void {
    setAiPlanSig((prev) => {
      if (!prev || index < 0 || index >= prev.items.length) return prev;
      return {
        items: prev.items.map((item, i) =>
          i === index ? { done: !item.done, text: item.text } : item,
        ),
      };
    });
  }
  /** Drop the plan entirely (the card's × / end of the work). */
  function clearAiPlan(): void {
    setAiPlanSig(null);
  }

  // ── AI assistant ───────────────────────────────────────────────────
  // Multi-chat sidebar: a manager owning N chat-session stores (one per OPEN
  // tab) plus persistent history. The right-panel active tab is an ENCODED
  // string so a chat tab can carry its id: "toc" | "backlinks" | "chat:<id>".
  // Inline actions (DJA-13) and diagram-from-text (DJA-14) keep their own
  // ephemeral store. The provider is injected by the host.
  const aiSessions = createAiChatSessions({
    getProvider: () => config.createAIProvider?.() ?? null,
    // Plan mode runs tool-less and under a planning system prompt; Build mode
    // exposes the full host tool set over an (empty today) base prompt.
    // Custom instructions (omp#1) merge on top, branching explicitly on
    // instructions.mode so the semantics survive a future base prompt.
    system: () => {
      const instructions = config.getCustomInstructions?.();
      if (aiMode() === "plan") {
        // The plan prompt is functional — it encodes the tool-less planning
        // contract — so it is NEVER replaced: instructions append after a
        // blank line regardless of instructions.mode.
        if (!instructions) return PLAN_SYSTEM_PROMPT;
        return `${PLAN_SYSTEM_PROMPT}\n\n${instructions.text}`;
      }
      const base = buildBaseSystemPrompt();
      if (!instructions) return base;
      if (instructions.mode === "replace") return instructions.text;
      return base === undefined ? instructions.text : `${base}\n\n${instructions.text}`;
    },
    getTools: async () => {
      if (aiMode() === "plan") return [];
      const tools = config.getAITools ? await config.getAITools() : [];
      if (aiMode() !== "ask") return tools;
      return tools.map((tool) => ({ ...tool, approval: "prompt" as const }));
    },
    onAssistantTurn: (content) => {
      if (aiMode() === "plan") config.onPlanComplete?.(content);
    },
    getContext: (request) => {
      const items: AiContextItem[] = [];
      // The open document is implicit context (the active-file chip) unless the
      // user dismissed it — include its CURRENT editor content so a plain
      // question about "this document" actually considers it, with no @-mention
      // or tool round-trip needed. This matters most for CLI-subscription chats,
      // which have no Markdraw read tool to fetch it on their own.
      const active = activeFileContext();
      const f = selectedFile();
      // Only text documents dump their content; an Excalidraw scene's chip stays
      // label-only (its raw JSON is noise — the read tool serves an outline).
      if (active && f && fileKind(f.name) === "document") {
        const content = editorContent();
        if (content.trim()) {
          items.push({
            id: `active:${active.path}`,
            kind: "file",
            label: active.label,
            path: active.path,
            ...(selectedRootId() !== null ? { rootId: selectedRootId()! } : {}),
            content,
          });
        }
      }
      // Explicit attachments (selections, @-mentions) follow; skip one that just
      // duplicates the active file by path.
      for (const item of aiContextItems()) {
        if (active && item.kind === "file" && item.path === active.path) continue;
        items.push(item);
      }
      const attachedContext = buildContextPreamble(items);
      const skillContext = config.getSkillContext?.({
        history: request.history,
        mode: aiMode(),
        userMessage: request.userMessage,
      });
      const preamble = [skillContext, attachedContext].filter(Boolean).join("\n\n") || undefined;
      const contextItems = items.map((item) => ({
        id: item.id,
        kind: item.kind,
        label: item.label,
        ...(item.path !== undefined ? { path: item.path } : {}),
        ...(item.rootId !== undefined ? { rootId: item.rootId } : {}),
        ...(item.rootPath !== undefined ? { rootPath: item.rootPath } : {}),
        ...(item.absolutePath !== undefined ? { absolutePath: item.absolutePath } : {}),
      }));
      if (!preamble && contextItems.length === 0) return undefined;
      return {
        ...(preamble ? { preamble } : {}),
        ...(contextItems.length ? { items: contextItems } : {}),
      };
    },
    // Engine-level approval: Ask mode prompts for every tool call. Build mode
    // intentionally omits the gate so calls run automatically.
    ...(config.onToolApprovalRequest
      ? {
          onApprovalRequest: (req) =>
            aiMode() === "ask" ? config.onToolApprovalRequest!(req) : Promise.resolve(true),
        }
      : {}),
  });
  // Restore persisted chats (open tabs + active) on boot, while this owner is
  // live so each rebuilt session store nests under it. Detaching only these
  // init writes keeps them from being mistaken for writes from a component/
  // computation. Solid 2 commits signal writes on the next flush, so reading aiSessions
  // right here would still see its pre-hydrate (empty) state. hydrate reports the
  // live tabs and active id it built, so the boot tab uses those directly instead
  // of re-deriving the sessions manager's open/archived rule here.
  const persistedChats = getChatSessionsIndex() ?? { sessions: [], activeId: null as string | null };
  const { sessions: restoredChats, activeId: restoredActive } = runWithOwner(null, () =>
    aiSessions.hydrate(persistedChats),
  );

  // Inline overlay (DJA-13): floating ⌘I widget on the editor selection.
  const aiInline = createAiInlineStore({
    getProvider: () => config.createAIProvider?.() ?? null,
  });

  // ── Right-panel tabs (specials + chats) ────────────────────────────────────
  // The strip mixes "special" panes (Outline / References — always mounted,
  // opened on demand from the "…" menu) with chat tabs. `aiActiveTab` is the
  // single source of truth for the encoded active tab ("toc" | "backlinks" |
  // "chat:<id>" | ""); specials track open/pinned/openedAt here, chats carry
  // `isPinned` on their session meta. Order: pinned first, then by openedAt /
  // createdAt so the default boot chat stays leftmost.
  type SpecialKind = "toc" | "backlinks";
  const SPECIAL_KINDS: readonly SpecialKind[] = ["toc", "backlinks"];

  const persistedRp = getRightPanelTabsState();
  const [rpSpecials, setRpSpecials] = createSignal<Record<SpecialKind, SpecialTabState>>(
    persistedRp
      ? { toc: persistedRp.toc, backlinks: persistedRp.backlinks }
      : {
          toc: { open: false, pinned: false, openedAt: 0 },
          backlinks: { open: false, pinned: false, openedAt: 0 },
        },
  );

  // Manual drag-and-drop order of ENCODED tab ids. Mirrors the persisted
  // state like the specials do; tabs absent from this list (newly opened)
  // fall back to the orderKey sort, AFTER the manually-ordered ones.
  const [rpOrder, setRpOrder] = createSignal<string[]>(persistedRp?.order ?? []);

  const initialActiveTab = (() => {
    const want = persistedRp?.activeTab ?? "";
    if (want.startsWith("chat:")) {
      if (restoredChats.some((s) => s.id === want.slice(5))) return want;
    } else if (want === "toc" || want === "backlinks") {
      if (rpSpecials()[want].open) return want;
    }
    return restoredActive ? `chat:${restoredActive}` : "";
  })();
  const [aiActiveTab, setActiveTabSig] = createSignal<string>(initialActiveTab);
  const [aiComposerFocusTrigger, setAiComposerFocusTrigger] = createSignal(0);

  // AI-first default: the right panel always boots onto a usable chat. With no
  // open chats and no open specials, create one so the assistant is the first tab.
  // This is boot-time initialization, intentionally outside the component scope.
  runWithOwner(null, () => {
    if (restoredChats.length === 0 && !rpSpecials().toc.open && !rpSpecials().backlinks.open) {
      setActiveTabSig(`chat:${aiSessions.createSession()}`);
    } else if (initialActiveTab === "") {
      const firstChat = restoredChats[0];
      setActiveTabSig(firstChat ? `chat:${firstChat.id}` : rpSpecials().toc.open ? "toc" : "backlinks");
    }
  });

  // Persist the special-tab state + the encoded active tab (chats persist via
  // the sessions manager). Direct write — low frequency, localStorage is cheap.
  createEffect(
    () => ({
      specials: rpSpecials(),
      activeTab: aiActiveTab(),
      order: rpOrder(),
    }),
    ({ specials, activeTab, order }) => {
      setRightPanelTabsState({
        toc: specials.toc,
        backlinks: specials.backlinks,
        activeTab,
        order,
      });
    },
  );

  function patchSpecial(kind: SpecialKind, patch: Partial<SpecialTabState>): void {
    setRpSpecials((s) => ({ ...s, [kind]: { ...s[kind], ...patch } }));
  }

  const encodeTab = (t: { kind: string; id: string }): string =>
    t.kind === "chat" ? `chat:${t.id}` : t.id;

  /** The ordered strip model: open specials + open chats, pinned-first.
   *  Within each group (pinned / unpinned), tabs present in the manual
   *  drag-and-drop order sort by it; the rest (newly opened) keep the
   *  orderKey sort and land AFTER the manually-ordered ones. Stale ids in
   *  the manual list are ignored (no eager cleanup). */
  const rightPanelTabs = createMemo<RightPanelTabModel[]>(() => {
    const specials = rpSpecials();
    const out: RightPanelTabModel[] = [];
    for (const kind of SPECIAL_KINDS) {
      const st = specials[kind];
      if (st.open) out.push({ id: kind, kind, title: "", streaming: false, pinned: st.pinned, orderKey: st.openedAt });
    }
    for (const s of aiSessions.sessions()) {
      out.push({
        id: s.id,
        kind: "chat",
        title: s.title,
        streaming: aiSessions.storeFor(s.id)?.streaming() ?? false,
        pinned: s.isPinned ?? false,
        orderKey: s.createdAt,
      });
    }
    const rank = new Map(rpOrder().map((id, index) => [id, index]));
    const sortGroup = (group: RightPanelTabModel[]): RightPanelTabModel[] => {
      const ranked = group
        .filter((t) => rank.has(encodeTab(t)))
        .sort((a, b) => (rank.get(encodeTab(a)) ?? 0) - (rank.get(encodeTab(b)) ?? 0));
      const rest = group
        .filter((t) => !rank.has(encodeTab(t)))
        .sort((a, b) => a.orderKey - b.orderKey);
      return [...ranked, ...rest];
    };
    return [...sortGroup(out.filter((t) => t.pinned)), ...sortGroup(out.filter((t) => !t.pinned))];
  });

  /** Activate a chat session and front its tab together. */
  function activateChatTab(id: string): void {
    aiSessions.activateSession(id);
    setActiveTabSig(`chat:${id}`);
  }

  /** Open a special pane as a strip tab (if needed) and activate it. */
  function openSpecial(kind: SpecialKind): void {
    if (!rpSpecials()[kind].open) patchSpecial(kind, { open: true, openedAt: Date.now() });
    setActiveTabSig(kind);
  }

  /** Route a right-panel tab selection. Chats activate their session; specials
   *  are opened/fronted; "" clears the active tab. */
  function setAiActiveTab(tab: string): void {
    if (tab.startsWith("chat:")) activateChatTab(tab.slice(5));
    else if (tab === "toc" || tab === "backlinks") openSpecial(tab);
    else setActiveTabSig(tab);
  }

  /** Create a chat, front it, and focus the composer (the `+` button). */
  function newChat(): string {
    const id = aiSessions.createSession();
    setActiveTabSig(`chat:${id}`);
    setAiComposerFocusTrigger((value) => value + 1);
    return id;
  }

  /** Reopen a chat from the history dropdown (un-archives if needed) and front it. */
  function openChatFromHistory(id: string): void {
    aiSessions.openFromHistory(id);
    setActiveTabSig(`chat:${id}`);
  }

  /** Front a chat and pulse the composer-focus trigger (⌘L). Creates a chat if
   *  none is open so ⌘L always lands in a usable composer. */
  function focusAiComposer(): void {
    const cur = aiActiveTab();
    let id = cur.startsWith("chat:") ? cur.slice(5) : aiSessions.activeId();
    if (!id) id = aiSessions.createSession();
    activateChatTab(id);
    setAiComposerFocusTrigger((value) => value + 1);
  }

  function tabPresent(tab: string): boolean {
    if (tab.startsWith("chat:")) return aiSessions.sessions().some((s) => s.id === tab.slice(5));
    if (tab === "toc" || tab === "backlinks") return rpSpecials()[tab].open;
    return false;
  }

  // Keep the encoded active tab valid after a close/archive/delete: prefer the
  // manager's neighbor chat, else any open chat, else an open special, else
  // none. Done imperatively so the tab updates synchronously with the action.
  function reconcileActiveTab(): void {
    // The caller just changed sessions/specials; Solid 2 commits those writes
    // on the next flush, so settle before deciding which tab is still present.
    flush();
    if (tabPresent(aiActiveTab())) return;
    const next = aiSessions.activeId();
    if (next && aiSessions.sessions().some((s) => s.id === next)) {
      setActiveTabSig(`chat:${next}`);
      return;
    }
    const firstChat = aiSessions.sessions()[0];
    if (firstChat) setActiveTabSig(`chat:${firstChat.id}`);
    else if (rpSpecials().toc.open) setActiveTabSig("toc");
    else if (rpSpecials().backlinks.open) setActiveTabSig("backlinks");
    else setActiveTabSig("");
  }

  /** Close a chat tab (keeps it in history) and reconcile the active tab. */
  function closeChat(id: string): void {
    aiSessions.closeSession(id);
    reconcileActiveTab();
  }
  /** Archive a chat (Archived group in history) and reconcile the active tab. */
  function archiveChat(id: string): void {
    aiSessions.archiveSession(id);
    reconcileActiveTab();
  }
  /** Permanently delete a chat and reconcile the active tab. */
  function deleteChat(id: string): void {
    aiSessions.deleteSession(id);
    reconcileActiveTab();
  }
  /** Rename a chat (overrides the auto-derived title). */
  function renameChat(id: string, title: string): void {
    aiSessions.renameSession(id, title);
  }
  /** Duplicate a chat (deep-independent fork) and front the copy. */
  function forkChat(id: string): void {
    const forkId = aiSessions.forkSession(id);
    if (forkId) setActiveTabSig(`chat:${forkId}`);
  }

  /** Close any right-panel tab by encoded id (special → hide its chip but keep
   *  the pane mounted; chat → close to history). */
  function closeRightPanelTab(encoded: string): void {
    if (encoded.startsWith("chat:")) {
      closeChat(encoded.slice(5));
    } else if (encoded === "toc" || encoded === "backlinks") {
      patchSpecial(encoded, { open: false });
      reconcileActiveTab();
    }
  }
  /** Close every unpinned tab except the given one. */
  function closeOtherRightPanelTabs(encoded: string): void {
    for (const t of rightPanelTabs()) {
      if (!t.pinned && encodeTab(t) !== encoded) closeRightPanelTab(encodeTab(t));
    }
  }
  /** Close every unpinned tab to the right of the given one. */
  function closeRightPanelTabsToRight(encoded: string): void {
    const tabs = rightPanelTabs();
    const idx = tabs.findIndex((t) => encodeTab(t) === encoded);
    if (idx < 0) return;
    for (const t of tabs.slice(idx + 1)) if (!t.pinned) closeRightPanelTab(encodeTab(t));
  }
  /** Close every unpinned tab. */
  function closeAllRightPanelTabs(): void {
    for (const t of rightPanelTabs()) if (!t.pinned) closeRightPanelTab(encodeTab(t));
  }

  /** Pin/unpin any right-panel tab by encoded id. */
  function togglePinRightPanelTab(encoded: string): void {
    if (encoded.startsWith("chat:")) {
      const id = encoded.slice(5);
      const m = aiSessions.sessions().find((s) => s.id === id);
      aiSessions.setPinned(id, !(m?.isPinned ?? false));
    } else if (encoded === "toc" || encoded === "backlinks") {
      patchSpecial(encoded, { pinned: !rpSpecials()[encoded].pinned });
    }
  }

  /** Drag-and-drop reorder: reposition `dragged` so it lands where `target`
   *  currently sits (insert-before when moving left, insert-after when moving
   *  right). Cross-group drops clamp to the group boundary — a pinned tab
   *  dragged onto an unpinned target lands at the END of the pinned group and
   *  vice-versa at the START of the unpinned group; pinned status NEVER
   *  changes from a drag. The full resulting sequence (encoded ids) replaces
   *  the manual order and persists. */
  function reorderRightPanelTab(draggedEncodedId: string, targetEncodedId: string): void {
    if (draggedEncodedId === targetEncodedId) return;
    const tabs = rightPanelTabs();
    const ids = tabs.map(encodeTab);
    const from = ids.indexOf(draggedEncodedId);
    const to = ids.indexOf(targetEncodedId);
    if (from < 0 || to < 0) return;
    const draggedPinned = tabs[from]?.pinned ?? false;
    const targetPinned = tabs[to]?.pinned ?? false;
    const next = ids.filter((id) => id !== draggedEncodedId);
    let insertAt: number;
    if (draggedPinned !== targetPinned) {
      // After removing the dragged id, the end of the pinned group and the
      // start of the unpinned group are the same boundary index.
      insertAt = tabs.filter((t) => t.pinned).length - (draggedPinned ? 1 : 0);
    } else {
      const targetIdx = next.indexOf(targetEncodedId);
      insertAt = from < to ? targetIdx + 1 : targetIdx;
    }
    next.splice(insertAt, 0, draggedEncodedId);
    setRpOrder(next);
  }

  /** Export a chat transcript (the host shows a Save dialog + writes the file).
   *  Includes the in-flight streaming turn so exporting mid-stream isn't lossy. */
  function exportChat(id: string): void {
    const store = aiSessions.storeFor(id);
    if (!store) return;
    const meta = aiSessions.allSessions().find((s) => s.id === id);
    const title = meta?.title?.trim() || "Chat";
    const base = store.messages();
    const tools = store.toolActivity();
    const turns =
      store.streaming() && (store.streamingText() || tools.length > 0)
        ? [
            ...base,
            {
              role: "assistant" as const,
              content: store.streamingText(),
              ...(tools.length ? { tools } : {}),
            },
          ]
        : base;
    config.onExportChat?.({ title, markdown: formatChatTranscript(title, turns) });
  }

  /** Selection popover → "Add to chat": chip the selection + front the chat.
   *  Preview-sourced selections (no editor offsets) get the snippet label. */
  function addSelectionContextFromPopover(): void {
    const info = selectionPopover();
    if (!info) return;
    if ("source" in info) addPreviewSelectionToContext(info.text);
    else addSelectionToContext(info);
    setSelectionPopover(null);
    focusAiComposer();
  }

  function handleClearRecentFiles() {
    clearRecentFiles();
    setRecentFiles([]);
  }

  function handleClearRecentFolders() {
    clearRecentFolders();
    setRecentFolders([]);
  }

  function handleClearRecentHistory() {
    handleClearRecentFiles();
    handleClearRecentFolders();
  }

  function handleRemoveRecentFile(path: string, rootPath: string) {
    const updated = removeRecentFile(path, rootPath);
    setRecentFiles(updated);
  }

  function handleRemoveRecentFolder(path: string) {
    const updated = removeRecentFolder(path);
    setRecentFolders(updated);
  }

  function handleToggleFavorite(file: FavoriteFile) {
    if (isFavorite(file.path, file.rootPath, favorites())) {
      setFavorites(removeFavorite(file.path, file.rootPath));
    } else {
      setFavorites(addFavorite(file));
    }
  }

  function getRootFolderName(path: string) {
    const normalizedPath = path.replace(/\\/g, "/");
    const parts = normalizedPath.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? normalizedPath;
  }

  function pushRecentFolder(path: string) {
    const updated = addRecentFolder({
      name: getRootFolderName(path),
      path,
    });
    setRecentFolders(updated);
  }

  // ── Tree utility ────────────────────────────────────────────────────────

  function findEntryByPath(targetPath: string, rootId?: string): FSEntry | null {
    if (rootId) {
      const root = roots().get(rootId);
      return root ? findEntryInTree(root.entries, targetPath) : null;
    }
    // Search all roots
    for (const root of roots().values()) {
      const found = findEntryInTree(root.entries, targetPath);
      if (found) return found;
    }
    return null;
  }

  // ── Tab path rewrites ───────────────────────────────────────────────────

  /**
   * Point every tab whose file lives at (or under) `oldPath` at `newPath`
   * after a rename or move. Every pane is rewritten, background tabs
   * included: the tab content is the same file, only its location changed,
   * so nothing needs a reload — a tab whose first read is still pending picks
   * the new path when it runs. A tab whose rewritten path is already open in
   * the same pane keeps its old path, because `updateTabFile` refuses to
   * create a second tab with the same id (the tabs-are-unique invariant).
   */
  function rewriteTabPaths(rootId: string, oldPath: string, newPath: string): void {
    if (!oldPath || oldPath === newPath) return;
    const prefix = `${oldPath}/`;
    for (const pane of paneManager.panes()) {
      // Snapshot the list: updateTabFile rebuilds it on every rewrite.
      for (const tab of pane.tabs.tabs()) {
        if (tab.rootId !== rootId || !tab.filePath) continue;
        if (tab.filePath !== oldPath && !tab.filePath.startsWith(prefix)) continue;
        const rewritten = tab.filePath === oldPath
          ? newPath
          : `${newPath}${tab.filePath.slice(oldPath.length)}`;
        const active = pane.tabs.activeTabId() === tab.id;
        const source = active && !tab.needsLoad ? pane.editorContent() : tab.editorContent;
        const base = rewritten.includes("/") ? rewritten.slice(0, rewritten.lastIndexOf("/")) : "";
        const includePaths = isMdFile(rewritten)
          ? getMarkdownIncludePaths(source, base)
          : getIncludePaths(source, base);
        const updated = pane.tabs.updateTabFile(tab.id, rewritten, rewritten.slice(rewritten.lastIndexOf("/") + 1), rootId, { includePaths });
        if (updated) {
          rekeyReader(pane, rootId, tab.filePath, rewritten);
          carryEdit(
            { pane, tabId: tab.id, rootId, filePath: tab.filePath },
            { pane, tabId: updated.id, rootId, filePath: rewritten },
          );
        }
        const selected = pane.selectedFile();
        if (updated && active && selected?.path === tab.filePath && pane.selectedRootId() === rootId) {
          pane.setSelectedFile({ ...selected, path: rewritten, name: updated.fileName });
        }
      }
    }
  }

  // ── Navigation history ──────────────────────────────────────────────────

  interface PushNavHistoryParams {
    entry: FSEntry;
    rootId: string;
  }

  interface PushRecentFileParams {
    entry: FSEntry;
    rootName: string;
    rootPath: string;
  }

  function pushNavHistory({ entry, rootId }: PushNavHistoryParams) {
    const stack = navStack().slice(0, navIndex() + 1);
    stack.push({ path: entry.path, rootId });
    setNavStack(stack);
    setNavIndex(stack.length - 1);
  }

  function pushRecentFile({
    entry,
    rootName,
    rootPath,
  }: PushRecentFileParams) {
    const updated = addRecentFile({
      name: entry.name,
      path: entry.path,
      rootName,
      rootPath,
    });
    setRecentFiles(updated);
  }

  // ── Workspace root management ───────────────────────────────────────────

  function addRoot(root: WorkspaceRoot) {
    setRoots((prev) => {
      const next = new Map(prev);
      next.set(root.id, root);
      return next;
    });
    // Add to end of order if new
    setRootOrder((prev) => {
      if (prev.includes(root.id)) return prev;
      return [...prev, root.id];
    });
  }

  function removeRoot(rootId: string) {
    setRoots((prev) => {
      const next = new Map(prev);
      next.delete(rootId);
      return next;
    });
    // Remove from order
    setRootOrder((prev) => prev.filter((id) => id !== rootId));
    if (selectedRootId() === rootId) {
      setSelectedFile(null);
      setSelectedRootId(null);
      setHtml("");
      setFrontmatter(null);
      setEditorContent("");
      setSavedContent("");
      setEditorSearchOpen(false);
      setPreviewSearchOpen(false);
      setEditorMode("preview");
    }
  }

  function reorderRoots(newOrder: string[]) {
    // Filter to only include IDs that exist in roots
    const validIds = newOrder.filter((id) => roots().has(id));
    // Add any new roots not in the order
    for (const [id] of roots()) {
      if (!validIds.includes(id)) {
        validIds.push(id);
      }
    }
    const current = rootOrder();
    if (current.length === validIds.length && current.every((id, idx) => id === validIds[idx])) {
      return;
    }
    setRootOrder(validIds);
  }

  /**
   * Reconcile new entries with existing ones to preserve object references
   * where possible. This prevents SolidJS from recreating FileTreeItem
   * components (and losing expanded state) on directory refresh.
   */
  function reconcileEntries(oldEntries: FSEntry[], newEntries: FSEntry[]): FSEntry[] {
    const oldMap = new Map(oldEntries.map((e) => [e.path, e]));
    let changed = oldEntries.length !== newEntries.length;

    const result = newEntries.map((newEntry) => {
      const old = oldMap.get(newEntry.path);
      if (!old) { changed = true; return newEntry; }
      if (old.kind !== newEntry.kind || old.name !== newEntry.name) { changed = true; return newEntry; }
      // Reconcile children recursively for directories
      if (newEntry.kind === "directory" && newEntry.children && old.children) {
        const reconciledChildren = reconcileEntries(old.children, newEntry.children);
        if (reconciledChildren === old.children) return old;
        changed = true;
        return { ...old, children: reconciledChildren };
      }
      if (newEntry.kind === "directory" && !old.children && newEntry.children) { changed = true; return newEntry; }
      return old;
    });

    return changed ? result : oldEntries;
  }

  function updateRootEntries(rootId: string, entries: FSEntry[]) {
    setRoots((prev) => {
      const next = new Map(prev);
      const existing = next.get(rootId);
      if (!existing) return prev;
      const reconciled = reconcileEntries(existing.entries, entries);
      if (reconciled === existing.entries) return prev;
      next.set(rootId, { ...existing, entries: reconciled });
      return next;
    });
  }

  function toggleRootCollapsed(rootId: string) {
    setRoots((prev) => {
      const next = new Map(prev);
      const existing = next.get(rootId);
      if (existing) next.set(rootId, { ...existing, collapsed: !existing.collapsed });
      return next;
    });
  }

  // Backward-compat wrapper: set tree of active root
  function setTree(entries: FSEntry[]) {
    const id = selectedRootId();
    if (id) updateRootEntries(id, entries);
  }

  // Backward-compat wrapper: set name of active root
  function setRootName(name: string) {
    const id = selectedRootId();
    if (!id) return;
    setRoots((prev) => {
      const next = new Map(prev);
      const existing = next.get(id);
      if (existing) next.set(id, { ...existing, name });
      return next;
    });
  }

  // ── PDF export ──────────────────────────────────────────────────────────

  function handleExportPdf() {
    const wasDark = document.documentElement.classList.contains("dark");
    if (wasDark) document.documentElement.classList.remove("dark");
    void config.printPage?.();
    if (wasDark) document.documentElement.classList.add("dark");
  }

  // ── Sidebar resize ─────────────────────────────────────────────────────

  let resizing = false;
  let rafId = 0;

  function onResizeReset() {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
  }

  function onResizeStart(e: MouseEvent, appRef?: HTMLElement) {
    e.preventDefault();
    resizing = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    appRef?.classList.add("resizing");

    const onMove = (ev: MouseEvent) => {
      if (!resizing) return;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        setSidebarWidth(Math.max(180, Math.min(600, ev.clientX)));
      });
    };

    const onUp = () => {
      resizing = false;
      cancelAnimationFrame(rafId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      appRef?.classList.remove("resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ── Right (TOC / AI) panel resize ──────────────────────────────────────
  // The panel sits on the RIGHT, so width grows as the cursor moves LEFT:
  // width = viewport width − cursor X.

  let tocResizing = false;
  let tocRafId = 0;

  function onTocResizeReset() {
    setTocWidth(DEFAULT_TOC_WIDTH);
  }

  function onTocResizeStart(e: MouseEvent, appRef?: HTMLElement) {
    e.preventDefault();
    tocResizing = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    appRef?.classList.add("resizing");

    const onMove = (ev: MouseEvent) => {
      if (!tocResizing) return;
      cancelAnimationFrame(tocRafId);
      tocRafId = requestAnimationFrame(() => {
        setTocWidth(Math.max(300, Math.min(700, window.innerWidth - ev.clientX)));
      });
    };

    const onUp = () => {
      tocResizing = false;
      cancelAnimationFrame(tocRafId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      appRef?.classList.remove("resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ── Editor panel resize ────────────────────────────────────────────────

  const DEFAULT_EDITOR_WIDTH = 50;
  const [editorWidth, setEditorWidth] = createSignal(DEFAULT_EDITOR_WIDTH);

  let editorResizing = false;
  let editorRafId = 0;

  function onEditorResizeReset() {
    setEditorWidth(DEFAULT_EDITOR_WIDTH);
  }

  function onEditorResizeStart(e: MouseEvent, mainRef?: HTMLElement, appRef?: HTMLElement) {
    e.preventDefault();
    editorResizing = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    appRef?.classList.add("resizing");

    const onMove = (ev: MouseEvent) => {
      if (!editorResizing || !mainRef) return;
      cancelAnimationFrame(editorRafId);
      editorRafId = requestAnimationFrame(() => {
        const editorPanel = mainRef.querySelector<HTMLElement>(".editor-panel");
        const contentPanel = mainRef.querySelector<HTMLElement>(".content");
        if (!editorPanel || !contentPanel) return;
        const left = editorPanel.getBoundingClientRect().left;
        const right = contentPanel.getBoundingClientRect().right;
        const totalWidth = right - left;
        if (totalWidth <= 0) return;
        const pct = ((ev.clientX - left) / totalWidth) * 100;
        setEditorWidth(Math.max(20, Math.min(80, pct)));
      });
    };

    const onUp = () => {
      editorResizing = false;
      cancelAnimationFrame(editorRafId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      appRef?.classList.remove("resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ── Conversion ─────────────────────────────────────────────────────────

  // Include reader (root and cache) per open document. Each load builds its own
  // reader; the preview conversion of an edit must use the one of the tab and
  // pane it converts, not whichever file loaded last (a single global reader
  // sent a second pane's edits through the first pane's root and cache).
  const docReaders = new WeakMap<PaneStore, Map<string, DocReader>>();
  const docKey = (rootId: string | null, filePath: string) => `${rootId ?? ""}\0${filePath}`;

  function registerReader(pane: PaneStore, rootId: string | null, filePath: string, reader: DocReader) {
    let readers = docReaders.get(pane);
    if (!readers) docReaders.set(pane, (readers = new Map()));
    const key = docKey(rootId, filePath);
    readers.delete(key); // re-insert: the last entry is the most recent
    readers.set(key, reader);
    // A closed tab must not keep its include cache alive.
    const shown = new Set(pane.tabs.tabs().map((tab) => docKey(tab.rootId, tab.filePath)));
    shown.add(key);
    for (const k of readers.keys()) if (!shown.has(k)) readers.delete(k);
  }

  function readerFor(pane: PaneStore, rootId: string | null, filePath: string): DocReader | undefined {
    const readers = docReaders.get(pane);
    if (!readers) return undefined;
    const exact = readers.get(docKey(rootId, filePath));
    if (exact) return exact;
    // The tab's file was renamed or moved after it loaded: the cache is keyed
    // by include path, so the last reader of the same root still resolves it.
    const prefix = `${rootId ?? ""}\0`;
    let sameRoot: DocReader | undefined;
    for (const [k, reader] of readers) if (k.startsWith(prefix)) sameRoot = reader;
    return sameRoot;
  }

  /** A tab moved to another pane keeps its reader (root and include cache):
   *  without it the first edit there would convert with no includes. */
  function transferReader(from: PaneStore, to: PaneStore, rootId: string | null, filePath: string) {
    const reader = readerFor(from, rootId, filePath);
    if (!reader || from === to) return;
    registerReader(to, rootId, filePath, reader);
    docReaders.get(from)?.delete(docKey(rootId, filePath));
  }

  /** A loaded file changed path inside its workspace: its reader follows, so
   *  edits keep the include cache and the lookup is by the path now in use. */
  function rekeyReader(pane: PaneStore, rootId: string | null, oldPath: string, newPath: string) {
    const readers = docReaders.get(pane);
    const reader = readers?.get(docKey(rootId, oldPath));
    if (!readers || !reader || oldPath === newPath) return;
    readers.delete(docKey(rootId, oldPath));
    registerReader(pane, rootId, newPath, reader);
  }

  function convertWith(filePath: string, content: string, reader: DocReader): Promise<ConvertResult> {
    const convertOpts = { filePath, fileContent: content, readFile: reader.readFile, readFiles: reader.readFiles };
    return isMdFile(filePath) ? config.convertMarkdown(convertOpts) : config.convertAdoc(convertOpts);
  }

  // Edit conversions: per pane and document at most one conversion runs and one
  // waits (the newest). Every edit takes a generation; only a result of the
  // newest generation, for the document the pane still shows, is published.
  interface EditJob {
    gen: number;
    content: string;
    filePath: string;
    rootId: string | null;
    tabId: string | null;
    fallback: (p: string) => Promise<string | null>;
  }
  interface EditConvert {
    gen: number;
    timer: ReturnType<typeof setTimeout> | undefined;
    running: boolean;
    queued: EditJob | null;
    /** The newest edit, until its conversion was published, failed or dropped:
     *  what a rename or a pane move has to take along to the new identity. */
    pending: EditJob | null;
    /** The text of the newest edit. */
    last: string;
    /** Settles when the document has no conversion running or waiting. */
    idle: Promise<void> | null;
    settle: (() => void) | null;
  }
  const editConverts = new WeakMap<PaneStore, Map<string, EditConvert>>();
  // What each document's preview shows right now, per pane: the text its HTML
  // was converted from, or null when the screen holds an error (or nothing).
  // Every publication to the preview records itself here (an edit conversion,
  // the loader's refresh, the loader's error), and a rename or a pane move
  // carries the record along. The echo of an autosave is skipped only when the
  // record says the saved text is on screen: any other state converts again.
  const published = new WeakMap<PaneStore, Map<string, string | null>>();
  const editKey = (tabId: string | null, rootId: string | null, filePath: string) =>
    `${tabId ?? ""}\0${docKey(rootId, filePath)}`;
  const publishedMap = (pane: PaneStore) => {
    let shown = published.get(pane);
    if (!shown) published.set(pane, (shown = new Map()));
    return shown;
  };
  // The record of a document that has no tab any more (closed, evicted from
  // the closed-tabs history, renamed away) is dropped with it: the text it keeps
  // is a whole document. A rename moves the entry first (`carryEdit`).
  const tabOfKey = (key: string) => key.slice(0, key.indexOf("\0"));
  const prunePublished = (pane: PaneStore, liveTabs: ReadonlySet<string>) => {
    const shown = published.get(pane);
    if (!shown) return;
    for (const key of Array.from(shown.keys())) {
      const tabId = tabOfKey(key);
      if (tabId !== "" && !liveTabs.has(tabId)) shown.delete(key);
    }
  };
  createEffect(
    () => paneManager.panes().map((pane) => [pane, new Set(pane.tabs.tabs().map((tab) => tab.id))] as const),
    (panes) => {
      for (const [pane, liveTabs] of panes) prunePublished(pane, liveTabs);
    },
  );

  const stillShown = (pane: PaneStore, job: EditJob) =>
    pane.tabs.activeTabId() === job.tabId
    && pane.selectedFile()?.path === job.filePath
    && pane.selectedRootId() === job.rootId;

  // The tab of a job that is no longer the one on screen but still exists as a
  // loaded background tab: its snapshot holds the text the job converted.
  const backgroundTab = (pane: PaneStore, job: EditJob) => {
    if (job.tabId === null || pane.tabs.activeTabId() === job.tabId) return undefined;
    const tab = pane.tabs.getTab(job.tabId);
    return tab && !tab.needsLoad && tab.filePath === job.filePath && tab.rootId === job.rootId
      ? tab
      : undefined;
  };

  async function runEditConverts(pane: PaneStore, key: string, doc: EditConvert, first: EditJob) {
    doc.running = true;
    let job: EditJob | null = first;
    while (job) {
      const current: EditJob = job;
      // The tab closed or the pane moved to another file while this waited: a
      // tab that is still open in the background converts too, and its
      // snapshot (not the pane) takes the result, so coming back shows it.
      if (stillShown(pane, current) || backgroundTab(pane, current)) {
        try {
          const shared = readerFor(pane, current.rootId, current.filePath) ?? { readFile: current.fallback };
          // What this conversion asks the reader for (the cache behind it also
          // holds what older versions of the text read).
          const consulted = new Set<string>();
          const reader: DocReader = {
            readFile: (path) => {
              consulted.add(path);
              return shared.readFile(path);
            },
            readFiles: shared.readFiles
              ? (paths) => {
                  for (const path of paths) consulted.add(path);
                  return shared.readFiles!(paths);
                }
              : undefined,
            converted: shared.converted,
          };
          const result = await convertWith(current.filePath, current.content, reader);
          if (current.gen === doc.gen) {
            const converted: ConvertedDoc = { filePath: current.filePath, rootId: current.rootId, tabId: current.tabId };
            if (stillShown(pane, current)) {
              if (pane.editorContent() === current.content) {
                pane.setHtml(result.html);
                pane.setFrontmatter(result.frontmatter);
                publishedMap(pane).set(key, current.content);
                reader.converted?.(pane, current.content, converted, consulted);
              }
            } else {
              const tab = backgroundTab(pane, current);
              if (tab && tab.editorContent === current.content) {
                pane.tabs.updateTabContent(tab.id, { html: result.html, frontmatter: result.frontmatter });
                publishedMap(pane).set(key, current.content);
                reader.converted?.(pane, current.content, converted, consulted);
              }
            }
          }
        } catch (e) {
          // The screen keeps what it showed: the record keeps saying so, and the
          // text that failed is not in it.
          console.error("Failed to convert editor content:", e);
        }
      }
      if (current.gen === doc.gen) doc.pending = null;
      job = doc.queued;
      doc.queued = null;
    }
    doc.running = false;
    if (doc.timer === undefined) {
      editConverts.get(pane)?.delete(key);
      doc.settle?.();
    }
  }

  function scheduleEdit(
    pane: PaneStore,
    rootId: string | null,
    tabId: string | null,
    filePath: string,
    content: string,
    readFile: (p: string) => Promise<string | null>,
  ) {
    const key = editKey(tabId, rootId, filePath);
    let docs = editConverts.get(pane);
    if (!docs) editConverts.set(pane, (docs = new Map()));
    let doc = docs.get(key);
    if (!doc) {
      docs.set(key, (doc = { gen: 0, timer: undefined, running: false, queued: null, pending: null, last: "", idle: null, settle: null }));
    }
    const job: EditJob = { gen: ++doc.gen, content, filePath, rootId, tabId, fallback: readFile };
    doc.pending = job;
    doc.last = content;
    if (!doc.idle) doc.idle = new Promise<void>((resolve) => { doc.settle = resolve; });
    clearTimeout(doc.timer);
    // The waiting job is already outdated: drop it now, or it would start (and
    // hold the queue for a whole conversion) inside the newest debounce window.
    doc.queued = null;
    const target = doc;
    target.timer = setTimeout(() => {
      target.timer = undefined;
      if (target.running) target.queued = job; // replaces an older waiting job
      else void runEditConverts(pane, key, target, job);
    }, 300);
  }

  function debouncedConvert(
    newContent: string,
    filePath: string,
    readFile: (p: string) => Promise<string | null>,
  ) {
    const pane = paneManager.activePane();
    pane.setEditorContent(newContent);
    scheduleEdit(pane, pane.selectedRootId(), pane.tabs.activeTabId(), filePath, newContent, readFile);
  }

  interface EditSite {
    pane: PaneStore;
    tabId: string | null;
    rootId: string | null;
    filePath: string;
  }

  /** The document was renamed or its tab moved to another pane while an edit
   *  still waited for its conversion (or ran): the job is bound to the old
   *  identity and would be dropped, leaving the preview on older text. Retire
   *  it and convert the same text again under the new identity, after the usual
   *  debounce, so the preview follows what the user typed. */
  function carryEdit(from: EditSite, to: EditSite) {
    const oldKey = editKey(from.tabId, from.rootId, from.filePath);
    const newKey = editKey(to.tabId, to.rootId, to.filePath);
    if (from.pane === to.pane && oldKey === newKey) return;
    // The screen shows the same thing under the new identity.
    const shown = publishedMap(from.pane);
    if (shown.has(oldKey)) {
      const record = shown.get(oldKey)!;
      shown.delete(oldKey);
      publishedMap(to.pane).set(newKey, record);
    }
    const doc = editConverts.get(from.pane)?.get(oldKey);
    const job = doc?.pending;
    if (!doc || !job) return;
    doc.gen++; // a conversion still running for the old identity is dropped
    clearTimeout(doc.timer);
    doc.timer = undefined;
    doc.queued = null;
    doc.pending = null;
    if (!doc.running) {
      editConverts.get(from.pane)?.delete(oldKey);
      doc.settle?.();
    }
    scheduleEdit(to.pane, to.rootId, to.tabId, to.filePath, job.content, job.fallback);
  }

  /** True when the HTML on screen was converted from exactly `content`; an
   *  edit conversion of that text still running or waiting is waited for first
   *  (it is not converted twice). False for anything else (an error on screen,
   *  the HTML of another text, nothing published): the caller converts again. */
  async function previewReflects(pane: PaneStore, rootId: string | null, filePath: string, content: string): Promise<boolean> {
    const key = editKey(pane.tabs.activeTabId(), rootId, filePath);
    const doc = editConverts.get(pane)?.get(key);
    if (doc?.idle && doc.last === content) await doc.idle;
    return publishedMap(pane).get(key) === content;
  }

  /** How many documents of the pane have a record of what their preview shows. */
  const publishedPreviews = (pane: PaneStore) => published.get(pane)?.size ?? 0;

  /** The HTML converted from `content` reached the screen outside the edit
   *  path (the loader's refresh). */
  function notePreviewed(pane: PaneStore, rootId: string | null, filePath: string, content: string) {
    publishedMap(pane).set(editKey(pane.tabs.activeTabId(), rootId, filePath), content);
  }

  /** The screen now holds an error, or nothing, instead of a preview (the
   *  loader published an error or cleared the pane for another file). A tab
   *  that was just opened is not the active one yet when the loader starts:
   *  the loader names it. */
  function notePreviewFailed(pane: PaneStore, rootId: string | null, filePath: string, tabId: string | null = pane.tabs.activeTabId()) {
    publishedMap(pane).set(editKey(tabId, rootId, filePath), null);
  }

  async function convert(
    filePath: string,
    content: string,
    readFile: (p: string) => Promise<string | null>,
    readFiles?: ReadFiles,
  ): Promise<ConvertResult> {
    return await convertWith(filePath, content, { readFile, readFiles });
  }

  // ── State reset ────────────────────────────────────────────────────────

  function clearToc(ref?: HTMLElement) {
    if (ref) ref.textContent = "";
  }

  function resetState(tocPanelRef?: HTMLElement) {
    setSelectedFile(null);
    setSelectedRootId(null);
    setRoots(new Map());
    setRootOrder([]);
    setHtml("");
    setFrontmatter(null);
    setEditorContent("");
    setSavedContent("");
    setEditorSearchOpen(false);
    setPreviewSearchOpen(false);
    setEditorMode("preview");
    clearToc(tocPanelRef);
    setNavStack([]);
    setNavIndex(-1);
  }

  // ── Return ──────────────────────────────────────────────────────────────

  return {
    // Pane manager — exposed so the layout (AppShell) can render
    // PaneView per pane and the host (app.tsx) can wire shortcuts
    // to splitFromActive / setActivePane.
    paneManager,

    // AI assistant — multi-chat session manager + encoded right-panel tab
    aiSessions,
    aiInline,
    aiMode,
    setAiMode,
    // AI live plan (per-app-session, not persisted)
    aiPlan,
    setAiPlanItems,
    toggleAiPlanItem,
    clearAiPlan,
    aiActiveTab,
    setAiActiveTab,
    activateChatTab,
    newChat,
    openChatFromHistory,
    closeChat,
    archiveChat,
    deleteChat,
    renameChat,
    forkChat,
    exportChat,
    // Right-panel tab strip (specials + chats)
    rightPanelTabs,
    openSpecial,
    closeRightPanelTab,
    closeOtherRightPanelTabs,
    closeRightPanelTabsToRight,
    closeAllRightPanelTabs,
    togglePinRightPanelTab,
    reorderRightPanelTab,
    // AI context chips
    aiContextItems,
    activeFileContext,
    addAiContext,
    removeAiContext,
    reorderAiContext,
    aiInlineReferenceHost,
    requestAiInlineReference,
    dismissActiveFileContext,
    addSelectionToContext,
    addPreviewSelectionToContext,
    addFileMention,
    selectionPopover,
    setSelectionPopover,
    addSelectionContextFromPopover,
    aiComposerFocusTrigger,
    setAiComposerFocusTrigger,
    focusAiComposer,

    // Signals (getter + setter)
    autoRefresh,
    darkMode,
    dragOver,
    editorContent,
    editorFindTrigger,
    editorMode,
    editorSearchOpen,
    editorVisible,
    editorWidth,
    fontPrefs,
    html,
    frontmatter,
    editingPath,
    creatingAt,
    moveClipboard,
    loading,
    navIndex,
    navStack,
    pendingFragment,
    pendingHtmlNavigation,
    appliedHtmlNavigation,
    pendingHeadingText,
    setPendingHeadingText,
    previewSearchOpen,
    previewFindTrigger,
    favorites,
    recentFiles,
    recentFolders,
    indentMode,
    indentSize,
    rootOrder,
    roots,
    rootsList,
    activeRoot,
    rootName,
    savedContent,
    selectedFile,
    selectedRootId,
    showInvisibles,
    showLineNumbers,
    syncScroll,
    showAllDirs,
    showAllFiles,
    showHiddenEntries,
    respectGitignore,
    closeBehavior,
    sidebarVisible,
    sidebarWidth,
    themeMode,
    tocVisible,
    tocWidth,
    tocLevels,
    tree,
    wrapText,
    setAutoRefresh,
    setDarkMode,
    setDragOver,
    setEditorContent,
    setEditorFindTrigger,
    setEditorMode,
    setEditorSearchOpen,
    setEditorWidth,
    setFontPrefs,
    setHasToc,
    setHtml,
    setFrontmatter,
    setEditingPath,
    setCreatingAt,
    setMoveClipboard,
    setLoading,
    setNavIndex,
    setNavStack,
    setPendingFragment,
    setPendingHtmlNavigation,
    consumePendingHtmlNavigation,
    clearAppliedHtmlNavigation,
    setPreviewSearchOpen,
    setPreviewFindTrigger,
    setRecentFiles,
    setRecentFolders,
    setIndentMode,
    setIndentSize,
    setRootName,
    setRootOrder,
    setRoots,
    setSavedContent,
    setSelectedFile,
    setSelectedRootId,
    setShowInvisibles,
    setShowLineNumbers,
    setSyncScroll,
    setShowAllDirs,
    setShowAllFiles,
    setShowHiddenEntries,
    setRespectGitignore,
    setCloseBehavior,
    setSidebarVisible,
    setSidebarWidth,
    setThemeMode,
    setTocVisible,
    setTocLevels,
    setTree,
    setWrapText,

    // Derived signals
    canGoBack,
    canGoForward,
    hasFile,
    hasToc,
    isDirty,
    viewerKind,
    canEdit,
    canPreview,
    readingMetrics,
    readingTimeLabel,
    readerMode,
    setReaderMode,
    backlinkIndex,
    setBacklinkIndex,
    activeBacklinks,

    // Handlers
    addRoot,
    clearToc,
    convert,
    debouncedConvert,
    registerReader,
    transferReader,
    rekeyReader,
    carryEdit,
    previewReflects,
    notePreviewed,
    notePreviewFailed,
    publishedPreviews,
    findEntryByPath,
    handleClearRecentFiles,
    handleClearRecentFolders,
    handleClearRecentHistory,
    handleToggleFavorite,
    handleExportPdf,
    handleFontPrefsChange,
    handleIndentModeChange,
    handleIndentSizeChange,
    handleLineNumbersChange,
    handleRemoveRecentFile,
    handleRemoveRecentFolder,
    handleShowInvisiblesChange,
    handleSyncScrollChange,
    handleRespectGitignoreChange,
    handleCloseBehaviorChange,
    handleThemeChange,
    handleWrapTextChange,
    onEditorResizeReset,
    onEditorResizeStart,
    onResizeReset,
    onResizeStart,
    onTocResizeReset,
    onTocResizeStart,
    pushNavHistory,
    rewriteTabPaths,
    pushRecentFile,
    pushRecentFolder,
    removeRoot,
    reorderRoots,
    resetState,
    triggerEditorFind,
    triggerPreviewFind,
    toggleRootCollapsed,
    updateRootEntries,

    // Constants (for AppShell convenience)
    FontFamilies,
    FontSizes,

    // Fallback reader for editor re-conversion when no document registered its
    // own (`registerReader`); the loader no longer assigns it, because one
    // global reader served whichever file loaded last, in whatever pane.
    _readFile: null as ((path: string) => Promise<string | null>) | null,
  };
}

export type AppState = ReturnType<typeof createAppState>;
