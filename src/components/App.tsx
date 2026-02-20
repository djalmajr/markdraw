import { createSignal, createEffect, onCleanup, Show } from "solid-js";
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
import { isMdFile } from "../lib/utils.ts";
import { FileWatcher } from "../lib/watcher.ts";
import { Toolbar } from "./Toolbar.tsx";
import { FileTree } from "./FileTree.tsx";
import { Preview } from "./Preview.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { FileAccessWarning } from "./FileAccessWarning.tsx";
import { getStoredTheme, applyTheme } from "../newtab.tsx";

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
  const [darkMode, setDarkMode] = createSignal(
    document.documentElement.classList.contains("dark")
  );

  function toggleDarkMode() {
    const next = !darkMode();
    setDarkMode(next);
    applyTheme(next ? "dark" : "light");
  }

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
      const entry = findEntryByPath(tree(), hashPath);
      if (entry && entry.kind === "file") {
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
    if (!root) return;

    // First, try to find it in the existing tree (fastest)
    const entry = findEntryByPath(tree(), targetPath);
    if (entry && entry.kind === "file") {
      loadFileContent(entry);
      return;
    }

    // Not in tree — resolve the file handle directly from the filesystem
    try {
      const fileHandle = await resolveFileByPath(root, targetPath);
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

  function handleExportPdf() {
    // Ensure TOC is visible for printing (it gets styled as a static block via @media print)
    const toc = document.querySelector<HTMLElement>("#toc");
    const tocWasHidden = toc && toc.style.display === "none";
    if (toc && tocWasHidden) {
      toc.style.display = "";
    }

    window.print();

    // Restore TOC visibility state after printing
    if (toc && tocWasHidden) {
      toc.style.display = "none";
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
    <div class="app">
      <Toolbar
        rootName={toolbarRootName()}
        fileName={toolbarFileName()}
        filePath={toolbarFilePath()}
        autoRefresh={autoRefresh()}
        onToggleAutoRefresh={() => setAutoRefresh((v) => !v)}
        sidebarVisible={sidebarVisible()}
        tocVisible={tocVisible()}
        darkMode={darkMode()}
        onToggleSidebar={() => setSidebarVisible((v) => !v)}
        onToggleToc={() => setTocVisible((v) => !v)}
        onToggleDarkMode={toggleDarkMode}
        onOpenFolder={handleOpenFolder}
        onExportPdf={handleExportPdf}
        hasFile={hasFile()}
      />
      <div class="main">
        <Show when={!isUrlMode && sidebarVisible() && rootHandle()}>
          <aside class="sidebar" style={{ width: `${sidebarWidth()}px` }}>
            <FileTree
              entries={tree()}
              selectedPath={selectedFile()?.path ?? null}
              onSelect={(entry) => loadFileContent(entry)}
            />
          </aside>
          <div class="resize-handle" onMouseDown={onResizeStart} />
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
                  hasRoot={!!rootHandle()}
                  onOpenFolder={handleOpenFolder}
                />
              }
            >
              <Preview
                html={html()}
                loading={loading()}
                tocVisible={tocVisible()}
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
      </div>
    </div>
  );
}
