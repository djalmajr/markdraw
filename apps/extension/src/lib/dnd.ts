import type { Setter } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import { isSupportedFile } from "@asciimark/core/utils.ts";
import type { AppState } from "@asciimark/ui/composables/create-app-state.ts";
import { setHashFromPath } from "./hash.ts";
import {
  readTree,
  saveDirectoryHandle,
  buildTreeFromFiles,
  buildFileMap,
} from "./fs.ts";

interface DndDeps {
  isUrlMode: boolean;
  loadFileContent: (entry: FSEntry, pushHistory?: boolean) => Promise<void>;
  setFallbackFileMap: Setter<Map<string, File> | null>;
  setRootHandle: Setter<FileSystemDirectoryHandle | null>;
  state: AppState;
}

export function createDnd(deps: DndDeps) {
  const { isUrlMode, loadFileContent, setFallbackFileMap, setRootHandle, state } = deps;

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    state.setDragOver(true);
  }

  function handleDragLeave() {
    state.setDragOver(false);
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    state.setDragOver(false);
    if (isUrlMode) return;

    const items = e.dataTransfer?.items;
    if (!items || items.length === 0) return;

    const firstItem = items[0];

    // Try native FileSystemHandle (Chrome/Edge)
    if ("getAsFileSystemHandle" in firstItem) {
      try {
        const handle = await (firstItem as any).getAsFileSystemHandle();
        if (handle.kind === "directory") {
          setRootHandle(handle);
          state.setRootName(handle.name);
          setFallbackFileMap(null);
          await saveDirectoryHandle(handle);
          state.setLoading(true);
          const entries = await readTree(handle);
          state.setTree(entries);
          state.setLoading(false);
          state.setSelectedFile(null);
          state.setHtml("");
          setHashFromPath(null);
          state.setNavStack([]);
          state.setNavIndex(-1);
          return;
        }
        if (handle.kind === "file") {
          const file = await handle.getFile();
          if (isSupportedFile(file.name)) {
            const entry: FSEntry = { name: file.name, kind: "file", path: file.name, handle };
            setRootHandle(null);
            setFallbackFileMap(null);
            state.setRootName("");
            state.setTree([entry]);
            loadFileContent(entry);
          }
          return;
        }
      } catch {
        // Fall through to File fallback
      }
    }

    // Fallback: use File objects
    const file = firstItem.getAsFile();
    if (file && isSupportedFile(file.name)) {
      const entry: FSEntry = { name: file.name, kind: "file", path: file.name, file };
      setRootHandle(null);
      setFallbackFileMap(null);
      state.setRootName("");
      state.setTree([entry]);
      loadFileContent(entry);
    }
  }

  return { handleDragLeave, handleDragOver, handleDrop };
}
