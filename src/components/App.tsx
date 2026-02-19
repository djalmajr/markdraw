import { createSignal, createEffect, onCleanup, Show } from "solid-js";
import {
  openDirectory,
  readTree,
  readFileContent,
  readFileByPath,
  saveDirectoryHandle,
  loadDirectoryHandle,
  type FSEntry,
} from "../lib/fs.ts";
import { convertAdoc, getIncludePaths } from "../lib/asciidoc.ts";
import { FileWatcher } from "../lib/watcher.ts";
import { Toolbar } from "./Toolbar.tsx";
import { FileTree } from "./FileTree.tsx";
import { Preview } from "./Preview.tsx";
import { EmptyState } from "./EmptyState.tsx";

export function App() {
  const [rootHandle, setRootHandle] =
    createSignal<FileSystemDirectoryHandle | null>(null);
  const [tree, setTree] = createSignal<FSEntry[]>([]);
  const [selectedFile, setSelectedFile] = createSignal<FSEntry | null>(null);
  const [html, setHtml] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [autoRefresh, setAutoRefresh] = createSignal(true);
  const [sidebarWidth, setSidebarWidth] = createSignal(280);
  const [sidebarVisible, setSidebarVisible] = createSignal(true);
  const [tocVisible, setTocVisible] = createSignal(true);
  const [rootName, setRootName] = createSignal("");

  const watcher = new FileWatcher(() => {
    // On file change, re-render the current file
    const file = selectedFile();
    if (file) loadFileContent(file);
  });

  onCleanup(() => watcher.destroy());

  // Try to restore saved directory handle on mount
  (async () => {
    const saved = await loadDirectoryHandle();
    if (saved) {
      try {
        // Verify permission
        const perm = await (saved as any).queryPermission({ mode: "read" });
        if (perm === "granted") {
          setRootHandle(saved);
          setRootName(saved.name);
          const entries = await readTree(saved);
          setTree(entries);
        }
      } catch {
        // Permission denied or handle invalid
      }
    }
  })();

  // Toggle auto-refresh
  createEffect(() => {
    if (autoRefresh()) {
      watcher.start();
    } else {
      watcher.stop();
    }
  });

  async function handleOpenFolder() {
    try {
      const handle = await openDirectory();
      setRootHandle(handle);
      setRootName(handle.name);
      await saveDirectoryHandle(handle);
      setLoading(true);
      const entries = await readTree(handle);
      setTree(entries);
      setLoading(false);
      setSelectedFile(null);
      setHtml("");
    } catch (e: any) {
      if (e.name !== "AbortError") {
        console.error("Failed to open directory:", e);
      }
    }
  }

  async function loadFileContent(entry: FSEntry) {
    const root = rootHandle();
    if (!root || entry.kind !== "file") return;

    setSelectedFile(entry);
    setLoading(true);

    try {
      const content = await readFileContent(
        entry.handle as FileSystemFileHandle,
      );

      const readFile = (path: string) => readFileByPath(root, path);

      const result = await convertAdoc({
        filePath: entry.path,
        fileContent: content,
        readFile,
      });

      setHtml(result);

      // Update watcher target
      const baseDirPath = entry.path.includes("/")
        ? entry.path.substring(0, entry.path.lastIndexOf("/"))
        : "";
      const includePaths = getIncludePaths(content, baseDirPath);
      watcher.setTarget({
        fileHandle: entry.handle as FileSystemFileHandle,
        includePaths,
        rootHandle: root,
      });

      if (autoRefresh()) {
        watcher.start();
      }
    } catch (e) {
      console.error("Failed to convert file:", e);
      setHtml(`<div class="error">Error converting file: ${e}</div>`);
    } finally {
      setLoading(false);
    }
  }

  function handleExportPdf() {
    window.print();
  }

  // Sidebar resize logic
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

  return (
    <div class="app">
      <Toolbar
        rootName={rootName()}
        fileName={selectedFile()?.name ?? null}
        filePath={selectedFile()?.path ?? null}
        autoRefresh={autoRefresh()}
        onToggleAutoRefresh={() => setAutoRefresh((v) => !v)}
        sidebarVisible={sidebarVisible()}
        tocVisible={tocVisible()}
        onToggleSidebar={() => setSidebarVisible((v) => !v)}
        onToggleToc={() => setTocVisible((v) => !v)}
        onOpenFolder={handleOpenFolder}
        onExportPdf={handleExportPdf}
        hasFile={!!selectedFile()}
      />
      <div class="main">
        <Show when={rootHandle() && sidebarVisible()}>
          <aside class="sidebar" style={{ width: `${sidebarWidth()}px` }}>
            <FileTree
              entries={tree()}
              selectedPath={selectedFile()?.path ?? null}
              onSelect={loadFileContent}
            />
          </aside>
          <div class="resize-handle" onMouseDown={onResizeStart} />
        </Show>
        <div class="content">
          <Show when={selectedFile()} fallback={<EmptyState hasRoot={!!rootHandle()} onOpenFolder={handleOpenFolder} />}>
            <Preview html={html()} loading={loading()} tocVisible={tocVisible()} />
          </Show>
        </div>
      </div>
    </div>
  );
}
