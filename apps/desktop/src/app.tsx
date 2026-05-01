import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { createConverter } from "@asciimark/core/converter.ts";
import ConvertWorker from "@asciimark/core/convert-worker.ts?worker";
import type { RecentFile } from "@asciimark/core/recent-files.ts";
import { makeTabId } from "@asciimark/core/tabs.ts";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { createAppState } from "@asciimark/ui/composables/create-app-state.ts";
import { createTabStore } from "@asciimark/ui/composables/create-tab-store.ts";
import { AppShell } from "@asciimark/ui/components/app-shell.tsx";
import { getStoredTheme, applyTheme } from "./main.tsx";
import { FileWatcher } from "./lib/watcher.ts";
import { createFileLoader } from "./lib/file-loader.ts";
import { createNavigation } from "./lib/navigation.ts";
import { createFolder } from "./lib/folder.ts";
import { isSupportedFile } from "@asciimark/core/utils.ts";
import { confirm } from "@asciimark/ui/components/confirm-dialog.tsx";
import { setupTauriDnd } from "./lib/dnd.ts";
import { setupAppMenu } from "./lib/menu.ts";
import { setupTray } from "./lib/tray.ts";
import { checkForAppUpdates } from "./lib/updater.ts";
import { WindowControls } from "./components/window-controls.tsx";
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

  const tabStore = createTabStore({ state });

  const [rootPaths, setRootPaths] = createSignal<Map<string, string>>(new Map());

  // Flag to suppress auto-save during tab switches
  let isTabSwitching = false;

  // File watcher (watches current file + includes for content changes)
  const watcher = new FileWatcher(async () => {
    const file = state.selectedFile();
    if (!file) return;

    try {
      await loader.loadFileContent(file, false, true);
      tabStore.updateActiveTabContent({
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
    };
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
        const activeTab = tabStore.activeTabId();
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

  // ── Tab session restore ──────────────────────────────────────────────────
  // Restore tabs when roots become available after startup.
  let sessionRestored = false;

  createEffect(() => {
    // React to rootPaths changing (roots being opened)
    const paths = rootPaths();
    if (paths.size === 0 || sessionRestored) return;

    const session = tabStore.getPersistedSession();
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
      tabStore.openTab(entry, persisted.rootId, { background: true });

      // Mark all restored tabs as needing content load
      const tabId = tabStore.tabs().find((t) => t.filePath === persisted.filePath && t.rootId === persisted.rootId)?.id;
      if (tabId) tabStore.markTabNeedsLoad(tabId);

      if (isActive) {
        activeEntry = entry;
        activeRootId = persisted.rootId;
      }
    }

    // Load only the active tab
    if (activeEntry && activeRootId) {
      void (async () => {
        await loader.loadFileContent(activeEntry!, false, false, activeRootId!);
        tabStore.updateActiveTabContent({
          editorContent: state.editorContent(),
          savedContent: state.savedContent(),
          html: state.html(),
          frontmatter: state.frontmatter(),
        });
        // Activate after content is loaded
        const tabId = tabStore.tabs().find((t) => t.filePath === activeEntry!.path && t.rootId === activeRootId)?.id;
        if (tabId) handleActivateTab(tabId);
      })();
    } else if (tabStore.tabs().length > 0) {
      // No active tab from session — activate the first
      void handleActivateTab(tabStore.tabs()[0]!.id);
    }
  });

  // Snapshot active tab before app hides (close-to-tray)
  onMount(() => {
    const win = getCurrentWindow();
    const unlisten = win.onFocusChanged((focused) => {
      if (!focused.payload) {
        tabStore.snapshotActiveTab();
        tabStore.persistSession();
      }
    });
    onCleanup(() => { void unlisten.then((fn) => fn()); });
  });

  // ── Tab handlers ────────────────────────────────────────────────────────

  /** Single click: load file in the active tab (replacing its content). */
  async function handleLoadFileWithTab(entry: import("@asciimark/core/types.ts").FSEntry, rootId: string) {
    tabStore.loadInActiveTab(entry, rootId);
    await loader.loadFileContent(entry, true, false, rootId);
    tabStore.updateActiveTabContent({
      editorContent: state.editorContent(),
      savedContent: state.savedContent(),
      html: state.html(),
      frontmatter: state.frontmatter(),
    });
  }

  /** Open in New Tab / middle-click / double-click: always create a new tab. */
  async function handleOpenInNewTab(entry: import("@asciimark/core/types.ts").FSEntry, rootId: string) {
    tabStore.openTab(entry, rootId);
    await loader.loadFileContent(entry, true, false, rootId);
    tabStore.updateActiveTabContent({
      editorContent: state.editorContent(),
      savedContent: state.savedContent(),
      html: state.html(),
      frontmatter: state.frontmatter(),
    });
  }

  /** "+" button: create an empty tab (shows empty state). */
  function handleNewTab() {
    // Snapshot current tab, then clear state for the empty tab
    tabStore.snapshotActiveTab();

    // Create a minimal empty tab
    const emptyEntry: import("@asciimark/core/types.ts").FSEntry = {
      name: "New Tab",
      kind: "file",
      path: "",
    };
    const rootId = state.selectedRootId() ?? "";
    tabStore.openTab(emptyEntry, rootId);

    state.setSelectedFile(null);
    state.setHtml("");
    state.setFrontmatter(null);
    state.setEditorContent("");
    state.setSavedContent("");
    state.setEditorMode("preview");
  }

  async function handleActivateTab(tabId: string) {
    const tab = tabStore.getTab(tabId);
    if (!tab) return;

    isTabSwitching = true;
    clearTimeout(autoSaveTimer);

    tabStore.activateTab(tabId);

    // Set the selected file/root from the tab
    const entry = state.findEntryByPath(tab.filePath, tab.rootId);
    if (entry) {
      state.setSelectedFile(entry);
      state.setSelectedRootId(tab.rootId);
    }

    // If the tab needs content loaded (restored from session or reopened)
    if (tab.needsLoad && entry) {
      await loader.loadFileContent(entry, false, false, tab.rootId);
      tabStore.updateActiveTabContent({
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
    const tab = tabStore.getTab(tabId);
    if (!tab) return;

    // For the active tab, check live dirty state; for others, check cached
    const isDirty = tabId === tabStore.activeTabId()
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

    tabStore.closeTab(tabId);

    // After close, activate the new active tab
    const newActive = tabStore.getActiveTab();
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
    tabStore.closeTabsByRoot(rootId);
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
    for (const tab of tabStore.tabs()) {
      if (tab.rootId === rootId && tab.filePath === oldPath) {
        tabStore.updateTabFile(tab.id, newPath, newName);
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
        const activeTab = tabStore.activeTabId();
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

      // Cmd/Ctrl+Shift+T: reopen last closed tab
      if (mod && e.shiftKey && e.key === "t") {
        e.preventDefault();
        const reopened = tabStore.reopenClosedTab();
        if (reopened) {
          void handleActivateTab(reopened.id);
        }
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: cycle tabs
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const tabs = tabStore.tabs();
        const activeId = tabStore.activeTabId();
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
      tabStore={tabStore}
      onActivateTab={handleActivateTab}
      onCloseTab={handleCloseTab}
      onNewTab={handleNewTab}
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
          const tabsToClose = tabStore.tabs().filter((t) =>
            t.rootId === rootId && (
              t.filePath === entry.path ||
              (entry.kind === "directory" && t.filePath.startsWith(entry.path + "/"))
            ),
          );
          for (const tab of tabsToClose) {
            tabStore.closeTab(tab.id);
          }
        }
      }}
      resolveImageSrc={resolveImageSrc}
      onToggleShowHiddenEntries={(enabled) => folder.refreshAllRoots(enabled)}
      onReorderRoots={(newOrder) => state.reorderRoots(newOrder)}
    />
    </>
  );
}
