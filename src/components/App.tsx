import { createSignal, createEffect, onCleanup, onMount, Show } from "solid-js";
import {
  openDirectory,
  openDirectoryFallback,
  buildTreeFromFiles,
  buildFileMap,
  readTree,
  readFileContent,
  readFileByPath,
  readFileByPathFallback,
  resolveFileByPath,
  saveDirectoryHandle,
  loadDirectoryHandle,
  hasNativePicker,
  type FSEntry,
} from "../lib/fs.ts";
import {
  fetchFileByUrl,
  dirOfUrl,
  fileNameFromUrl,
  resolveUrl,
  displayPathFromUrl,
  isFileUrl,
  createUrlReadFile,
} from "../lib/url-source.ts";
import { convertAdoc, getIncludePaths } from "../lib/asciidoc.ts";
import { convertMarkdown, getMarkdownIncludePaths } from "../lib/markdown.ts";
import { isMdFile, isSupportedFile } from "../lib/utils.ts";
import { FileWatcher } from "../lib/watcher.ts";
import { Toolbar } from "./Toolbar.tsx";
import { FileTree } from "./FileTree.tsx";
import { Preview } from "./Preview.tsx";
import { Editor } from "./Editor.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { FileAccessWarning } from "./FileAccessWarning.tsx";
import { getStoredTheme, applyTheme, type ThemeMode } from "../newtab.tsx";
import {
  CodeThemes,
  applyCodeTheme,
  getStoredCodeTheme,
  setStoredCodeTheme,
} from "../lib/code-theme.ts";
import {
  type RecentFile,
  addRecentFile,
  getRecentFiles,
  clearRecentFiles,
} from "../lib/recent-files.ts";
import {
  type FontPrefs,
  FontFamilies,
  FontSizes,
  applyFontPrefs,
  getStoredFontPrefs,
  setStoredFontPrefs,
} from "../lib/font-prefs.ts";

// --- URL Mode helpers ---

/** Get the ?url= parameter from the current page URL */
function getUrlParam(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("url");
}

// --- Folder Mode helpers ---

