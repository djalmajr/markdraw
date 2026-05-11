import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { createConverter } from "@asciimark/core/converter.ts";
import ConvertWorker from "@asciimark/core/convert-worker.ts?worker";
import type { IndexedFile } from "@asciimark/core/file-index.ts";
import type { Command } from "@asciimark/core/command-palette.ts";
import { getRecentFiles, type RecentFile } from "@asciimark/core/recent-files.ts";
import { makeTabId } from "@asciimark/core/tabs.ts";
import { getVersion } from "@tauri-apps/api/app";
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "./lib/chaos-invoke.ts";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { createAppState } from "@asciimark/ui/composables/create-app-state.ts";
import type { TabStore } from "@asciimark/ui/composables/create-tab-store.ts";
import { AppShell } from "@asciimark/ui/components/app-shell.tsx";
import * as m from "@asciimark/i18n";
import { switchLocale, useLocale, locales as i18nLocales } from "@asciimark/i18n/solid";
import { getStoredTheme, applyTheme } from "./main.tsx";
import { FileWatcher } from "./lib/watcher.ts";
import { createFileLoader } from "./lib/file-loader.ts";
import { createNavigation } from "./lib/navigation.ts";
import { createFolder } from "./lib/folder.ts";
import { isSupportedFile } from "@asciimark/core/utils.ts";
import { buildBacklinkIndex } from "@asciimark/core/backlinks.ts";
import { flattenWorkspace } from "@asciimark/core/file-index.ts";
import { readFileContent } from "./lib/fs.ts";
import {
  buildWorkspaceSymbols,
  type WorkspaceSymbol,
} from "@asciimark/core/workspace-symbols.ts";
import { confirm } from "@asciimark/ui/components/confirm-dialog.tsx";
import { setupTauriDnd } from "./lib/dnd.ts";
import { setupAppMenu } from "./lib/menu.ts";
import { setupTray } from "./lib/tray.ts";
import {
  _devSetDownloadProgress,
  _devSetPendingUpdate,
  checkForAppUpdates,
  dismissUpdate,
  useDownloadProgress,
  useUpdate,
} from "./lib/updater.ts";
import { fetchReleaseNotes, releaseHtmlUrl } from "./lib/release-notes.ts";
import { UpdateAvailableDialog } from "@asciimark/ui/components/update-available-dialog.tsx";
import { ReleaseNotesDialog } from "@asciimark/ui/components/release-notes-dialog.tsx";
import { findInFiles } from "./lib/fs.ts";
import { WindowControls } from "./components/window-controls.tsx";
import { FigmaCaptureButton } from "./components/figma-capture-button.tsx";
import { openUrl } from "@tauri-apps/plugin-opener";

const { convertAdoc, convertMarkdown } = createConverter(new ConvertWorker());

