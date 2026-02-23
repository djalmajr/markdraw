import { createEffect, createSignal, onCleanup } from "solid-js";
import { createConverter } from "@asciimark/core/converter.ts";
import ConvertWorker from "@asciimark/core/convert-worker.ts?worker";
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
    loadFileContent: loader.loadFileContent,
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

  return (
    <AppShell
      state={state}
      hasRoot={!!rootPath()}
      showEditorTabs={!!rootPath()}
      showNavButtons={!!rootPath()}
      showToolbar={!!rootPath()}
      showSidebar={state.sidebarVisible() && !!rootPath()}
      toolbarFilePath={state.selectedFile()?.path ?? null}
      toolbarRootName={state.rootName()}
      windowFrameToolbar={true}
      onWindowDragStart={handleWindowDragStart}
      onCloseFolder={folder.handleCloseFolder}
      onGoBack={navigation.handleGoBack}
      onGoForward={navigation.handleGoForward}
      onLoadFile={loader.loadFileContent}
      onNavigate={navigation.handleNavigate}
      onOpenFolder={folder.handleOpenFolder}
      onRefreshTree={() => folder.refreshTree()}
    />
  );
}
