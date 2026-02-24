import { createEffect, createSignal, onCleanup } from "solid-js";
import { createConverter } from "@asciimark/core/converter.ts";
import ConvertWorker from "@asciimark/core/convert-worker.ts?worker";
import type { RecentFile } from "@asciimark/core/recent-files.ts";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createAppState } from "@asciimark/ui/composables/create-app-state.ts";
import { AppShell } from "@asciimark/ui/components/app-shell.tsx";
import { getStoredTheme, applyTheme } from "./main.tsx";
import { FileWatcher } from "./lib/watcher.ts";
import { createFileLoader } from "./lib/file-loader.ts";
import { createNavigation } from "./lib/navigation.ts";
import { createFolder } from "./lib/folder.ts";
import { setupTauriDnd } from "./lib/dnd.ts";

const { convertAdoc, convertMarkdown } = createConverter(new ConvertWorker());

export function App() {
  const state = createAppState({
    applyTheme,
    convertAdoc,
    convertMarkdown,
    getStoredTheme,
    printPage: () => invoke("print_webview"),
  });

  const [rootPath, setRootPath] = createSignal<string | null>(null);

  // File watcher (watches current file + includes for content changes)
  const watcher = new FileWatcher(() => {
    const file = state.selectedFile();
    if (file) loader.loadFileContent(file, false, true);
  });

  // Create modules: loader -> navigation -> folder -> dnd
  const loader = createFileLoader({ rootPath, state, watcher });

  const navigation = createNavigation({
    loadFileContent: loader.loadFileContent,
    rootPath,
    setRootPath,
    state,
  });

  const folder = createFolder({
    resetNavigation: navigation.resetStacks,
    rootPath,
    setRootPath,
    state,
    watcher,
  });

  setupTauriDnd({
    loadFileContent: loader.loadFileContent,
    setRootPath,
    state,
  });

  // Override canGoBack/canGoForward to account for context stacks
  state.canGoBack = navigation.canGoBack;
  state.canGoForward = navigation.canGoForward;

  // Toggle auto-refresh (only when a folder is open)
  createEffect(() => {
    if (!rootPath()) return;
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

  async function handleOpenRecentFile(recentFile: RecentFile) {
    const opened = await folder.openFolderPath(recentFile.rootPath);
    if (!opened) {
      state.handleRemoveRecentFile(recentFile.path, recentFile.rootPath);
      state.handleRemoveRecentFolder(recentFile.rootPath);
      return;
    }

    const entry = state.findEntryByPath(recentFile.path);
    if (!entry || entry.kind !== "file") {
      state.handleRemoveRecentFile(recentFile.path, recentFile.rootPath);
      return;
    }

    state.pushRecentFile({
      entry,
      rootName: state.rootName(),
      rootPath: recentFile.rootPath,
    });
    await loader.loadFileContent(entry);
  }

  return (
    <AppShell
      state={state}
      hasRoot={!!rootPath()}
      showRecentHistory={true}
      showEditorTabs={!!rootPath()}
      showNavButtons={!!rootPath()}
      showToolbar={!!rootPath()}
      showSidebar={state.sidebarVisible() && !!rootPath()}
      toolbarFilePath={state.selectedFile()?.path ?? null}
      toolbarRootName={state.rootName()}
      windowFrameToolbar={true}
      onWindowDragStart={handleWindowDragStart}
      onWindowTitleDoubleClick={handleWindowTitleDoubleClick}
      onCloseFolder={folder.handleCloseFolder}
      onGoBack={navigation.handleGoBack}
      onGoForward={navigation.handleGoForward}
      onLoadFile={loader.loadFileContent}
      onNavigate={navigation.handleNavigate}
      onOpenFolder={folder.handleOpenFolder}
      onOpenRecentFile={handleOpenRecentFile}
      onOpenRecentFolder={handleOpenRecentFolder}
      onRefreshTree={() => folder.refreshTree()}
    />
  );
}