export function App() {
  const state = createAppState({
    applyTheme,
    convertAdoc,
    convertMarkdown,
    getStoredTheme,
    printPage: () => invoke("print_webview"),
  });

  // TabStore lives inside each PaneStore (see `createPaneStore`). The
  // host treats whichever pane is currently active as the "default"
  // tab store — read/write operations route there. As panes change
  // focus or split open, this accessor naturally flips with them.
  // Wrapped as a function (not a captured const) so the activePane
  // dependency stays reactive inside Solid effects.
  const tabStore = (): TabStore => state.paneManager.activePane().tabs;

  const [rootPaths, setRootPaths] = createSignal<Map<string, string>>(new Map());

  // Quick Open (Cmd/Ctrl+P) overlay visibility — owned here so the keyboard
  // handler can toggle it without round-tripping through AppShell.
  const [quickOpenVisible, setQuickOpenVisible] = createSignal(false);
  const [recentFilesVersion, setRecentFilesVersion] = createSignal(0);
  // Shortcuts help (Cmd/Ctrl+/ + toolbar menu item) — same pattern.
  const [shortcutsHelpVisible, setShortcutsHelpVisible] = createSignal(false);
  const [aboutOpen, setAboutOpen] = createSignal(false);
  const [appVersion, setAppVersion] = createSignal<string>("");
  // Release notes dialog state — driven by the "Release notes" menu
  // item / Command Palette command. `notes` is null while loading or
  // on error; `error` flips to a localized message on failure.
  const [releaseNotesState, setReleaseNotesState] = createSignal<{
    open: boolean;
    version: string;
    notes: string | null;
    loading: boolean;
    error: string | null;
    htmlUrl: string;
  }>({ open: false, version: "", notes: null, loading: false, error: null, htmlUrl: "" });
  // Command palette (Cmd/Ctrl+Shift+P).
  const [commandPaletteVisible, setCommandPaletteVisible] = createSignal(false);
  // Symbol palette (Cmd/Ctrl+Shift+O).
  const [symbolPaletteVisible, setSymbolPaletteVisible] = createSignal(false);
  // Workspace-wide symbol palette (Cmd/Ctrl+T). Shares the
  // open-only mutual-exclusion with the other overlays — the local
  // symbol palette is a sibling, not a sub-mode.
  const [workspaceSymbolPaletteVisible, setWorkspaceSymbolPaletteVisible] = createSignal(false);
  // Find in Files (Cmd/Ctrl+Shift+F).
  const [findInFilesVisible, setFindInFilesVisible] = createSignal(false);

  // Flag to suppress auto-save during tab switches
  let isTabSwitching = false;

  // File watcher (watches current file + includes for content changes)
  const watcher = new FileWatcher(async () => {
    const file = state.selectedFile();
    if (!file) return;

    try {
      await loader.loadFileContent(file, false, true);
      tabStore().updateActiveTabContent({
        editorContent: state.editorContent(),
        savedContent: state.savedContent(),
        html: state.html(),
        frontmatter: state.frontmatter(),
      });
    } catch {
      // File likely deleted — the dir watcher will refresh the tree
      // and the tab will show an error until clicked away
    }
  });

  // Create modules: loader -> navigation -> folder -> dnd
  const loader = createFileLoader({ rootPaths, state, watcher });

  const navigation = createNavigation({
    loadFileContent: loader.loadFileContent,
    rootPaths,
    state,
    tabStore,
    onActivateTab: (tabId) => handleActivateTab(tabId),
  });

  const folder = createFolder({
    rootPaths,
    setRootPaths,
    state,
    watcher,
  });

  setupTauriDnd({
    addRoot: folder.openFolderPath,
    loadFileContent: loader.loadFileContent,
    state,
  });

  // Dev-only: expose APIs so the MCP bridge can drive workspaces and toggles
  // from outside (avoids the native open-dialog when AI agents test the app).
  if (import.meta.env.DEV) {
    (window as unknown as { __DEV__?: Record<string, unknown> }).__DEV__ = {
      openFolder: folder.openFolderPath,
      toggleShowAllFiles: () => state.setShowAllFiles((v) => !v),
      toggleShowAllDirs: () => state.setShowAllDirs((v) => !v),
      toggleShowHidden: () => {
        const next = !state.showHiddenEntries();
        state.setShowHiddenEntries(next);
        return folder.refreshAllRoots(next);
      },
      getState: () => ({
        showAllFiles: state.showAllFiles(),
        showAllDirs: state.showAllDirs(),
        showHidden: state.showHiddenEntries(),
        roots: state.rootsList().map((r) => ({ id: r.id, entries: r.entries.length })),
      }),
      // Drive the move-tab handler directly. Useful for E2E that
      // can't reliably synthesize a Kobalte ContextMenu click.
      moveTab: (tabId: string, fromPaneIndex: number) => handleMoveTab(tabId, fromPaneIndex),
      simulatePendingUpdate: (version: string, currentVersion: string, notes: string) =>
        _devSetPendingUpdate({
          version,
          currentVersion,
          notes,
          install: async () => { console.log("[__DEV__] would install"); },
        }),
      simulateDownloadProgress: (
        phase: "downloading" | "installing",
        downloaded: number,
        total: number | null,
        speed: number,
      ) => _devSetDownloadProgress({ phase, downloaded, total, speed }),
      clearDownloadProgress: () => _devSetDownloadProgress(null),
    };

    // memlab soak hooks (DJA-38). The scenario dispatches synthetic
    // events that drive the edit + fs-change path the way the user's
    // keystrokes would, so memlab can compare baseline vs end-of-run
    // heap and detect retention regressions. We register the
    // listeners ONCE per process (no add/remove on each iteration —
    // that would muddy the very leak signal we're trying to measure).
    window.addEventListener("e2e:simulate-edit", (event) => {
      const detail = (event as CustomEvent<{ iter: number; content: string }>).detail;
      const pane = state.paneManager.activePane();
      // Push content through the same code path the editor uses, so
      // the convert pipeline runs, signal subscribers fire, and the
      // fs-change watcher's listeners are exercised.
      pane.setEditorContent(detail.content);
      pane.tabs.updateActiveTabContent({ editorContent: detail.content });
    });
    window.addEventListener("e2e:reset", () => {
      const pane = state.paneManager.activePane();
      pane.setEditorContent("");
      pane.tabs.updateActiveTabContent({ editorContent: "" });
    });
  }

  // Toggle auto-refresh (only when roots are open)
  createEffect(() => {
    if (rootPaths().size === 0) return;
    if (state.autoRefresh()) {
      watcher.start();
    } else {
      watcher.stop();
    }
  });

  // Watch workspace directories for file tree changes (rename/delete/create)
  createEffect(() => {
    const paths = rootPaths();
    if (paths.size === 0) {
      void invoke("stop_watching_dirs");
      return;
    }
    void invoke("watch_dirs", { paths: Array.from(paths.values()) });
  });

  onMount(() => {
    const pendingRoots = new Set<string>();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const unlisten = listen<{ paths: string[] }>("fs-tree-change", (event) => {
      // Identify which roots were affected
      const paths = rootPaths();
      for (const changed of event.payload.paths) {
        for (const [rootId, rootPath] of paths) {
          if (changed.startsWith(rootPath)) {
            pendingRoots.add(rootId);
            break;
          }
        }
      }
      // Debounce — batch rapid events into a single refresh per root
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        for (const rootId of pendingRoots) {
          void folder.refreshRoot(rootId);
        }
        pendingRoots.clear();
      }, 300);
    });
    onCleanup(() => {
      clearTimeout(refreshTimer);
      void unlisten.then((fn) => fn());
    });
  });

  // Auto-save: debounce 1s after editor content changes
  let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const content = state.editorContent();
    if (isTabSwitching) return;
    if (state.editorMode() === "preview") return;
    if (!state.selectedFile()) return;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      folder.handleEditorSave();
    }, 1000);
  });

  onCleanup(() => {
    clearTimeout(autoSaveTimer);
    watcher.destroy();
  });

  // Native app menu (macOS menu bar, Windows/Linux window menu) and tray icon.
  // Both are fire-and-forget; errors are logged but don't break the app.
  onMount(() => {
    // macOS traffic lights sit in the top-left corner of the overlay title
    // bar. Reserve space so toolbar controls don't overlap them.
    // On Windows the custom WindowControls (min/max/close) are drawn in the
    // top-right — reserve space for them.
    if (navigator.platform.startsWith("Mac")) {
      document.documentElement.style.setProperty("--toolbar-frame-inset-left", "78px");
    } else if (navigator.platform.startsWith("Win")) {
      // Custom caption buttons — 46×32 each × 3 = 138px (matches Win11 native).
      document.documentElement.style.setProperty("--toolbar-frame-inset-right", "138px");
    }

    void setupAppMenu({
      onOpenFolder: folder.handleOpenFolder,
      onExportPdf: () => invoke("print_webview"),
      onCheckForUpdates: () => checkForAppUpdates(false),
      onCloseTab: () => {
        const activeTab = tabStore().activeTabId();
        if (activeTab) handleCloseTab(activeTab);
      },
      onEditorMode: (m) => state.setEditorMode(m),
      onToggleSidebar: () => state.setSidebarVisible((v) => !v),
      onToggleToc: () => state.setTocVisible((v) => !v),
      onThemeChange: (mode) => state.handleThemeChange(mode),
      onFind: () => state.triggerPreviewFind(),
    }).catch((e) => console.error("Failed to set up app menu:", e));

    void setupTray({
      onOpenFolder: folder.handleOpenFolder,
    }).catch((e) => console.error("Failed to set up tray:", e));

    // Close-to-tray: clicking the window X hides instead of quitting.
    // The app keeps running in the tray. Only Cmd+Q or "Quit" from the
    // tray menu actually terminates.
    const win = getCurrentWindow();
    void win.onCloseRequested(async (event) => {
      if ((window as any).__asciimark_updating) return;
      event.preventDefault();
      await win.hide();
      await invoke("set_dock_visible", { visible: false });
    });
  });

  // ── File open via OS file associations ──────────────────────────────────
  // Handles both cold start (argv) and already-running (single-instance event).
  async function openFileByAbsolutePath(absolutePath: string): Promise<void> {
    // Extract the directory (root) and filename from the absolute path
    const normalized = absolutePath.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash < 0) return;
    const dirPath = normalized.slice(0, lastSlash);
    const fileName = normalized.slice(lastSlash + 1);

    if (!isSupportedFile(fileName)) return;

    // Open the parent directory as a workspace root
    const opened = await folder.openFolderPath(dirPath);
    if (!opened) return;

    // Find the file in the tree and load it (via tab system)
    const entry = state.findEntryByPath(fileName, dirPath);
    if (entry) {
      await handleLoadFileWithTab(entry, dirPath);
    }
  }

  // Cold start: check if the app was launched with a file argument
  onMount(() => {
    void invoke<string[]>("get_startup_args").then((args) => {
      const filePath = args.find((a) => !a.startsWith("-") && isSupportedFile(a));
      if (filePath) void openFileByAbsolutePath(filePath);
    }).catch(() => {
      // No args or command not available
    });
  });

  // Already running: single-instance plugin forwards file path via event
  onMount(() => {
    const unlisten = listen<string>("open-file", (event) => {
      if (event.payload) void openFileByAbsolutePath(event.payload);
    });
    onCleanup(() => { void unlisten.then((fn) => fn()); });
  });

  // Hydrate the About dialog's version string. Pulled from
  // @tauri-apps/api/app at runtime instead of bundling at build time so
  // we don't have to rebuild the frontend just to update the displayed
  // version on a hot-reloaded dev session.
  onMount(() => {
    void getVersion().then(setAppVersion).catch(() => {});
  });

  // Opens the Release Notes dialog for the currently-installed version,
  // fetching the body from GitHub the first time (cache hit afterwards).
  // The error fallback inside the dialog surfaces the message and the
  // "Open on GitHub" button remains available either way.
  async function openReleaseNotes(): Promise<void> {
    const version = appVersion() || (await getVersion().catch(() => ""));
    if (!version) return;
    setReleaseNotesState({
      open: true,
      version,
      notes: null,
      loading: true,
      error: null,
      htmlUrl: releaseHtmlUrl(version),
    });
    try {
      const result = await fetchReleaseNotes(version);
      setReleaseNotesState({
        open: true,
        version,
        notes: result.body,
        loading: false,
        error: null,
        htmlUrl: result.htmlUrl,
      });
    } catch (e) {
      setReleaseNotesState({
        open: true,
        version,
        notes: null,
        loading: false,
        error: (e as Error)?.message ?? String(e),
        htmlUrl: releaseHtmlUrl(version),
      });
    }
  }

  // In production, block the native WebView context menu (Reload / Inspect
  // Element). Kobalte's ContextMenu triggers call preventDefault() before this
  // listener fires, so custom menus (file tree, etc.) keep working.
  onMount(() => {
    if (!import.meta.env.PROD) return;
    const handler = (e: Event) => { if (!e.defaultPrevented) e.preventDefault(); };
    document.addEventListener("contextmenu", handler);
    onCleanup(() => document.removeEventListener("contextmenu", handler));
  });

  // Check for app updates a few seconds after boot — silent so any network
  // hiccup or "you're up to date" doesn't interrupt the user. The manual
  // menu item still surfaces feedback.
  onMount(() => {
    const updateTimer = window.setTimeout(() => {
      void checkForAppUpdates(true);
    }, 3000);
    onCleanup(() => window.clearTimeout(updateTimer));
  });

  async function handleWindowDragStart() {
    await getCurrentWindow().startDragging();
  }

  async function handleWindowTitleDoubleClick() {
    await invoke("toggle_maximize_instant");
  }

  async function handleOpenRecentFolder(path: string) {
    const opened = await folder.openFolderPath(path);
    if (!opened) {
      state.handleRemoveRecentFolder(path);
    }
  }

  /**
   * Resolve a relative `<img>` src from the current document into a Tauri
   * asset URL the webview can load. Returns `null` for already-absolute URLs
   * (http(s)://, data:, file:) so they pass through untouched.
   */
  function resolveImageSrc(src: string): string | null {
    // Already-absolute URL: leave it alone
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;

    const file = state.selectedFile();
    const rootId = state.selectedRootId();
    if (!file || !rootId) return null;
    const rootPath = rootPaths().get(rootId);
    if (!rootPath) return null;

    // Resolve `src` against the current file's directory.
    // Workspace-rooted absolute (`/foo/bar.png`) is treated as relative to
    // the workspace root.
    const fileDir = file.path.includes("/")
      ? file.path.slice(0, file.path.lastIndexOf("/"))
      : "";

    let relativeFromRoot: string;
    if (src.startsWith("/")) {
      relativeFromRoot = src.slice(1);
    } else {
      const parts = fileDir ? fileDir.split("/") : [];
      for (const part of src.split("/")) {
        if (part === "..") parts.pop();
        else if (part !== "" && part !== ".") parts.push(part);
      }
      relativeFromRoot = parts.join("/");
    }

    const absolutePath = `${rootPath}/${relativeFromRoot}`;
    return convertFileSrc(absolutePath);
  }

  async function handleOpenRecentFile(recentFile: RecentFile) {
    const opened = await folder.openFolderPath(recentFile.rootPath);
    if (!opened) {
      state.handleRemoveRecentFile(recentFile.path, recentFile.rootPath);
      state.handleRemoveRecentFolder(recentFile.rootPath);
      return;
    }

    const entry = state.findEntryByPath(recentFile.path, recentFile.rootPath);
    if (!entry || entry.kind !== "file") {
      state.handleRemoveRecentFile(recentFile.path, recentFile.rootPath);
      return;
    }

    state.pushRecentFile({
      entry,
      rootName: state.rootName(),
      rootPath: recentFile.rootPath,
    });
    await handleLoadFileWithTab(entry, recentFile.rootPath);
  }

  // ── Workspace indices (backlinks + symbols) ───────────────────────
  // Rebuild together whenever the roots tree changes (folder open,
  // refresh, watcher tick that re-reads dirs). Reads each indexed
  // `.md`/`.adoc` from disk once and feeds the same content into
  // both index builders — re-reading per index would double the
  // I/O for every workspace event.
  const [workspaceSymbols, setWorkspaceSymbols] = createSignal<readonly WorkspaceSymbol[]>([]);
  let workspaceBuildToken = 0;
  createEffect(() => {
    const roots = state.rootsList();
    const paths = rootPaths();
    if (roots.length === 0 || paths.size === 0) {
      state.setBacklinkIndex(new Map());
      setWorkspaceSymbols([]);
      return;
    }
    const token = ++workspaceBuildToken;
    void (async () => {
      const indexed = flattenWorkspace(roots).filter((f) => isSupportedFile(f.path));
      const filesForBacklinks: { path: string; content: string }[] = [];
      const filesForSymbols: {
        rootId: string;
        rootName: string;
        path: string;
        content: string;
      }[] = [];
      for (const file of indexed) {
        const root = paths.get(file.rootId);
        if (!root) continue;
        try {
          const content = await readFileContent(`${root}/${file.path}`);
          filesForBacklinks.push({ path: file.path, content });
          filesForSymbols.push({
            rootId: file.rootId,
            rootName: file.rootName,
            path: file.path,
            content,
          });
        } catch {
          // Permission / deleted between scan and read — skip silently.
        }
      }
      if (token !== workspaceBuildToken) return; // newer build started
      state.setBacklinkIndex(buildBacklinkIndex(filesForBacklinks));
      setWorkspaceSymbols(buildWorkspaceSymbols(filesForSymbols));
    })();
  });

  // ── Tab session restore ──────────────────────────────────────────────────
  // Restore tabs when roots become available after startup.
  let sessionRestored = false;

  createEffect(() => {
    // React to rootPaths changing (roots being opened)
    const paths = rootPaths();
    if (paths.size === 0 || sessionRestored) return;

    const session = tabStore().getPersistedSession();
    if (!session || session.tabs.length === 0) {
      sessionRestored = true;
      return;
    }

    // Try to restore tabs whose roots are now available
    const restorable = session.tabs.filter((t) => paths.has(t.rootId));
    if (restorable.length === 0) return;

    sessionRestored = true;

    // Restore all tabs synchronously (no file loading), mark as needsLoad.
    // Only the active tab gets its content loaded immediately.
    let activeEntry: import("@asciimark/core/types.ts").FSEntry | null = null;
    let activeRootId: string | null = null;

    for (const persisted of restorable) {
      const entry = state.findEntryByPath(persisted.filePath, persisted.rootId);
      if (!entry || entry.kind !== "file") continue;

      const isActive = persisted.id === session.activeTabId;
      tabStore().openTab(entry, persisted.rootId, { background: true });

      // Mark all restored tabs as needing content load
      const tabId = tabStore().tabs().find((t) => t.filePath === persisted.filePath && t.rootId === persisted.rootId)?.id;
      if (tabId) tabStore().markTabNeedsLoad(tabId);

      if (isActive) {
        activeEntry = entry;
        activeRootId = persisted.rootId;
      }
    }

    // Load only the active tab
    if (activeEntry && activeRootId) {
      void (async () => {
        await loader.loadFileContent(activeEntry!, false, false, activeRootId!);
        tabStore().updateActiveTabContent({
          editorContent: state.editorContent(),
          savedContent: state.savedContent(),
          html: state.html(),
          frontmatter: state.frontmatter(),
        });
        // Activate after content is loaded
        const tabId = tabStore().tabs().find((t) => t.filePath === activeEntry!.path && t.rootId === activeRootId)?.id;
        if (tabId) handleActivateTab(tabId);
      })();
    } else if (tabStore().tabs().length > 0) {
      // No active tab from session — activate the first
      void handleActivateTab(tabStore().tabs()[0]!.id);
    }
  });

  // Snapshot active tab before app hides (close-to-tray)
  onMount(() => {
    const win = getCurrentWindow();
    const unlisten = win.onFocusChanged((focused) => {
      if (!focused.payload) {
        tabStore().snapshotActiveTab();
        tabStore().persistSession();
      }
    });
    onCleanup(() => { void unlisten.then((fn) => fn()); });
  });

  // ── Tab handlers ────────────────────────────────────────────────────────

  /** Single click: load file in the active tab (replacing its content). */
  async function handleLoadFileWithTab(entry: import("@asciimark/core/types.ts").FSEntry, rootId: string) {
    tabStore().loadInActiveTab(entry, rootId);
    await loader.loadFileContent(entry, true, false, rootId);
    tabStore().updateActiveTabContent({
      editorContent: state.editorContent(),
      savedContent: state.savedContent(),
      html: state.html(),
      frontmatter: state.frontmatter(),
    });
  }

  /** Open in New Tab / middle-click / file-tree double-click. The
   *  resulting tab is **pinned** — these are the explicit "I want
   *  this around" gestures. If the file is already open in this
   *  pane, activate + pin in place rather than duplicating (VSCode
   *  semantics). */
  async function handleOpenInNewTab(entry: import("@asciimark/core/types.ts").FSEntry, rootId: string) {
    const store = tabStore();
    const existing = store.findTabByFile(entry.path, rootId);
    if (existing) {
      store.activateTab(existing.id);
      store.pinTab(existing.id);
      await loader.loadFileContent(entry, true, false, rootId);
      return;
    }
    store.openTab(entry, rootId);
    await loader.loadFileContent(entry, true, false, rootId);
    store.updateActiveTabContent({
      editorContent: state.editorContent(),
      savedContent: state.savedContent(),
      html: state.html(),
      frontmatter: state.frontmatter(),
    });
  }

  // Quick Open (Cmd/Ctrl+P) — recents set keyed by `${rootId}::${path}` so
  // the fuzzy ranker can boost recently-opened files. In desktop the rootId
  // equals the absolute root path (set by `folder.openFolderPath`), so the
  // keys map 1:1 with `RecentFile.{rootPath, path}`.
  const quickOpenRecents = createMemo<ReadonlySet<string>>(() => {
    recentFilesVersion(); // bump key forces re-read after a Quick Open pick
    return new Set(getRecentFiles().map((f) => `${f.rootPath}::${f.path}`));
  });

  /**
   * Move a tab from `fromPaneIndex` to the other pane. Opens the file
   * in the destination pane (creates the pane via `splitFromActive`
   * when there's only one) and closes the original. Same `editorMode`
   * is preserved so a split-side preview stays a preview.
   *
   * Mutation-survival contracts (locked in by the host-level domain
   * test in app.test.ts):
   *   - skipping `closeTab` on the origin → tab is duplicated.
   *   - skipping the `openTab` on the target → tab vanishes.
   *   - reading `fromPaneIndex` from the wrong end → tab moved from
   *     wrong pane.
   */
  function handleMoveTab(tabId: string, fromPaneIndex: number) {
    const panes = state.paneManager.panes();
    const sourcePane = panes[fromPaneIndex];
    if (!sourcePane) return;
    const tab = sourcePane.tabs.getTab(tabId);
    if (!tab) return;

    if (panes.length < 2) {
      state.paneManager.splitFromActive();
    }
    const updatedPanes = state.paneManager.panes();
    const targetIndex = fromPaneIndex === 0 ? 1 : 0;
    const targetPane = updatedPanes[targetIndex];
    if (!targetPane) return;

    const entry = state.findEntryByPath(tab.filePath, tab.rootId);
    if (!entry || entry.kind !== "file") return;

    // The TabState carries everything the editor/preview need to
    // render the moved file without reloading from disk. Snapshot
    // off the source tab itself (NOT the source pane's live signals
    // — those reflect whichever tab is currently active in the
    // source pane, which may not be the one being moved).
    const snapshot = {
      editorContent: tab.editorContent,
      savedContent: tab.savedContent,
      html: tab.html,
      frontmatter: tab.frontmatter,
      editorMode: tab.editorMode,
    };

    // Activate the target pane BEFORE writing through the AppState
    // proxy, so `state.setHtml` etc. land in the target pane's
    // signals. Without this, the proxy still points at the source
    // pane and the moved file would render in the wrong column.
    state.paneManager.setActivePane(targetIndex);

    // Open the file in the target pane's tab list. `openTab` (non-
    // background) sets the new tab active inside the target pane.
    targetPane.tabs.openTab(entry, tab.rootId);

    // Push the source's content into the new tab's TabState so
    // future tab-switches inside the target pane snapshot/restore
    // the correct content (otherwise the new tab is empty until the
    // user reloads from disk and tab-switches show stale content).
    targetPane.tabs.updateActiveTabContent({
      editorContent: snapshot.editorContent,
      savedContent: snapshot.savedContent,
      html: snapshot.html,
      frontmatter: snapshot.frontmatter,
    });

    // Mirror the snapshot through the AppState proxy so the editor
    // and preview update immediately for the user — restoreActiveTab
    // already runs inside `openTab` but reads from the freshly-empty
    // TabState (we hadn't written the content yet at that point).
    state.setEditorContent(snapshot.editorContent);
    state.setSavedContent(snapshot.savedContent);
    state.setHtml(snapshot.html);
    state.setFrontmatter(snapshot.frontmatter);
    state.setEditorMode(snapshot.editorMode);
    state.setSelectedFile(entry);
    state.setSelectedRootId(tab.rootId);

    // Finally remove the tab from the source pane. closeTab handles
    // the case where this was the last tab (clears source signals)
    // or activates a sibling (restores its content into source).
    sourcePane.tabs.closeTab(tabId);
  }

  async function handleQuickOpenSelect(file: IndexedFile) {
    setQuickOpenVisible(false);
    const entry = state.findEntryByPath(file.path, file.rootId);
    if (!entry || entry.kind !== "file") return;

    state.pushRecentFile({
      entry,
      rootName: file.rootName,
      rootPath: file.rootId,
    });
    setRecentFilesVersion((v) => v + 1);
    await handleOpenInNewTab(entry, file.rootId);
  }

  // Command palette catalog. Built reactively so `when()` predicates can
  // see live signals (hasFile, hasRoot, …). Each command's `run` calls
  // straight into the host's existing handlers — no new logic, just
  // surfacing what's already wired into the toolbar dropdown.
  const commandCatalog = createMemo<Command[]>(() => {
    // Track the locale signal so the memo recomputes — and the palette
    // re-renders — whenever the user switches language.
    useLocale();
    const hasRoot = rootPaths().size > 0;
    const hasFile = !!state.selectedFile();
    return [
      {
        id: "file.openFolder",
        group: "File",
        title: m.command_open_folder(),
        shortcut: { mac: ["⌘", "O"], other: ["Ctrl", "O"] },
        run: () => folder.handleOpenFolder(),
      },
      {
        id: "file.exportPdf",
        group: "File",
        title: m.command_export_pdf(),
        when: () => hasFile,
        run: () => state.handleExportPdf(),
      },
      {
        id: "view.toggleSidebar",
        group: "View",
        title: m.command_toggle_sidebar(),
        when: () => hasRoot,
        run: () => {
          state.setSidebarVisible((v) => !v);
        },
      },
      {
        id: "view.toggleHidden",
        group: "View",
        title: m.command_toggle_hidden_files(),
        when: () => hasRoot,
        run: () => folder.refreshAllRoots(!state.showHiddenEntries()),
      },
      {
        id: "view.editorMode.edit",
        group: "View",
        title: m.command_editor_mode_edit(),
        when: () => hasFile,
        run: () => {
          state.setEditorMode("edit");
        },
      },
      {
        id: "view.editorMode.split",
        group: "View",
        title: m.command_editor_mode_split(),
        when: () => hasFile && state.previewSupported(),
        run: () => {
          state.setEditorMode("split");
        },
      },
      {
        id: "view.editorMode.preview",
        group: "View",
        title: m.command_editor_mode_preview(),
        when: () => hasFile && state.previewSupported(),
        run: () => {
          state.setEditorMode("preview");
        },
      },
      {
        id: "theme.system",
        group: "Theme",
        title: m.command_theme_system(),
        run: () => {
          state.setThemeMode("system");
        },
      },
      {
        id: "theme.light",
        group: "Theme",
        title: m.command_theme_light(),
        run: () => {
          state.setThemeMode("light");
        },
      },
      {
        id: "theme.dark",
        group: "Theme",
        title: m.command_theme_dark(),
        run: () => {
          state.setThemeMode("dark");
        },
      },
      {
        id: "workspace.refresh",
        group: "Workspace",
        title: "Refresh Workspace",
        when: () => hasRoot,
        run: () => folder.refreshAllRoots(state.showHiddenEntries()),
      },
      {
        id: "nav.goToSymbol",
        group: "Workspace",
        title: "Go to Symbol in File…",
        shortcut: { mac: ["⌘", "⇧", "O"], other: ["Ctrl", "Shift", "O"] },
        when: () => hasFile,
        run: () => {
          setSymbolPaletteVisible(true);
        },
      },
      {
        id: "nav.findInFiles",
        group: "Workspace",
        title: "Find in Files…",
        shortcut: { mac: ["⌘", "⇧", "F"], other: ["Ctrl", "Shift", "F"] },
        when: () => hasRoot,
        run: () => {
          setFindInFilesVisible(true);
        },
      },
      {
        id: "view.splitEditor",
        group: "View",
        title: m.command_split_editor(),
        shortcut: { mac: ["⌘", "\\"], other: ["Ctrl", "\\"] },
        when: () => hasRoot && state.paneManager.panes().length < 2,
        run: () => {
          state.paneManager.splitFromActive();
        },
      },
      {
        id: "view.focusFirstPane",
        group: "View",
        title: m.command_focus_first_pane(),
        shortcut: { mac: ["⌘", "1"], other: ["Ctrl", "1"] },
        when: () => state.paneManager.panes().length > 1,
        run: () => {
          state.paneManager.setActivePane(0);
        },
      },
      {
        id: "view.focusSecondPane",
        group: "View",
        title: m.command_focus_second_pane(),
        shortcut: { mac: ["⌘", "2"], other: ["Ctrl", "2"] },
        when: () => state.paneManager.panes().length > 1,
        run: () => {
          state.paneManager.setActivePane(1);
        },
      },
      {
        id: "help.shortcuts",
        group: "Help",
        title: m.command_show_keyboard_shortcuts(),
        shortcut: { mac: ["⌘", "/"], other: ["Ctrl", "/"] },
        run: () => {
          setShortcutsHelpVisible(true);
        },
      },
      {
        id: "help.checkForUpdates",
        group: "Help",
        title: m.command_check_for_updates(),
        run: () => checkForAppUpdates(false),
      },
      {
        id: "help.releaseNotes",
        group: "Help",
        title: m.command_release_notes(),
        run: () => { void openReleaseNotes(); },
      },
      {
        id: "help.about",
        group: "Help",
        title: m.command_about(),
        run: () => { setAboutOpen(true); },
      },
      {
        id: "view.toggleReaderMode",
        group: "View",
        title: m.command_toggle_reader_mode(),
        shortcut: { mac: ["⌘", "."], other: ["Ctrl", "."] },
        run: () => state.setReaderMode((v) => !v),
      },
      {
        id: "navigate.workspaceSymbols",
        group: "Workspace",
        title: m.command_workspace_symbols(),
        shortcut: { mac: ["⌘", "⌥", "O"], other: ["Ctrl", "Alt", "O"] },
        run: () => {
          if (rootPaths().size === 0) return;
          setWorkspaceSymbolPaletteVisible(true);
        },
      },
      // Language switcher — reads from the i18n package's locale list so
      // adding a new locale to `packages/i18n` automatically surfaces it
      // here. Each entry sets the locale via the Solid adapter, which
      // persists to localStorage and forces re-render of all JSX that
      // tracks the locale signal.
      ...i18nLocales.map<Command>((loc) => ({
        id: `language.${loc}`,
        group: "Language",
        title:
          loc === "en"
            ? m.command_language_en()
            : loc === "pt-BR"
              ? m.command_language_pt_br()
              : m.command_language_es(),
        run: () => switchLocale(loc),
      })),
    ];
  });

  /** "+" button: create an empty tab (shows empty state). */
  function handleNewTab() {
    // Snapshot current tab, then clear state for the empty tab
    tabStore().snapshotActiveTab();

    // Create a minimal empty tab
    const emptyEntry: import("@asciimark/core/types.ts").FSEntry = {
      name: "New Tab",
      kind: "file",
      path: "",
    };
    const rootId = state.selectedRootId() ?? "";
    tabStore().openTab(emptyEntry, rootId);

    state.setSelectedFile(null);
    state.setHtml("");
    state.setFrontmatter(null);
    state.setEditorContent("");
    state.setSavedContent("");
    state.setEditorMode("preview");
  }

  async function handleActivateTab(tabId: string) {
    const tab = tabStore().getTab(tabId);
    if (!tab) return;

    isTabSwitching = true;
    clearTimeout(autoSaveTimer);

    tabStore().activateTab(tabId);

    // Set the selected file/root from the tab
    const entry = state.findEntryByPath(tab.filePath, tab.rootId);
    if (entry) {
      state.setSelectedFile(entry);
      state.setSelectedRootId(tab.rootId);
    }

    // If the tab needs content loaded (restored from session or reopened)
    if (tab.needsLoad && entry) {
      await loader.loadFileContent(entry, false, false, tab.rootId);
      tabStore().updateActiveTabContent({
        editorContent: state.editorContent(),
        savedContent: state.savedContent(),
        html: state.html(),
        frontmatter: state.frontmatter(),
      });
    }

    // Re-arm file watcher for the new active tab
    const rootPath = rootPaths().get(tab.rootId);
    if (rootPath && tab.filePath) {
      watcher.setTarget({
        filePath: `${rootPath}/${tab.filePath}`,
        includePaths: tab.includePaths,
        rootPath,
      });
      if (state.autoRefresh()) watcher.start();
    }

    queueMicrotask(() => {
      isTabSwitching = false;
    });
  }

  async function handleCloseTab(tabId: string) {
    const tab = tabStore().getTab(tabId);
    if (!tab) return;

    // For the active tab, check live dirty state; for others, check cached
    const isDirty = tabId === tabStore().activeTabId()
      ? state.isDirty()
      : tab.editorContent !== tab.savedContent;

    if (isDirty) {
      const discard = await confirm({
        title: "Close Tab",
        description: `"${tab.fileName}" has unsaved changes. Discard them?`,
        confirmLabel: "Discard",
      });
      if (!discard) return;
    }

    tabStore().closeTab(tabId);

    // After close, activate the new active tab
    const newActive = tabStore().getActiveTab();
    if (newActive) {
      const entry = state.findEntryByPath(newActive.filePath, newActive.rootId);
      if (entry) {
        state.setSelectedFile(entry);
        state.setSelectedRootId(newActive.rootId);
      }
      const rootPath = rootPaths().get(newActive.rootId);
      if (rootPath) {
        watcher.setTarget({
          filePath: `${rootPath}/${newActive.filePath}`,
          includePaths: newActive.includePaths,
          rootPath,
        });
        if (state.autoRefresh()) watcher.start();
      }
    }
  }

  // Close tabs when a root is closed
  const originalCloseRoot = folder.handleCloseRoot;
  folder.handleCloseRoot = (rootId: string) => {
    tabStore().closeTabsByRoot(rootId);
    originalCloseRoot(rootId);
  };

  // Update tab when a file is renamed
  const originalRename = folder.handleRename;
  folder.handleRename = async (entry, rootId, newName) => {
    const oldPath = entry.path;
    const slash = oldPath.lastIndexOf("/");
    const parentRel = slash >= 0 ? oldPath.slice(0, slash + 1) : "";
    const newPath = parentRel + newName;

    await originalRename(entry, rootId, newName);

    // Update any tabs pointing to the renamed file
    for (const tab of tabStore().tabs()) {
      if (tab.rootId === rootId && tab.filePath === oldPath) {
        tabStore().updateTabFile(tab.id, newPath, newName);
      }
    }
  };

  // Keyboard shortcuts for tabs
  onMount(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isMac = navigator.platform.startsWith("Mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;

      // Cmd/Ctrl+W: close active tab
      if (mod && e.key === "w" && !e.shiftKey) {
        const activeTab = tabStore().activeTabId();
        if (activeTab) {
          e.preventDefault();
          handleCloseTab(activeTab);
        }
      }

      // Cmd/Ctrl+T: new tab
      if (mod && !e.shiftKey && e.key === "t") {
        e.preventDefault();
        handleNewTab();
      }

      // Open exactly one overlay at a time. Each shortcut closes the
      // siblings before toggling its own — without this, hitting
      // Cmd+Shift+P while Cmd+Shift+O is up stacks two palettes on
      // screen (the second one renders over the first).
      function openOnly(target: "quick" | "command" | "symbol" | "wsymbol" | "find" | "help") {
        if (target !== "quick") setQuickOpenVisible(false);
        if (target !== "command") setCommandPaletteVisible(false);
        if (target !== "symbol") setSymbolPaletteVisible(false);
        if (target !== "wsymbol") setWorkspaceSymbolPaletteVisible(false);
        if (target !== "find") setFindInFilesVisible(false);
        if (target !== "help") setShortcutsHelpVisible(false);
        switch (target) {
          case "quick":
            setQuickOpenVisible((v) => !v);
            break;
          case "command":
            setCommandPaletteVisible((v) => !v);
            break;
          case "symbol":
            setSymbolPaletteVisible((v) => !v);
            break;
          case "wsymbol":
            setWorkspaceSymbolPaletteVisible((v) => !v);
            break;
          case "find":
            setFindInFilesVisible((v) => !v);
            break;
          case "help":
            setShortcutsHelpVisible((v) => !v);
            break;
        }
      }

      // Cmd/Ctrl+P: open the Quick Open overlay. preventDefault stops the
      // webview from triggering its native print dialog (Ctrl+P), even when
      // the workspace is empty — leaking the print dialog there would be a
      // worse surprise than the shortcut doing nothing.
      if (mod && !e.shiftKey && e.key === "p") {
        e.preventDefault();
        if (rootPaths().size === 0) return;
        openOnly("quick");
      }

      // Cmd/Ctrl+Shift+P: open the command palette. Available even when
      // no workspace is open — some commands (Open Folder, Theme) are
      // workspace-agnostic.
      if (mod && e.shiftKey && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        openOnly("command");
      }

      // Cmd/Ctrl+Shift+O: open the Go-to-Symbol palette. Only useful when
      // a file is open — silent no-op otherwise.
      if (mod && e.shiftKey && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        if (!state.selectedFile()) return;
        openOnly("symbol");
      }

      // Cmd/Ctrl+Alt+O: workspace-wide symbol search. Requires a
      // workspace; no-op on the dropzone home screen. Note: macOS
      // sends `ø` as the e.key when Option+O is pressed because the
      // option key composes diacritics — accept both forms.
      if (mod && e.altKey && (e.key === "o" || e.key === "O" || e.key === "ø" || e.key === "Ø")) {
        e.preventDefault();
        if (rootPaths().size === 0) return;
        openOnly("wsymbol");
      }

      // Cmd/Ctrl+Shift+F: open the Find in Files panel. Requires a workspace.
      if (mod && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        if (rootPaths().size === 0) return;
        openOnly("find");
      }

      // Cmd/Ctrl+/: toggle the keyboard shortcuts help modal. CodeMirror's
      // default + history keymaps don't bind Mod-/ in editor.tsx so this is
      // safe even with focus inside the editor.
      if (mod && !e.shiftKey && e.key === "/") {
        e.preventDefault();
        openOnly("help");
      }

      // Cmd/Ctrl+\\: split the editor into a second pane (or collapse
      // back when already split — toggle behaviour matches Cmd/Ctrl+P).
      if (mod && !e.shiftKey && e.key === "\\") {
        if (rootPaths().size === 0) return;
        e.preventDefault();
        if (state.paneManager.panes().length >= 2) {
          state.paneManager.collapseRightPane();
        } else {
          state.paneManager.splitFromActive();
        }
      }

      // Cmd/Ctrl+1 / Cmd/Ctrl+2: focus pane N (only meaningful when split).
      if (mod && !e.shiftKey && (e.key === "1" || e.key === "2")) {
        if (state.paneManager.panes().length < 2) return;
        e.preventDefault();
        state.paneManager.setActivePane(e.key === "1" ? 0 : 1);
      }

      // Cmd/Ctrl+Shift+T: reopen last closed tab
      if (mod && e.shiftKey && e.key === "t") {
        e.preventDefault();
        const reopened = tabStore().reopenClosedTab();
        if (reopened) {
          void handleActivateTab(reopened.id);
        }
      }

      // Cmd/Ctrl+.: toggle Reader / Zen mode. F11 is hijacked by
      // macOS Mission Control / Show Desktop and never reaches the
      // webview reliably, so the primary binding is the period
      // chord. F11 is still accepted as a fallback for keyboards
      // that map it independently.
      if ((mod && !e.shiftKey && e.key === ".") || (e.key === "F11" && !mod && !e.shiftKey)) {
        e.preventDefault();
        state.setReaderMode((v) => !v);
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: cycle tabs
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const tabs = tabStore().tabs();
        const activeId = tabStore().activeTabId();
        if (tabs.length < 2 || !activeId) return;
        const currentIdx = tabs.findIndex((t) => t.id === activeId);
        const nextIdx = e.shiftKey
          ? (currentIdx - 1 + tabs.length) % tabs.length
          : (currentIdx + 1) % tabs.length;
        handleActivateTab(tabs[nextIdx]!.id);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  const isWindows = navigator.platform.startsWith("Win");

  return (
    <>
      {isWindows && <WindowControls />}
      <AppShell
      state={state}
      hasRoot={rootPaths().size > 0}
      showRecentHistory={true}
      showEditorTabs={rootPaths().size > 0}
      showNavButtons={rootPaths().size > 0}
      showToolbar={rootPaths().size > 0}
      showSidebar={state.sidebarVisible() && rootPaths().size > 0}
      showWindowControls={navigator.platform.startsWith("Win")}
      toolbarFilePath={state.selectedFile()?.path ?? null}
      toolbarRootName={state.rootName()}
      windowFrameToolbar={true}
      onWindowDragStart={handleWindowDragStart}
      onWindowTitleDoubleClick={handleWindowTitleDoubleClick}
      onCheckForUpdates={() => checkForAppUpdates(false)}
      onReleaseNotes={() => { void openReleaseNotes(); }}
      tabStore={tabStore()}
      onActivateTab={handleActivateTab}
      onCloseTab={handleCloseTab}
      onNewTab={handleNewTab}
      onMoveTab={handleMoveTab}
      quickOpenOpen={quickOpenVisible()}
      quickOpenRecents={quickOpenRecents()}
      onQuickOpenSelect={handleQuickOpenSelect}
      onQuickOpenClose={() => setQuickOpenVisible(false)}
      shortcutsHelpOpen={shortcutsHelpVisible()}
      onShortcutsHelpOpen={() => setShortcutsHelpVisible(true)}
      onShortcutsHelpClose={() => setShortcutsHelpVisible(false)}
      aboutOpen={aboutOpen()}
      aboutVersion={appVersion()}
      onAboutOpen={() => setAboutOpen(true)}
      onAboutClose={() => setAboutOpen(false)}
      commandPaletteOpen={commandPaletteVisible()}
      commandCatalog={commandCatalog()}
      onCommandPaletteClose={() => setCommandPaletteVisible(false)}
      symbolPaletteOpen={symbolPaletteVisible()}
      onSymbolPaletteClose={() => setSymbolPaletteVisible(false)}
      workspaceSymbolPaletteOpen={workspaceSymbolPaletteVisible()}
      workspaceSymbols={workspaceSymbols()}
      onWorkspaceSymbolPaletteClose={() => setWorkspaceSymbolPaletteVisible(false)}
      findInFilesOpen={findInFilesVisible()}
      findInFilesSearch={(rootId, query, opts) =>
        findInFiles(rootId, query, { caseSensitive: opts.caseSensitive })
      }
      onFindInFilesClose={() => setFindInFilesVisible(false)}
      onCloseRoot={(rootId) => folder.handleCloseRoot(rootId)}
      onCopyPath={folder.handleCopyPath}
      onGoBack={navigation.handleGoBack}
      onGoForward={navigation.handleGoForward}
      onLoadFile={handleLoadFileWithTab}
      onOpenInNewTab={handleOpenInNewTab}
      onDoubleClickFile={handleOpenInNewTab}
      onNavigate={navigation.handleNavigate}
      onOpenExternal={(url) => openUrl(url)}
      onOpenFolder={folder.handleOpenFolder}
      onOpenRecentFile={handleOpenRecentFile}
      onOpenRecentFolder={handleOpenRecentFolder}
      onRename={folder.handleRename}
      onDelete={async (entry, rootId) => {
        const label = entry.kind === "directory" ? "folder" : "file";
        const confirmed = await confirm({
          title: `Delete ${label}`,
          description: `Move "${entry.name}" to Trash?`,
          confirmLabel: "Move to Trash",
        });
        if (confirmed) {
          await folder.handleDelete(entry, rootId);
          // Close ALL tabs for deleted files (including duplicates)
          const tabsToClose = tabStore().tabs().filter((t) =>
            t.rootId === rootId && (
              t.filePath === entry.path ||
              (entry.kind === "directory" && t.filePath.startsWith(entry.path + "/"))
            ),
          );
          for (const tab of tabsToClose) {
            tabStore().closeTab(tab.id);
          }
        }
      }}
      resolveImageSrc={resolveImageSrc}
      onToggleShowHiddenEntries={(enabled) => folder.refreshAllRoots(enabled)}
      onReorderRoots={(newOrder) => state.reorderRoots(newOrder)}
    />
    <UpdateAvailableDialog
      open={!!useUpdate()}
      version={useUpdate()?.version ?? ""}
      currentVersion={useUpdate()?.currentVersion ?? ""}
      notes={useUpdate()?.notes}
      downloadProgress={useDownloadProgress()}
      onDismiss={dismissUpdate}
      onInstall={() => {
        const update = useUpdate();
        if (!update) return;
        void update.install();
      }}
    />
    <ReleaseNotesDialog
      open={releaseNotesState().open}
      version={releaseNotesState().version}
      loading={releaseNotesState().loading}
      notes={releaseNotesState().notes}
      error={releaseNotesState().error}
      htmlUrl={releaseNotesState().htmlUrl}
      onClose={() => setReleaseNotesState((s) => ({ ...s, open: false }))}
      onOpenInBrowser={() => {
        void openUrl(releaseNotesState().htmlUrl);
      }}
    />
    {import.meta.env.DEV && <FigmaCaptureButton />}
    </>
  );
}
