import type { Accessor, Setter } from "solid-js";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import type { FSEntry } from "@asciimark/core/types.ts";
import type { AppState } from "@asciimark/ui/composables/create-app-state.ts";
import { openDirectory, readTree, renameFile, writeFile } from "./fs.ts";
import type { FileWatcher } from "./watcher.ts";

interface FolderDeps {
  rootPaths: Accessor<Map<string, string>>;
  setRootPaths: Setter<Map<string, string>>;
  state: AppState;
  watcher: FileWatcher;
}

export function createFolder(deps: FolderDeps) {
  const { rootPaths, setRootPaths, state, watcher } = deps;

  function getPathName(path: string) {
    const normalizedPath = path.replace(/\\/g, "/");
    const parts = normalizedPath.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? normalizedPath;
  }

  async function openFolderPath(path: string): Promise<boolean> {
    // If this root is already open, just select it
    if (rootPaths().has(path)) {
      state.setSelectedRootId(path);
      return true;
    }

    try {
      state.setLoading(true);
      const entries = await readTree(path, state.showHiddenEntries());

      // Add to rootPaths map
      setRootPaths((prev) => {
        const next = new Map(prev);
        next.set(path, path);
        return next;
      });

      // Add root to state
      state.addRoot({
        collapsed: false,
        entries,
        id: path,
        name: getPathName(path),
      });

      state.setSelectedRootId(path);
      state.setSidebarVisible(true);
      state.setShowAllDirs(false);
      state.setShowAllFiles(false);
      state.pushRecentFolder(path);
      return true;
    } catch (e) {
      console.error("Failed to open directory:", e);
      return false;
    } finally {
      state.setLoading(false);
    }
  }

  async function handleOpenFolder() {
    try {
      const path = await openDirectory();
      if (!path) return;

      await openFolderPath(path);
    } catch (e) {
      console.error("Failed to open directory:", e);
    }
  }

  async function refreshRoot(rootId: string) {
    const rootPath = rootPaths().get(rootId);
    if (!rootPath) return;
    try {
      const entries = await readTree(rootPath, state.showHiddenEntries());
      const currentPath = state.selectedFile()?.path;
      state.updateRootEntries(rootId, entries);

      // If selected file was in this root and was deleted, clear the selection
      if (currentPath && state.selectedRootId() === rootId && !state.findEntryByPath(currentPath, rootId)) {
        state.setSelectedFile(null);
        state.setHtml("");
      }
    } catch (e) {
      console.error("Failed to refresh root:", e);
    }
  }

  async function refreshAllRoots(includeHiddenEntries: boolean) {
    const ids = Array.from(rootPaths().keys());
    await Promise.allSettled(ids.map(async (rootId) => {
      const rootPath = rootPaths().get(rootId);
      if (!rootPath) return;

      const entries = await readTree(rootPath, includeHiddenEntries);
      const currentPath = state.selectedFile()?.path;
      state.updateRootEntries(rootId, entries);

      if (currentPath && state.selectedRootId() === rootId && !state.findEntryByPath(currentPath, rootId)) {
        state.setSelectedFile(null);
        state.setHtml("");
      }
    }));
  }

  function handleCloseRoot(rootId: string) {
    // Remove from rootPaths map
    setRootPaths((prev) => {
      const next = new Map(prev);
      next.delete(rootId);
      return next;
    });

    // Remove from state (this handles selectedRootId cleanup)
    state.removeRoot(rootId);

    // If no roots left, destroy watcher
    if (rootPaths().size === 0) {
      watcher.destroy();
    }
  }

  async function handleEditorSave() {
    const entry = state.selectedFile();
    const rootId = state.selectedRootId();
    const rootPath = rootId ? rootPaths().get(rootId) : null;
    if (!entry || !rootPath) return;

    try {
      const absolutePath = `${rootPath}/${entry.path}`;
      const content = state.editorContent();
      await writeFile(absolutePath, content);
      state.setSavedContent(content);
    } catch (e) {
      console.error("Failed to save file:", e);
    }
  }

  async function handleCopyPath(entry: FSEntry, rootId: string): Promise<void> {
    const rootPath = rootPaths().get(rootId);
    if (!rootPath) return;
    // Build the absolute filesystem path. The workspace root id IS the
    // absolute path on desktop, so we just join with the entry's relative path.
    const absolutePath = entry.path ? `${rootPath}/${entry.path}` : rootPath;
    try {
      // Tauri's clipboard plugin is more reliable than navigator.clipboard
      // inside the webview (which can fail silently in some focus contexts).
      await clipboardWriteText(absolutePath);
    } catch (e) {
      console.error("Failed to copy path:", e);
    }
  }

  async function handleRename(entry: FSEntry, rootId: string, newName: string): Promise<void> {
    const rootPath = rootPaths().get(rootId);
    if (!rootPath) throw new Error("Root not found");

    // Build new relative path: keep the parent directory, swap the basename
    const slash = entry.path.lastIndexOf("/");
    const parentRel = slash >= 0 ? entry.path.slice(0, slash + 1) : "";
    const newRelative = parentRel + newName;
    if (newRelative === entry.path) return;

    await renameFile(rootPath, entry.path, newRelative);

    // If the renamed entry is (or contains) the open file, rewrite its path
    const sel = state.selectedFile();
    if (sel && state.selectedRootId() === rootId) {
      if (sel.path === entry.path) {
        state.setSelectedFile({ ...sel, path: newRelative, name: newName });
      } else if (sel.path.startsWith(entry.path + "/")) {
        const newSelPath = newRelative + sel.path.slice(entry.path.length);
        state.setSelectedFile({ ...sel, path: newSelPath });
      }
    }

    await refreshRoot(rootId);
  }

  return {
    getPathName,
    handleCloseRoot,
    handleCopyPath,
    handleEditorSave,
    handleOpenFolder,
    handleRename,
    openFolderPath,
    refreshAllRoots,
    refreshRoot,
  };
}
