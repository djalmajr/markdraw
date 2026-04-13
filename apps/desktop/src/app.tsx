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
    const rootId = state.selectedRootId();
    if (!file || !rootId) return;

    // Refresh the file tree first to detect renames/deletes
    await folder.refreshRoot(rootId);

    // Check if the file still exists in the tree after refresh
    const stillExists = state.findEntryByPath(file.path, rootId);
    if (!stillExists) {
      // File was deleted or renamed externally — close the tab
      const activeTab = tabStore.activeTabId();
      if (activeTab) tabStore.closeTab(activeTab);
      const { showToast } = await import("@asciimark/ui/components/ui/toast.tsx");
      showToast({ title: "File deleted or moved", description: file.name, duration: 4000 });
      return;
    }

    await loader.loadFileContent(file, false, true);
    tabStore.updateActiveTabContent({
      editorContent: state.editorContent(),
      savedContent: state.savedContent(),
      html: state.html(),
      frontmatter: state.frontmatter(),
    });
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

  // Toggle auto-refresh (only when roots are open)
  createEffect(() => {
    if (rootPaths().size === 0) return;
    if (state.autoRefresh()) {
      watcher.start();
    } else {
      watcher.stop();
    }
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
    // On Windows/Linux the controls are on the right — no inset needed.
    if (navigator.platform.startsWith("Mac")) {
      document.documentElement.style.setProperty("--toolbar-frame-inset-left", "78px");
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
  if (import.meta.env.PROD) {
    document.addEventListener("contextmenu", (e) => {
      if (!e.defaultPrevented) e.preventDefault();
    });
  }

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

    // Restore tabs asynchronously
    (async () => {
      for (const persisted of restorable) {
        const entry = state.findEntryByPath(persisted.filePath, persisted.rootId);
        if (!entry || entry.kind !== "file") continue;

        const isActive = persisted.id === session.activeTabId;
        tabStore.openTab(entry, persisted.rootId, {
          background: !isActive,
        });

        if (isActive) {
          await loader.loadFileContent(entry, false, false, persisted.rootId);
          tabStore.updateActiveTabContent({
            editorContent: state.editorContent(),
            savedContent: state.savedContent(),
            html: state.html(),
            frontmatter: state.frontmatter(),
          });
        } else {
          // Mark background tabs to load content when activated
          tabStore.updateActiveTabContent({ });  // no-op on non-active
          // Directly mark needsLoad on the tab
          const tabId = tabStore.tabs().find((t) => t.filePath === persisted.filePath && t.rootId === persisted.rootId)?.id;
          if (tabId) {
            tabStore.markTabNeedsLoad(tabId);
          }
        }
      }

      // If the active tab from session wasn't restored, activate the first tab
      if (!tabStore.activeTabId() && tabStore.tabs().length > 0) {
        const first = tabStore.tabs()[0]!;
        handleActivateTab(first.id);
        const entry = state.findEntryByPath(first.filePath, first.rootId);
        if (entry) {
          await loader.loadFileContent(entry, false, false, first.rootId);
          tabStore.updateActiveTabContent({
            editorContent: state.editorContent(),
            savedContent: state.savedContent(),
            html: state.html(),
            frontmatter: state.frontmatter(),
          });
        }
      }
    })();
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

  return (
    <AppShell
      state={state}
      hasRoot={rootPaths().size > 0}
      showRecentHistory={true}
      showEditorTabs={rootPaths().size > 0}
      showNavButtons={rootPaths().size > 0}
      showToolbar={rootPaths().size > 0}
      showSidebar={state.sidebarVisible() && rootPaths().size > 0}
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
      onRefreshRoot={(rootId) => folder.refreshRoot(rootId)}
      onReorderRoots={(newOrder) => state.reorderRoots(newOrder)}
    />
  );
}
