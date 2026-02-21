import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import type { ConvertOptions } from "@asciimark/core/converter.ts";
import {
  CodeThemes,
  applyCodeTheme,
  getStoredCodeTheme,
  setStoredCodeTheme,
} from "@asciimark/core/code-theme.ts";
import {
  type RecentFile,
  addRecentFile,
  clearRecentFiles,
  getRecentFiles,
} from "@asciimark/core/recent-files.ts";
import {
  type FontPrefs,
  FontFamilies,
  FontSizes,
  applyFontPrefs,
  getStoredFontPrefs,
  setStoredFontPrefs,
} from "@asciimark/core/font-prefs.ts";
import { isMdFile } from "@asciimark/core/utils.ts";

export type ThemeMode = "system" | "light" | "dark";

interface AppStateConfig {
  applyTheme: (mode: ThemeMode) => void;
  convertAdoc: (opts: ConvertOptions) => Promise<string>;
  convertMarkdown: (opts: ConvertOptions) => Promise<string>;
  getStoredTheme: () => ThemeMode;
}

export { CodeThemes, FontFamilies, FontSizes };

export function createAppState(config: AppStateConfig) {
  // ── Core signals ────────────────────────────────────────────────────────

  const [html, setHtml] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [autoRefresh, setAutoRefresh] = createSignal(true);
  const [tocVisible, setTocVisible] = createSignal(true);
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(
    config.getStoredTheme(),
  );
  const [darkMode, setDarkMode] = createSignal(
    document.documentElement.classList.contains("dark"),
  );

  // ── Code theme ──────────────────────────────────────────────────────────

  const [codeTheme, setCodeTheme] = createSignal(getStoredCodeTheme());

  createEffect(() => {
    applyCodeTheme(codeTheme(), darkMode());
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

  // ── Editor state ────────────────────────────────────────────────────────

  const [editorMode, setEditorMode] = createSignal<"edit" | "split" | "preview">("preview");
  const editorVisible = () => editorMode() !== "preview";
  const [editorContent, setEditorContent] = createSignal("");
  const [savedContent, setSavedContent] = createSignal("");

  // ── Tree / sidebar state ────────────────────────────────────────────────

  const [tree, setTree] = createSignal<FSEntry[]>([]);
  const [selectedFile, setSelectedFile] = createSignal<FSEntry | null>(null);
  const DEFAULT_SIDEBAR_WIDTH = 280;
  const [sidebarWidth, setSidebarWidth] = createSignal(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarVisible, setSidebarVisible] = createSignal(true);
  const [rootName, setRootName] = createSignal("");

  // ── Navigation state ────────────────────────────────────────────────────

  const [pendingFragment, setPendingFragment] = createSignal<string | null>(
    null,
  );
  const [navStack, setNavStack] = createSignal<string[]>([]);
  const [navIndex, setNavIndex] = createSignal(-1);

  // ── Drag-and-drop ──────────────────────────────────────────────────────

  const [dragOver, setDragOver] = createSignal(false);

  // ── Derived signals ─────────────────────────────────────────────────────

  const canGoBack = () => navIndex() > 0;
  const canGoForward = () => navIndex() < navStack().length - 1;
  const hasFile = () => !!selectedFile();
  const [hasToc, setHasToc] = createSignal(false);
  const isDirty = () => editorContent() !== savedContent();

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

  function handleCodeThemeChange(id: string) {
    setCodeTheme(id);
    setStoredCodeTheme(id);
  }

  function handleFontPrefsChange(partial: Partial<FontPrefs>) {
    const updated = { ...fontPrefs(), ...partial };
    setFontPrefs(updated);
    setStoredFontPrefs(updated);
  }

  function handleClearRecent() {
    clearRecentFiles();
    setRecentFiles([]);
  }

  // ── Tree utility ────────────────────────────────────────────────────────

  function findEntryByPath(targetPath: string): FSEntry | null {
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
    return find(tree(), targetPath);
  }

  // ── Recent file opener (needs a loadFile callback from the app) ─────────

  function createHandleOpenRecent(loadFile: (entry: FSEntry) => void) {
    return (path: string) => {
      const entry = findEntryByPath(path);
      if (entry && entry.kind === "file") {
        loadFile(entry);
      }
    };
  }

  // ── Navigation history ──────────────────────────────────────────────────

  function pushNavHistory(entry: FSEntry, rName: string) {
    const stack = navStack().slice(0, navIndex() + 1);
    stack.push(entry.path);
    setNavStack(stack);
    setNavIndex(stack.length - 1);
    const updated = addRecentFile({
      name: entry.name,
      path: entry.path,
      rootName: rName,
    });
    setRecentFiles(updated);
  }

  // ── PDF export ──────────────────────────────────────────────────────────

  function handleExportPdf(tocPanelRef?: HTMLElement) {
    const wasHidden = tocPanelRef?.classList.contains("toc-hidden");
    if (wasHidden) tocPanelRef!.classList.remove("toc-hidden");
    window.print();
    if (wasHidden) tocPanelRef!.classList.add("toc-hidden");
  }

  async function handleDownloadPdf() {
    const element = document.querySelector<HTMLElement>(".doc-body");
    if (!element) return;
    const { default: html2pdf } = await import("html2pdf.js");
    const filename =
      selectedFile()?.name?.replace(/\.(adoc|md)$/, ".pdf") ?? "document.pdf";
    html2pdf()
      .set({
        margin: [15, 15],
        filename,
        html2canvas: { scale: 2 },
        jsPDF: { format: "a4" },
      })
      .from(element)
      .save();
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
        setHtml(result);
      } catch (e) {
        console.error("Failed to convert editor content:", e);
      }
    }, 300);
  }

  async function convert(
    filePath: string,
    content: string,
    readFile: (p: string) => Promise<string | null>,
  ): Promise<string> {
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
    setHtml("");
    setEditorContent("");
    setSavedContent("");
    setEditorMode("preview");
    clearToc(tocPanelRef);
    setNavStack([]);
    setNavIndex(-1);
  }

  // ── Return ──────────────────────────────────────────────────────────────

  return {
    // Signals (getter + setter)
    autoRefresh,
    codeTheme,
    darkMode,
    dragOver,
    editorContent,
    editorMode,
    editorVisible,
    editorWidth,
    fontPrefs,
    html,
    loading,
    navIndex,
    navStack,
    pendingFragment,
    recentFiles,
    rootName,
    savedContent,
    selectedFile,
    sidebarVisible,
    sidebarWidth,
    themeMode,
    tocVisible,
    tree,
    setAutoRefresh,
    setCodeTheme,
    setDarkMode,
    setDragOver,
    setEditorContent,
    setEditorMode,
    setEditorWidth,
    setFontPrefs,
    setHasToc,
    setHtml,
    setLoading,
    setNavIndex,
    setNavStack,
    setPendingFragment,
    setRecentFiles,
    setRootName,
    setSavedContent,
    setSelectedFile,
    setSidebarVisible,
    setSidebarWidth,
    setThemeMode,
    setTocVisible,
    setTree,

    // Derived signals
    canGoBack,
    canGoForward,
    hasFile,
    hasToc,
    isDirty,

    // Handlers
    clearToc,
    convert,
    createHandleOpenRecent,
    debouncedConvert,
    findEntryByPath,
    handleClearRecent,
    handleCodeThemeChange,
    handleDownloadPdf,
    handleExportPdf,
    handleFontPrefsChange,
    handleThemeChange,
    onEditorResizeReset,
    onEditorResizeStart,
    onResizeReset,
    onResizeStart,
    pushNavHistory,
    resetState,

    // Constants (for AppShell convenience)
    CodeThemes,
    FontFamilies,
    FontSizes,

    // Platform-assigned readFile for editor re-conversion
    _readFile: null as ((path: string) => Promise<string | null>) | null,
  };
}

export type AppState = ReturnType<typeof createAppState>;
