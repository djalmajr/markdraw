import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Setter,
} from "solid-js";
import type { FSEntry, QualifiedPath, WorkspaceRoot } from "@asciimark/core/types.ts";
import { createPaneManager, type PaneManager } from "./create-pane-manager.ts";
import { createAiChatSessions } from "./create-ai-chat-sessions.ts";
import { createAiInlineStore } from "./create-ai-inline-store.ts";
import { type AiContextItem, buildContextPreamble } from "./ai-context.ts";
import { getChatSessionsIndex } from "@asciimark/core/ai-chat-sessions.ts";
import type { AIProvider, AITool } from "@asciimark/ai/types.ts";
import type { ConvertOptions, ConvertResult } from "@asciimark/core/converter.ts";
import type { Frontmatter } from "@asciimark/core/frontmatter.ts";
import {
  applyCodeTheme,
} from "@asciimark/core/code-theme.ts";
import {
  computeReadingMetrics,
  computeReadingMetricsFromHtml,
  formatReadingTime,
  type ReadingMetrics,
} from "@asciimark/core/reading-metrics.ts";
import {
  getReaderMode,
  setReaderMode as persistReaderMode,
} from "@asciimark/core/reader-mode.ts";
import {
  type BacklinkIndex,
  findBacklinks,
} from "@asciimark/core/backlinks.ts";
import {
  type RecentFile,
  addRecentFile,
  clearRecentFiles,
  getRecentFiles,
  removeRecentFile,
} from "@asciimark/core/recent-files.ts";
import {
  type RecentFolder,
  addRecentFolder,
  clearRecentFolders,
  getRecentFolders,
  removeRecentFolder,
} from "@asciimark/core/recent-folders.ts";
import {
  type FontPrefs,
  FontFamilies,
  FontSizes,
  applyFontPrefs,
  getStoredFontPrefs,
  setStoredFontPrefs,
} from "@asciimark/core/font-prefs.ts";
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
} from "@asciimark/core/editor-prefs.ts";
import {
  getStoredRespectGitignore,
  setStoredRespectGitignore,
} from "@asciimark/core/file-tree-prefs.ts";
import {
  type CloseBehavior,
  getStoredCloseBehavior,
  setStoredCloseBehavior,
} from "@asciimark/core/window-prefs.ts";
import {
  type FavoriteFile,
  addFavorite,
  getFavorites,
  isFavorite,
  removeFavorite,
} from "@asciimark/core/favorites.ts";
import { fileKind, isMdFile, UNSUPPORTED_CONTENT } from "@asciimark/core/utils.ts";

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
}