/** Get file path from URL hash. Hash format: #/path/to/file.adoc */
function getPathFromHash(): string | null {
  const hash = window.location.hash;
  if (!hash || hash === "#") return null;
  return hash.replace(/^#\/?/, "");
}

/** Set URL hash from file path */
function setHashFromPath(path: string | null) {
  if (path) {
    const newHash = `#/${path}`;
    if (window.location.hash !== newHash) {
      history.pushState(null, "", newHash);
    }
  } else {
    if (window.location.hash) {
      history.pushState(null, "", window.location.pathname + window.location.search);
    }
  }
}

/** Recursively find an FSEntry by its path in the tree */
function findEntryByPath(
  entries: FSEntry[],
  targetPath: string,
): FSEntry | null {
  for (const entry of entries) {
    if (entry.path === targetPath) return entry;
    if (entry.children) {
      const found = findEntryByPath(entry.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

export function App() {
  // Determine the operating mode on mount
  const sourceUrl = getUrlParam();
  const isUrlMode = !!sourceUrl;

  // Shared state
  const [html, setHtml] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [autoRefresh, setAutoRefresh] = createSignal(true);
  const [tocVisible, setTocVisible] = createSignal(true);
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(getStoredTheme());
  const [darkMode, setDarkMode] = createSignal(
    document.documentElement.classList.contains("dark")
  );

  function handleThemeChange(mode: string) {
    setThemeMode(mode as ThemeMode);
    applyTheme(mode as ThemeMode);
    setDarkMode(document.documentElement.classList.contains("dark"));
  }

  // Update darkMode when OS theme changes in system mode
  onMount(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (getStoredTheme() === "system") {
        setDarkMode(document.documentElement.classList.contains("dark"));
      }
    };
    mql.addEventListener("change", handler);
    onCleanup(() => mql.removeEventListener("change", handler));
  });

  function handleCodeThemeChange(id: string) {
    setCodeTheme(id);
    setStoredCodeTheme(id);
  }

  // Font preferences
  const [fontPrefs, setFontPrefs] = createSignal<FontPrefs>(getStoredFontPrefs());

  createEffect(() => {
    applyFontPrefs(fontPrefs());
  });

  function handleFontPrefsChange(partial: Partial<FontPrefs>) {
    const updated = { ...fontPrefs(), ...partial };
    setFontPrefs(updated);
    setStoredFontPrefs(updated);
  }

  // Recent files
  const [recentFiles, setRecentFiles] = createSignal<RecentFile[]>(getRecentFiles());

  function handleOpenRecent(path: string) {
    const entry = findEntryByPath(tree(), path);
    if (entry && entry.kind === "file") {
      loadFileContent(entry);
    }
  }

  function handleClearRecent() {
    clearRecentFiles();
    setRecentFiles([]);
  }

  // Editor state
  const [editorVisible, setEditorVisible] = createSignal(false);
  const [editorContent, setEditorContent] = createSignal("");

  // Folder mode state
  const [rootHandle, setRootHandle] =
    createSignal<FileSystemDirectoryHandle | null>(null);
  /** Fallback mode: flat file map for resolving includes (when File System Access API is unavailable) */
  const [fallbackFileMap, setFallbackFileMap] = createSignal<Map<string, File> | null>(null);
  const [tree, setTree] = createSignal<FSEntry[]>([]);
  const [selectedFile, setSelectedFile] = createSignal<FSEntry | null>(null);
  const [sidebarWidth, setSidebarWidth] = createSignal(280);
  const [sidebarVisible, setSidebarVisible] = createSignal(true);
  const [rootName, setRootName] = createSignal("");

  // URL mode state
  const [urlFileName, setUrlFileName] = createSignal("");
  const [urlError, setUrlError] = createSignal<string | null>(null);
  const [fileAccessDenied, setFileAccessDenied] = createSignal(false);

  // Fragment to scroll to after a cross-file xref navigation
  const [pendingFragment, setPendingFragment] = createSignal<string | null>(null);

  // Navigation stack (folder mode back/forward)
  const [navStack, setNavStack] = createSignal<string[]>([]);
  const [navIndex, setNavIndex] = createSignal(-1);
  const canGoBack = () => navIndex() > 0;
  const canGoForward = () => navIndex() < navStack().length - 1;
  const showNavButtons = () => !isUrlMode && (!!rootHandle() || !!fallbackFileMap());

  // Code theme
  const [codeTheme, setCodeTheme] = createSignal(getStoredCodeTheme());

  createEffect(() => {
    applyCodeTheme(codeTheme(), darkMode());
  });

  // File watcher (folder mode only)
  const watcher = new FileWatcher(() => {
    const file = selectedFile();
    if (file) loadFileContent(file);
  });

  // URL mode auto-refresh
  let urlRefreshInterval: ReturnType<typeof setInterval> | null = null;
  let lastUrlContentHash = "";

  onCleanup(() => {
    watcher.destroy();
    if (urlRefreshInterval) clearInterval(urlRefreshInterval);
  });

  // --- Initialization ---

  if (isUrlMode) {
    // URL Mode: fetch and render the file from the URL
    initUrlMode(sourceUrl!);
  } else {
    // Folder Mode: try to restore saved directory handle
    initFolderMode();
  }

  async function initUrlMode(url: string) {
    setUrlFileName(fileNameFromUrl(url));

    // Restore fragment from URL hash (set by cross-file xref navigation)
    const hash = window.location.hash;
    if (hash.length > 1) {
      setPendingFragment(decodeURIComponent(hash.slice(1)));
    }

    await loadUrlContent(url);

    // Auto-refresh polling only works for https:// URLs (direct fetch).
    // For file:// URLs the content was captured once by the content script
    // and we cannot re-fetch without host_permissions.
    if (!isFileUrl(url)) {
      startUrlRefresh(url);
    }
  }

  async function loadUrlContent(url: string) {
    setLoading(true);
    setUrlError(null);
    setFileAccessDenied(false);

    try {
      const content = await fetchFileByUrl(url);
      lastUrlContentHash = simpleHash(content);

      const baseUrl = dirOfUrl(url);
      const filePath = fileNameFromUrl(url);
      const readFile = createUrlReadFile(baseUrl);

      const convertOpts = { filePath, fileContent: content, readFile };
      const result = isMdFile(filePath)
        ? await convertMarkdown(convertOpts)
        : await convertAdoc(convertOpts);

      setHtml(result);
    } catch (e) {
      console.error("Failed to load URL:", e);

      // For file:// URLs, fetch failure likely means the content script
      // didn't inject (file access not enabled for the extension)
      if (isFileUrl(url)) {
        setFileAccessDenied(true);
      } else {
        setUrlError(`Failed to load file: ${e}`);
        setHtml(
          `<div class="error">Error loading file: ${e}</div>`,
        );
      }
    } finally {
      setLoading(false);
    }
  }

  function startUrlRefresh(url: string) {
    if (urlRefreshInterval) clearInterval(urlRefreshInterval);
    urlRefreshInterval = setInterval(async () => {
      if (!autoRefresh()) return;
      try {
        const content = await fetchFileByUrl(url);
        const hash = simpleHash(content);
        if (hash !== lastUrlContentHash) {
          lastUrlContentHash = hash;
          // Content changed — re-render
          const baseUrl = dirOfUrl(url);
          const filePath = fileNameFromUrl(url);
          const readFile = createUrlReadFile(baseUrl);
          const convertOpts = { filePath, fileContent: content, readFile };
          const result = isMdFile(filePath)
            ? await convertMarkdown(convertOpts)
            : await convertAdoc(convertOpts);
          setHtml(result);
        }
      } catch {
        // Silently ignore polling errors
      }
    }, 2000);
  }

  function simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      hash = ((hash << 5) - hash + ch) | 0;
    }
    return hash.toString(36);
  }

  async function initFolderMode() {
    // Fallback mode has no persistence — nothing to restore
    if (!hasNativePicker) return;

    const saved = await loadDirectoryHandle();
    if (!saved) return;

    try {
      // Request permission — may show a prompt if not already granted
      const perm = await (saved as any).requestPermission({ mode: "read" });
      if (perm !== "granted") return;

      setRootHandle(saved);
      setRootName(saved.name);
      setLoading(true);
      const entries = await readTree(saved);
      setTree(entries);
      setLoading(false);

      // Restore file from URL hash
      const hashPath = getPathFromHash();
      if (hashPath) {
        const entry = findEntryByPath(entries, hashPath);
        if (entry && entry.kind === "file") {
          loadFileContent(entry);
        }
      }
    } catch {
      // Permission denied or handle invalid — clear stale handle
      setRootHandle(null);
      setTree([]);
      setRootName("");
    }
  }

  // Handle browser back/forward navigation (folder mode)
  function onPopState() {
    if (isUrlMode) return;
    const hashPath = getPathFromHash();
    if (hashPath) {
      // Sync navIndex with the stack
      const stack = navStack();
      const idx = navIndex();
      if (hashPath === stack[idx - 1]) {
        setNavIndex(idx - 1);
      } else if (hashPath === stack[idx + 1]) {
        setNavIndex(idx + 1);
      }
      const entry = findEntryByPath(tree(), hashPath);
      if (entry && entry.kind === "file") {
        loadFileContent(entry, false);
      }
    }
  }

  function handleGoBack() {
    if (!canGoBack()) return;
    const stack = navStack();
    const newIdx = navIndex() - 1;
    const path = stack[newIdx];
    if (path) {
      const entry = findEntryByPath(tree(), path);
      if (entry && entry.kind === "file") {
        setNavIndex(newIdx);
        history.back();
        loadFileContent(entry, false);
      }
    }
  }

  function handleGoForward() {
    if (!canGoForward()) return;
    const stack = navStack();
    const newIdx = navIndex() + 1;
    const path = stack[newIdx];
    if (path) {
      const entry = findEntryByPath(tree(), path);
      if (entry && entry.kind === "file") {
        setNavIndex(newIdx);
        history.forward();
        loadFileContent(entry, false);
      }
    }
  }

  window.addEventListener("popstate", onPopState);
  onCleanup(() => window.removeEventListener("popstate", onPopState));

  // Toggle auto-refresh (folder mode watcher)
  createEffect(() => {
    if (isUrlMode) return;
    if (autoRefresh()) {
      watcher.start();
    } else {
      watcher.stop();
    }
  });

  async function handleOpenFolder() {
    try {
      if (hasNativePicker) {
        // Native File System Access API (Chrome, Edge)
        const handle = await openDirectory();
        setRootHandle(handle);
        setRootName(handle.name);
        setFallbackFileMap(null);
        await saveDirectoryHandle(handle);
        setLoading(true);
        const entries = await readTree(handle);
        setTree(entries);
        setLoading(false);
      } else {
        // Fallback: <input webkitdirectory> (Brave, etc.)
        const { rootName: name, files } = await openDirectoryFallback();
        const { entries } = buildTreeFromFiles(files);
        const fileMap = buildFileMap(files);
        setRootHandle(null);
        setFallbackFileMap(fileMap);
        setRootName(name);
        setTree(entries);
      }
      setSelectedFile(null);
      setHtml("");
      setHashFromPath(null);
      setNavStack([]);
      setNavIndex(-1);
    } catch (e: any) {
      if (e.name === "AbortError") return;
      // SecurityError/InvalidStateError = user gesture expired (e.g., from dropdown animation)
      if (e instanceof DOMException) {
        console.info("Open Folder requires a direct click. Try the button on the empty state page.");
      } else {
        console.error("Failed to open directory:", e);
      }
    }
  }

  async function loadFileContent(entry: FSEntry, pushHistory = true) {
    const root = rootHandle();
    const fileMap = fallbackFileMap();
    const isFallback = !root && !!fileMap;

    // Need either a native handle or a fallback file
    if (!root && !fileMap) return;
    if (entry.kind !== "file") return;

    setSelectedFile(entry);
    setLoading(true);

    if (pushHistory) {
      setHashFromPath(entry.path);
      // Update navigation stack: truncate forward history and push
      const stack = navStack().slice(0, navIndex() + 1);
      stack.push(entry.path);
      setNavStack(stack);
      setNavIndex(stack.length - 1);
      // Track recent files
      const updated = addRecentFile({
        name: entry.name,
        path: entry.path,
        rootName: rootName(),
      });
      setRecentFiles(updated);
    }

    try {
      // Read file content from handle (native) or File object (fallback)
      const content = isFallback
        ? await readFileContent(entry.file as File)
        : await readFileContent(entry.handle as FileSystemFileHandle);

      // Build readFile function for include:: resolution
      const readFile = isFallback
        ? (path: string) => readFileByPathFallback(fileMap, path)
        : (path: string) => readFileByPath(root!, path);

      const convertOpts = {
        filePath: entry.path,
        fileContent: content,
        readFile,
      };
      const result = isMdFile(entry.path)
        ? await convertMarkdown(convertOpts)
        : await convertAdoc(convertOpts);

      setHtml(result);
      setEditorContent(content);

      // Update watcher target (only in native mode — fallback has static snapshots)
      if (!isFallback && root) {
        const baseDirPath = entry.path.includes("/")
          ? entry.path.substring(0, entry.path.lastIndexOf("/"))
          : "";
        const includePaths = isMdFile(entry.path)
          ? getMarkdownIncludePaths(content, baseDirPath)
          : getIncludePaths(content, baseDirPath);
        watcher.setTarget({
          fileHandle: entry.handle as FileSystemFileHandle,
          includePaths,
          rootHandle: root,
        });

        if (autoRefresh()) {
          watcher.start();
        }
      }
    } catch (e) {
      console.error("Failed to convert file:", e);
      setHtml(`<div class="error">Error converting file: ${e}</div>`);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Navigate to a file by its path (from xref link clicks).
   */
  async function handleNavigate(targetPath: string, fragment?: string | null) {
    // Store fragment so Preview scrolls to it after content loads
    setPendingFragment(fragment ?? null);
    if (isUrlMode) {
      let targetUrl: string;

      if (/^file:\/\//i.test(targetPath) || /^https?:\/\//i.test(targetPath)) {
        // Already a full URL (e.g., file:// link clicked directly)
        targetUrl = targetPath;
      } else {
        // Resolve relative to the source URL
        const baseUrl = dirOfUrl(sourceUrl!);
        targetUrl = resolveUrl(baseUrl, targetPath);
      }

      // Navigate to the viewer with the new URL, preserving fragment for scroll
      const viewerUrl =
        window.location.pathname + "?url=" + encodeURIComponent(targetUrl) +
        (fragment ? "#" + encodeURIComponent(fragment) : "");
      window.location.href = viewerUrl;
      return;
    }

    const root = rootHandle();
    const fileMap = fallbackFileMap();
    if (!root && !fileMap) return;

    // First, try to find it in the existing tree (fastest)
    const entry = findEntryByPath(tree(), targetPath);
    if (entry && entry.kind === "file") {
      loadFileContent(entry);
      return;
    }

    // Fallback mode: look up the file in the flat file map
    if (!root && fileMap) {
      const file = fileMap.get(targetPath);
      if (file) {
        const name = targetPath.includes("/")
          ? targetPath.substring(targetPath.lastIndexOf("/") + 1)
          : targetPath;
        const syntheticEntry: FSEntry = {
          name,
          kind: "file",
          path: targetPath,
          file,
        };
        loadFileContent(syntheticEntry);
        return;
      }
      console.warn(`File not found in fallback map: ${targetPath}`);
      return;
    }

    // Native mode: resolve the file handle directly from the filesystem
    try {
      const fileHandle = await resolveFileByPath(root!, targetPath);
      if (fileHandle) {
        const name = targetPath.includes("/")
          ? targetPath.substring(targetPath.lastIndexOf("/") + 1)
          : targetPath;
        const syntheticEntry: FSEntry = {
          name,
          kind: "file",
          path: targetPath,
          handle: fileHandle,
        };
        loadFileContent(syntheticEntry);
        return;
      }
    } catch {
      // Fall through
    }

    console.warn(`File not found: ${targetPath}`);
  }

  // TOC panel ref (sibling of .content)
  let tocPanelRef: HTMLElement | undefined;

  function handleExportPdf() {
    // Ensure TOC panel is visible for printing
    const wasHidden = tocPanelRef?.classList.contains("toc-hidden");
    if (wasHidden) tocPanelRef!.classList.remove("toc-hidden");

    window.print();

    // Restore TOC visibility state after printing
    if (wasHidden) tocPanelRef!.classList.add("toc-hidden");
  }

  // Drag and drop files/folders
  const [dragOver, setDragOver] = createSignal(false);

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (isUrlMode) return;

    const items = e.dataTransfer?.items;
    if (!items || items.length === 0) return;

    const firstItem = items[0];

    // Try native FileSystemHandle (Chrome/Edge)
    if ("getAsFileSystemHandle" in firstItem) {
      try {
        const handle = await (firstItem as any).getAsFileSystemHandle();
        if (handle.kind === "directory") {
          setRootHandle(handle);
          setRootName(handle.name);
          setFallbackFileMap(null);
          await saveDirectoryHandle(handle);
          setLoading(true);
          const entries = await readTree(handle);
          setTree(entries);
          setLoading(false);
          setSelectedFile(null);
          setHtml("");
          setHashFromPath(null);
          setNavStack([]);
          setNavIndex(-1);
          return;
        }
        if (handle.kind === "file") {
          const file = await handle.getFile();
          if (isSupportedFile(file.name)) {
            const entry: FSEntry = { name: file.name, kind: "file", path: file.name, handle };
            setRootHandle(null);
            setFallbackFileMap(null);
            setRootName("");
            setTree([entry]);
            loadFileContent(entry);
          }
          return;
        }
      } catch {
        // Fall through to File fallback
      }
    }

    // Fallback: use File objects
    const file = firstItem.getAsFile();
    if (file && isSupportedFile(file.name)) {
      const entry: FSEntry = { name: file.name, kind: "file", path: file.name, file };
      setRootHandle(null);
      setFallbackFileMap(null);
      setRootName("");
      setTree([entry]);
      loadFileContent(entry);
    }
  }

  async function handleDownloadPdf() {
    const element = document.querySelector<HTMLElement>(".doc-body");
    if (!element) return;
    const { default: html2pdf } = await import("html2pdf.js");
    const filename = selectedFile()?.name?.replace(/\.(adoc|md)$/, ".pdf") ?? "document.pdf";
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

  // Editor change handler: reconvert content to HTML
  async function handleEditorChange(newContent: string) {
    setEditorContent(newContent);
    const entry = selectedFile();
    if (!entry) return;

    const root = rootHandle();
    const fileMap = fallbackFileMap();
    const isFallback = !root && !!fileMap;

    const readFile = isFallback
      ? (path: string) => readFileByPathFallback(fileMap!, path)
      : root
        ? (path: string) => readFileByPath(root, path)
        : () => Promise.resolve(null);

    try {
      const convertOpts = {
        filePath: entry.path,
        fileContent: newContent,
        readFile,
      };
      const result = isMdFile(entry.path)
        ? await convertMarkdown(convertOpts)
        : await convertAdoc(convertOpts);
      setHtml(result);
    } catch (e) {
      console.error("Failed to convert editor content:", e);
    }
  }

  // Save editor content back to file (native mode only)
  async function handleEditorSave() {
    const entry = selectedFile();
    const root = rootHandle();
    if (!entry || !root || !entry.handle) return;

    try {
      const handle = entry.handle as FileSystemFileHandle;
      const writable = await (handle as any).createWritable();
      await writable.write(editorContent());
      await writable.close();
    } catch (e) {
      console.error("Failed to save file:", e);
    }
  }

  // Sidebar resize logic (folder mode only)
  let resizing = false;

  function onResizeStart(e: MouseEvent) {
    e.preventDefault();
    resizing = true;

    const onMove = (ev: MouseEvent) => {
      if (!resizing) return;
      const newWidth = Math.max(180, Math.min(600, ev.clientX));
      setSidebarWidth(newWidth);
    };

    const onUp = () => {
      resizing = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // --- Derived state for toolbar ---
  const toolbarRootName = () => (isUrlMode ? "" : rootName());
  const toolbarFileName = () =>
    isUrlMode ? urlFileName() : (selectedFile()?.name ?? null);
  const toolbarFilePath = () =>
    isUrlMode
      ? displayPathFromUrl(sourceUrl!)
      : (selectedFile()?.path ?? null);
  const hasFile = () => isUrlMode ? !!html() : !!selectedFile();

  return (
    <div
      class="app"
      classList={{ "drag-over": dragOver() }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Toolbar
        autoRefresh={autoRefresh()}
        canGoBack={canGoBack()}
        canGoForward={canGoForward()}
        codeTheme={codeTheme()}
        codeThemes={CodeThemes}
        darkMode={darkMode()}
        fileName={toolbarFileName()}
        filePath={toolbarFilePath()}
        fontFamilies={FontFamilies}
        fontPrefs={fontPrefs()}
        fontSizes={FontSizes}
        editorVisible={editorVisible()}
        hasFile={hasFile()}
        recentFiles={recentFiles()}
        rootName={toolbarRootName()}
        showNavButtons={showNavButtons()}
        sidebarVisible={sidebarVisible()}
        themeMode={themeMode()}
        tocVisible={tocVisible()}
        onClearRecent={handleClearRecent}
        onCodeThemeChange={handleCodeThemeChange}
        onDownloadPdf={handleDownloadPdf}
        onExportPdf={handleExportPdf}
        onFontPrefsChange={handleFontPrefsChange}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onOpenFolder={handleOpenFolder}
        onOpenRecent={handleOpenRecent}
        onThemeChange={handleThemeChange}
        onToggleAutoRefresh={() => setAutoRefresh((v) => !v)}
        onToggleEditor={() => setEditorVisible((v) => !v)}
        onToggleSidebar={() => setSidebarVisible((v) => !v)}
        onToggleToc={() => setTocVisible((v) => !v)}
      />
      <div class="main">
        <Show when={!isUrlMode && sidebarVisible() && (rootHandle() || fallbackFileMap())}>
          <aside class="sidebar" style={{ width: `${sidebarWidth()}px` }}>
            <FileTree
              entries={tree()}
              selectedPath={selectedFile()?.path ?? null}
              onSelect={(entry) => loadFileContent(entry)}
            />
          </aside>
          <div class="resize-handle" onMouseDown={onResizeStart} />
        </Show>
        <Show when={editorVisible() && selectedFile()}>
          <div class="editor-panel">
            <Editor
              content={editorContent()}
              darkMode={darkMode()}
              onChange={handleEditorChange}
              onSave={handleEditorSave}
            />
          </div>
        </Show>
        <div class="content">
          <Show
            when={!fileAccessDenied()}
            fallback={<FileAccessWarning url={sourceUrl!} />}
          >
            <Show
              when={isUrlMode ? html() : selectedFile()}
              fallback={
                <EmptyState
                  hasRoot={!!rootHandle() || !!fallbackFileMap()}
                  onOpenFolder={handleOpenFolder}
                />
              }
            >
              <Preview
                html={html()}
                loading={loading()}
                tocVisible={tocVisible()}
                tocContainer={tocPanelRef}
                currentFilePath={
                  isUrlMode ? urlFileName() : (selectedFile()?.path ?? null)
                }
                pendingFragment={pendingFragment()}
                onFragmentHandled={() => setPendingFragment(null)}
                onNavigate={handleNavigate}
              />
            </Show>
          </Show>
        </div>
        <aside
          class="toc-panel"
          classList={{ "toc-hidden": !tocVisible() || !hasFile() }}
          ref={tocPanelRef}
        />
      </div>
    </div>
  );
}
