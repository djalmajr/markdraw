import type { Accessor, Setter } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import type { AppState } from "@asciimark/ui/composables/create-app-state.ts";
import { getPathFromHash, setHashFromPath } from "./hash.ts";
import {
  openDirectory,
  openDirectoryFallback,
  buildTreeFromFiles,
  buildFileMap,
  readTree,
  saveDirectoryHandle,
  loadDirectoryHandle,
  hasNativePicker,
} from "./fs.ts";

interface FolderDeps {
  fallbackFileMap: Accessor<Map<string, File> | null>;
  loadFileContent: (entry: FSEntry, pushHistory?: boolean) => Promise<void>;
  rootHandle: Accessor<FileSystemDirectoryHandle | null>;
  setFallbackFileMap: Setter<Map<string, File> | null>;
  setRootHandle: Setter<FileSystemDirectoryHandle | null>;
  state: AppState;
}

export function createFolder(deps: FolderDeps) {
  const { loadFileContent, setFallbackFileMap, setRootHandle, state } = deps;

  async function initFolderMode() {
    // Fallback mode has no persistence
    if (!hasNativePicker) return;

    const saved = await loadDirectoryHandle();
    if (!saved) return;

    try {
      const perm = await (saved as any).requestPermission({ mode: "read" });
      if (perm !== "granted") return;

      setRootHandle(saved);
      state.setRootName(saved.name);
      state.setLoading(true);
      const entries = await readTree(saved);
      state.setTree(entries);
      state.setLoading(false);

      // Restore file from URL hash
      const hashPath = getPathFromHash();
      if (hashPath) {
        const entry = state.findEntryByPath(hashPath);
        if (entry && entry.kind === "file") {
          loadFileContent(entry);
        }
      }
    } catch {
      setRootHandle(null);
      state.setTree([]);
      state.setRootName("");
    }
  }

  async function handleOpenFolder() {
    try {
      if (hasNativePicker) {
        const handle = await openDirectory();
        setRootHandle(handle);
        state.setRootName(handle.name);
        setFallbackFileMap(null);
        await saveDirectoryHandle(handle);
        state.setLoading(true);
        const entries = await readTree(handle);
        state.setTree(entries);
        state.setLoading(false);
      } else {
        const { rootName: name, files } = await openDirectoryFallback();
        const { entries } = buildTreeFromFiles(files);
        const fileMap = buildFileMap(files);
        setRootHandle(null);
        setFallbackFileMap(fileMap);
        state.setRootName(name);
        state.setTree(entries);
      }
      state.setSelectedFile(null);
      state.setHtml("");
      state.setSavedContent("");
      state.clearToc();
      setHashFromPath(null);
      state.setNavStack([]);
      state.setNavIndex(-1);
    } catch (e: any) {
      if (e.name === "AbortError") return;
      if (e instanceof DOMException) {
        console.info("Open Folder requires a direct click. Try the button on the empty state page.");
      } else {
        console.error("Failed to open directory:", e);
      }
    }
  }

  async function handleEditorSave() {
    const entry = state.selectedFile();
    const root = deps.rootHandle();
    if (!entry || !root || !entry.handle) return;

    try {
      const handle = entry.handle as FileSystemFileHandle;
      const writable = await (handle as any).createWritable();
      await writable.write(state.editorContent());
      await writable.close();
      state.setSavedContent(state.editorContent());
    } catch (e) {
      console.error("Failed to save file:", e);
    }
  }

  return { handleEditorSave, handleOpenFolder, initFolderMode };
}
