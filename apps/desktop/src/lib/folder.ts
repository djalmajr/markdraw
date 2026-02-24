import type { Accessor, Setter } from "solid-js";
import type { AppState } from "@asciimark/ui/composables/create-app-state.ts";
import { openDirectory, readTree, writeFile } from "./fs.ts";
import type { FileWatcher } from "./watcher.ts";

interface FolderDeps {
  resetNavigation: () => void;
  rootPath: Accessor<string | null>;
  setRootPath: Setter<string | null>;
  state: AppState;
  watcher: FileWatcher;
}

export function createFolder(deps: FolderDeps) {
  const { resetNavigation, rootPath, setRootPath, state, watcher } = deps;

  function getPathName(path: string) {
    const normalizedPath = path.replace(/\\/g, "/");
    const parts = normalizedPath.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? normalizedPath;
  }

  async function openFolderPath(path: string): Promise<boolean> {
    try {
      state.setLoading(true);
      const entries = await readTree(path);
      setRootPath(path);
      state.setRootName(getPathName(path));
      state.setTree(entries);
      state.setSidebarVisible(true);
      state.setShowAllDirs(false);
      state.setShowAllFiles(false);
      state.resetState();
      resetNavigation();
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

  async function refreshTree() {
    const root = rootPath();
    if (!root) return;
    try {
      const entries = await readTree(root);
      const currentPath = state.selectedFile()?.path;
      state.setTree(entries);

      // If selected file was deleted, clear the selection
      if (currentPath && !state.findEntryByPath(currentPath)) {
        state.setSelectedFile(null);
        state.setHtml("");
      }
    } catch (e) {
      console.error("Failed to refresh tree:", e);
    }
  }

  function handleCloseFolder() {
    setRootPath(null);
    state.resetState();
    state.setRootName("");
    state.setTree([]);
    resetNavigation();
    watcher.destroy();
  }

  async function handleEditorSave() {
    const entry = state.selectedFile();
    const root = rootPath();
    if (!entry || !root) return;

    try {
      const absolutePath = `${root}/${entry.path}`;
      const content = state.editorContent();
      await writeFile(absolutePath, content);
      state.setSavedContent(content);
    } catch (e) {
      console.error("Failed to save file:", e);
    }
  }

  return {
    handleCloseFolder,
    handleEditorSave,
    handleOpenFolder,
    openFolderPath,
    refreshTree,
  };
}
