import { createSignal, createEffect, onCleanup, Show } from "solid-js";
import { createConverter } from "@asciimark/core/converter.ts";
import ConvertWorker from "@asciimark/core/convert-worker.ts?worker";
import { createAppState } from "@asciimark/ui/composables/create-app-state.ts";
import { AppShell } from "@asciimark/ui/components/app-shell.tsx";
import { FileAccessWarning } from "@asciimark/ui/components/file-access-warning.tsx";
import { getStoredTheme, applyTheme } from "./main.tsx";
import { displayPathFromUrl } from "./lib/url-source.ts";
import { FileWatcher } from "./lib/watcher.ts";
import { getUrlParam } from "./lib/hash.ts";
import { createFileLoader } from "./lib/file-loader.ts";
import { createUrlMode } from "./lib/url-mode.ts";
import { createFolder } from "./lib/folder.ts";
import { createNavigation } from "./lib/navigation.ts";
import { createDnd } from "./lib/dnd.ts";

const { convertAdoc, convertMarkdown } = createConverter(new ConvertWorker());

export function App() {
  // Determine operating mode on mount
  const sourceUrl = getUrlParam();
  const isUrlMode = !!sourceUrl;

  const state = createAppState({
    applyTheme,
    convertAdoc,
    convertMarkdown,
    getStoredTheme,
  });

  // Override canGoBack/canGoForward — extension uses browser history, not context stack
  const canGoBack = () => state.navIndex() > 0;
  const canGoForward = () => state.navIndex() < state.navStack().length - 1;

  // Extension-specific state
  const [rootHandle, setRootHandle] =
    createSignal<FileSystemDirectoryHandle | null>(null);
  const [rootHandles, setRootHandles] =
    createSignal<Map<string, FileSystemDirectoryHandle>>(new Map());
  const [fallbackFileMap, setFallbackFileMap] =
    createSignal<Map<string, File> | null>(null);
  const [urlFileName, setUrlFileName] = createSignal("");
  const [, setUrlError] = createSignal<string | null>(null);
  const [fileAccessDenied, setFileAccessDenied] = createSignal(false);

  // File watcher (folder mode only — watches current file + includes)
  const watcher = new FileWatcher(() => {
    const file = state.selectedFile();
    if (file) loader.loadFileContent(file, false, true);
  });

  // Create modules
  const loader = createFileLoader({ fallbackFileMap, rootHandle, rootHandles, state, watcher });

  const urlMode = createUrlMode({ setFileAccessDenied, setUrlError, setUrlFileName, state });

  const folder = createFolder({
    fallbackFileMap,
    loadFileContent: loader.loadFileContent,
    rootHandle,
    rootHandles,
    setFallbackFileMap,
    setRootHandle,
    setRootHandles,
    state,
  });

  const navigation = createNavigation({
    canGoBack,
    canGoForward,
    fallbackFileMap,
    isUrlMode,
    loadFileContent: loader.loadFileContent,
    rootHandle,
    rootHandles,
    sourceUrl,
    state,
  });

  const dnd = createDnd({
    isUrlMode,
    loadFileContent: loader.loadFileContent,
    rootHandles,
    setFallbackFileMap,
    setRootHandle,
    setRootHandles,
    state,
  });

  // Toggle auto-refresh (folder mode watcher)
  createEffect(() => {
    if (isUrlMode) return;
    if (!rootHandle() && rootHandles().size === 0) return;
    if (state.autoRefresh()) {
      watcher.start();
    } else {
      watcher.stop();
    }
  });

  onCleanup(() => {
    watcher.destroy();
    urlMode.cleanup();
    navigation.cleanup();
  });

  // Initialize
  if (isUrlMode) {
    urlMode.initUrlMode(sourceUrl!);
  } else {
    folder.initFolderMode();
  }

  const hasRoot = () => !!rootHandle() || rootHandles().size > 0 || !!fallbackFileMap();

  return (
    <AppShell
      state={state}
      hasRoot={hasRoot()}
      showEditorTabs={false}
      showNavButtons={!isUrlMode && hasRoot()}
      showPdfExport={false}
      showSidebar={!isUrlMode && state.sidebarVisible() && hasRoot()}
      showToolbar={isUrlMode || hasRoot()}
      toolbarFilePath={isUrlMode ? displayPathFromUrl(sourceUrl!) : (state.selectedFile()?.path ?? null)}
      toolbarRootName={isUrlMode ? "" : state.rootName()}
      contentWrapper={(content) => (
        <Show when={!fileAccessDenied()} fallback={<FileAccessWarning url={sourceUrl!} />}>
          {content}
        </Show>
      )}
      onCloseRoot={(rootId) => folder.closeRoot(rootId)}
      onDragLeave={dnd.handleDragLeave}
      onDragOver={dnd.handleDragOver}
      onDrop={dnd.handleDrop}
      onGoBack={navigation.handleGoBack}
      onGoForward={navigation.handleGoForward}
      onLoadFile={(entry, rootId) => loader.loadFileContent(entry, true, false, rootId)}
      onNavigate={navigation.handleNavigate}
      onRefreshRoot={(rootId) => folder.refreshRoot(rootId)}
      onReorderRoots={(newOrder) => state.reorderRoots(newOrder)}
    />
  );
}
