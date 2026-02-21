import type { Accessor, Setter } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import type { AppState } from "@asciimark/ui/composables/create-app-state.ts";
import { openDirectory, readTree, writeFile } from "./fs.ts";
import type { FileWatcher } from "./watcher.ts";

interface FolderDeps {
  loadFileContent: (entry: FSEntry, pushHistory?: boolean) => Promise<void>;
  resetNavigation: () => void;
  rootPath: Accessor<string | null>;
  setRootPath: Setter<string | null>;
  state: AppState;
  watcher: FileWatcher;
}

export function createFolder(deps: FolderDeps) {
  const { loadFileContent, resetNavigation, rootPath, setRootPath, state, watcher } = deps;

  async function handleOpenFolder() {
    try {
      const path = await openDirectory();
      if (!path) return;

      setRootPath(path);
      const parts = path.replace(/\\/g, "/").split("/");
      state.setRootName(parts[parts.length - 1] ?? path);
      state.setLoading(true);
      const entries = await readTree(path);
      state.setTree(entries);
      state.setLoading(false);
      state.setSidebarVisible(true);
      state.setSelectedFile(null);
      state.setHtml("");
      state.setNavStack([]);
      state.setNavIndex(-1);
    } catch (e) {
      console.error("Failed to open directory:", e);
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

  return { handleCloseFolder, handleEditorSave, handleOpenFolder };
}