export { FontFamilies, FontSizes };

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

  createEffect(() => {
    applyCodeTheme("github-light", false);
  });

  // ── Font preferences ────────────────────────────────────────────────────

  const [fontPrefs, setFontPrefs] = createSignal<FontPrefs>(
    getStoredFontPrefs(),
  );

  createEffect(() => {
    applyFontPrefs(fontPrefs());
  });

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

  const editorMode = (): "edit" | "split" | "preview" => paneManager.activePane().editorMode();
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
  const [showAllDirs, setShowAllDirs] = createSignal(false);
  const [showAllFiles, setShowAllFiles] = createSignal(false);
  const [showHiddenEntries, setShowHiddenEntries] = createSignal(false);
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
    if (isUnsupported()) return false;
    const k = viewerKind();
    return k === "document" || k === "other";
  };
  const canPreview = () => {
    if (isUnsupported()) return false;
    const k = viewerKind();
    return k === "document" || k === "image" || k === "pdf";
  };

  // Force the mode that matches the file's capabilities. Media (image/pdf/
  // svg) is preview-only — the viewer ignores editorMode, but forcing
  // "preview" keeps the toggle's active state honest. Non-previewable text
  // is edit-only. Documents (and unsupported binaries, which show their own
  // notice) are left wherever the user put them.
  createEffect(() => {
    const k = viewerKind();
    if ((k === "image" || k === "pdf") && editorMode() !== "preview") {
      setEditorMode("preview");
    } else if (k === "other" && !isUnsupported() && editorMode() !== "edit") {
      setEditorMode("edit");
    }
  });

  // ── System theme listener ───────────────────────────────────────────────

  onMount(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (config.getStoredTheme() === "system") {
        setDarkMode(document.documentElement.classList.contains("dark"));
      }
    };
    mql.addEventListener("change", handler);
    onCleanup(() => mql.removeEventListener("change", handler));
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

  // The active-document chip (Markdown/AsciiDoc only — a drawing/image isn't
  // useful as text context). Re-appears when the user switches files.
  const activeFileContext = createMemo<{ label: string; path: string } | null>(() => {
    if (activeFileContextDismissed()) return null;
    const f = selectedFile();
    if (!f || fileKind(f.name) !== "document") return null;
    return { label: f.name, path: f.path };
  });
  createEffect(() => {
    selectedFile()?.path; // re-show the active-file chip on a file switch
    setActiveFileContextDismissed(false);
  });

  function addAiContext(item: AiContextItem): void {
    setAiContextItems((prev) => (prev.some((i) => i.id === item.id) ? prev : [...prev, item]));
  }
  function removeAiContext(id: string): void {
    setAiContextItems((prev) => prev.filter((i) => i.id !== id));
  }
  function dismissActiveFileContext(): void {
    setActiveFileContextDismissed(true);
  }

  // Selection popover (Add to chat / Quick Edit) — the editor emits the current
  // selection + its screen coords; the AppShell renders a small floating menu.
  const [selectionPopover, setSelectionPopover] = createSignal<{
    from: number;
    to: number;
    text: string;
    left: number;
    bottom: number;
  } | null>(null);

  /** Add an editor selection to the chat as a context chip (labelled file:lines). */
  function addSelectionToContext(sel: { from: number; to: number; text: string }): void {
    if (!sel.text.trim()) return;
    const file = selectedFile();
    const fileName = file?.name ?? "selection";
    const content = editorContent();
    const lineOf = (off: number) => content.slice(0, Math.max(0, off)).split("\n").length;
    addAiContext({
      id: `selection:${file?.path ?? ""}:${sel.from}-${sel.to}`,
      kind: "selection",
      label: `${fileName}:${lineOf(sel.from)}-${lineOf(sel.to)}`,
      ...(file ? { path: file.path } : {}),
      content: sel.text,
    });
  }

  // ── AI assistant ───────────────────────────────────────────────────
  // Multi-chat sidebar: a manager owning N chat-session stores (one per OPEN
  // tab) plus persistent history. The right-panel active tab is an ENCODED
  // string so a chat tab can carry its id: "toc" | "backlinks" | "chat:<id>".
  // Inline actions (DJA-13) and diagram-from-text (DJA-14) keep their own
  // ephemeral store. The provider is injected by the host.
  const aiSessions = createAiChatSessions({
    getProvider: () => config.createAIProvider?.() ?? null,
    ...(config.getAITools ? { getTools: config.getAITools } : {}),
    getContext: () => buildContextPreamble(aiContextItems()),
  });
  // Restore persisted chats (open tabs + active) on boot, while this owner is
  // live so each rebuilt session store nests under it.
  aiSessions.hydrate(getChatSessionsIndex() ?? { sessions: [], activeId: null });

  // Inline overlay (DJA-13): floating ⌘I widget on the editor selection.
  const aiInline = createAiInlineStore({
    getProvider: () => config.createAIProvider?.() ?? null,
  });

  const restoredActive = aiSessions.activeId();
  const [aiActiveTab, setActiveTabSig] = createSignal<string>(
    restoredActive ? `chat:${restoredActive}` : "toc",
  );
  const [aiComposerFocusTrigger, setAiComposerFocusTrigger] = createSignal(0);

  /** Activate a chat session and front its tab together. */
  function activateChatTab(id: string): void {
    aiSessions.activateSession(id);
    setActiveTabSig(`chat:${id}`);
  }

  /** Route a right-panel tab selection from the strip. Chat tabs also activate
   *  their session so `activeStore()` follows. */
  function setAiActiveTab(tab: string): void {
    if (tab.startsWith("chat:")) {
      activateChatTab(tab.slice(5));
      return;
    }
    setActiveTabSig(tab);
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

  // Keep the encoded tab consistent with the manager: when the active chat tab
  // leaves `sessions()` (closed/archived/deleted) follow the manager's new
  // active id (a neighbor) or fall back to the always-present TOC tab. Done
  // imperatively (not via an effect) so the tab updates synchronously with the
  // action. Eviction never removes the active session, so close/archive/delete
  // are the only paths that need this.
  function reconcileActiveTab(): void {
    const tab = aiActiveTab();
    if (!tab.startsWith("chat:")) return;
    const id = tab.slice(5);
    if (aiSessions.sessions().some((s) => s.id === id)) return;
    const next = aiSessions.activeId();
    setActiveTabSig(next ? `chat:${next}` : "toc");
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

  /** Selection popover → "Add to chat": chip the selection + front the chat. */
  function addSelectionContextFromPopover(): void {
    const info = selectionPopover();
    if (!info) return;
    addSelectionToContext(info);
    setSelectionPopover(null);
    focusAiComposer();
  }

  /** Selection popover → "Quick Edit": open the inline (⌘I) overlay on the selection. */
  function quickEditFromPopover(): void {
    const info = selectionPopover();
    if (!info) return;
    const api = (
      paneManager.activePane() as {
        editorApi?: {
          coordsAtPos: (p: number) => { left: number; top: number; bottom: number } | null;
          replaceRange: (from: number, to: number, insert: string) => void;
        };
      }
    ).editorApi;
    if (!api) return;
    aiInline.openFor(
      { from: info.from, to: info.to, text: info.text },
      api.coordsAtPos(info.to),
      api.replaceRange,
    );
    setSelectionPopover(null);
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
    function find(entries: FSEntry[], tp: string): FSEntry | null {
      for (const entry of entries) {
        if (entry.path === tp) return entry;
        if (entry.children) {
          const found = find(entry.children, tp);
          if (found) return found;
        }
      }
      return null;
    }
    if (rootId) {
      const root = roots().get(rootId);
      return root ? find(root.entries, targetPath) : null;
    }
    // Search all roots
    for (const root of roots().values()) {
      const found = find(root.entries, targetPath);
      if (found) return found;
    }
    return null;
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
        setTocWidth(Math.max(200, Math.min(700, window.innerWidth - ev.clientX)));
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

  let editorConvertTimer: ReturnType<typeof setTimeout> | undefined;

  function debouncedConvert(
    newContent: string,
    filePath: string,
    readFile: (p: string) => Promise<string | null>,
  ) {
    setEditorContent(newContent);
    clearTimeout(editorConvertTimer);
    editorConvertTimer = setTimeout(async () => {
      try {
        const convertOpts = { filePath, fileContent: newContent, readFile };
        const result = isMdFile(filePath)
          ? await config.convertMarkdown(convertOpts)
          : await config.convertAdoc(convertOpts);
        setHtml(result.html);
        setFrontmatter(result.frontmatter);
      } catch (e) {
        console.error("Failed to convert editor content:", e);
      }
    }, 300);
  }

  async function convert(
    filePath: string,
    content: string,
    readFile: (p: string) => Promise<string | null>,
  ): Promise<ConvertResult> {
    const convertOpts = { filePath, fileContent: content, readFile };
    return isMdFile(filePath)
      ? await config.convertMarkdown(convertOpts)
      : await config.convertAdoc(convertOpts);
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
    aiActiveTab,
    setAiActiveTab,
    activateChatTab,
    newChat,
    openChatFromHistory,
    closeChat,
    archiveChat,
    deleteChat,
    // AI context chips
    aiContextItems,
    activeFileContext,
    addAiContext,
    removeAiContext,
    dismissActiveFileContext,
    addSelectionToContext,
    selectionPopover,
    setSelectionPopover,
    addSelectionContextFromPopover,
    quickEditFromPopover,
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

    // Platform-assigned readFile for editor re-conversion
    _readFile: null as ((path: string) => Promise<string | null>) | null,
  };
}

export type AppState = ReturnType<typeof createAppState>;
