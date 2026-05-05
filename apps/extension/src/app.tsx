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
  // Shortcuts-help modal toggle. The extension doesn't bind Cmd+/ to
  // open it (no global keydown handler here), so the only entry points
  // are the toolbar menu's "Keyboard shortcuts" item and the
  // discoverability ghost button on the welcome screen.
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = createSignal(false);

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

  // Reload the active doc. URL mode re-fetches the source; folder mode
  // forces a re-read from disk via the loader. No-op when nothing's
  // loaded — the toolbar button is gated on `hasFile` already.
  function handleReload() {
    if (isUrlMode && sourceUrl) {
      void urlMode.initUrlMode(sourceUrl);
      return;
    }
    const file = state.selectedFile();
    if (file) {
      void loader.loadFileContent(file, false, true);
    }
  }

  // Copy the source URL to the clipboard. Strips query parameters so
  // ephemeral auth tokens (e.g. GitHub's `?token=GHSAT...` on raw URLs
  // from private repos) don't get pasted into chat messages, issues,
  // or shared docs. Reasoning: a token in the URL is short-lived but
  // still grants read access to the underlying file while it's alive,
  // and copy/paste is the most common way it gets shared by accident.
  function handleCopySource() {
    if (!isUrlMode || !sourceUrl) return;
    let toCopy = sourceUrl;
    try {
      const u = new URL(sourceUrl);
      u.search = "";
      u.hash = "";
      toCopy = u.toString();
    } catch {
      // sourceUrl isn't a valid URL — fall back to the raw value.
    }
    void navigator.clipboard?.writeText(toCopy);
  }

  // Copy the raw text content (markdown/asciidoc source) — what was
  // fetched from the URL or read from disk. Useful for pasting into
  // editors or chat without going through the original source.
  function handleCopyContent() {
    const content = state.editorContent();
    if (!content) return;
    void navigator.clipboard?.writeText(content);
  }

  return (
    <AppShell
      state={state}
      hasRoot={hasRoot()}
      enableSplit={false}
      showEditorTabs={false}
      showNavButtons={!isUrlMode && hasRoot()}
      showPdfExport={false}
      showFileTreeItemMenu={false}
      showRecentHistory={!isUrlMode}
      showSidebar={!isUrlMode && state.sidebarVisible() && hasRoot()}
      showToolbar={true}
      onCopyContent={handleCopyContent}
      onCopySource={isUrlMode ? handleCopySource : undefined}
      onOpenFolder={!isUrlMode ? folder.handleOpenFolder : undefined}
      onReload={handleReload}
      shortcutsHelpOpen={shortcutsHelpOpen()}
      onShortcutsHelpOpen={() => setShortcutsHelpOpen(true)}
      onShortcutsHelpClose={() => setShortcutsHelpOpen(false)}
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
      onToggleShowHiddenEntries={(enabled) => folder.refreshAllRoots(enabled)}
      onRefreshRoot={(rootId) => folder.refreshRoot(rootId)}
      onReorderRoots={(newOrder) => state.reorderRoots(newOrder)}
    />
  );
}
