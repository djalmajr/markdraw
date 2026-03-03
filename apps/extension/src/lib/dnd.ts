import type { Accessor, Setter } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import { isSupportedFile } from "@asciimark/core/utils.ts";
import type { AppState } from "@asciimark/ui/composables/create-app-state.ts";
import { setHashFromPath } from "./hash.ts";
import {
  readTree,
  saveDirectoryHandles,
  buildTreeFromFiles,
  buildFileMap,
} from "./fs.ts";

interface DndDeps {
  isUrlMode: boolean;
  loadFileContent: (entry: FSEntry, pushHistory?: boolean, force?: boolean, rootId?: string) => Promise<void>;
  rootHandles: Accessor<Map<string, FileSystemDirectoryHandle>>;
  setFallbackFileMap: Setter<Map<string, File> | null>;
  setRootHandle: Setter<FileSystemDirectoryHandle | null>;
  setRootHandles: Setter<Map<string, FileSystemDirectoryHandle>>;
  state: AppState;
}

export function createDnd(deps: DndDeps) {
  const { isUrlMode, loadFileContent, setFallbackFileMap, setRootHandle, setRootHandles, state } = deps;

  function hasExternalFilePayload(e: DragEvent): boolean {
    const dataTransfer = e.dataTransfer;
    if (!dataTransfer) return false;
    return Array.from(dataTransfer.types).includes("Files");
  }

  function handleDragOver(e: DragEvent) {
    if (!hasExternalFilePayload(e)) return;
    e.preventDefault();
    state.setDragOver(true);
  }

  function handleDragLeave() {
    state.setDragOver(false);
  }

  async function handleDrop(e: DragEvent) {
    if (!hasExternalFilePayload(e)) {
      state.setDragOver(false);
      return;
    }

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
          const rootId = handle.name;

          // Add handle to rootHandles
          setRootHandles((prev) => {
            const next = new Map(prev);
            next.set(rootId, handle);
            return next;
          });

          // Keep backward compat rootHandle
          setRootHandle(handle);
          setFallbackFileMap(null);

          // Add as a new root
          state.addRoot({
            collapsed: false,
            entries: [],
            id: rootId,
            name: handle.name,
          });
          state.setSelectedRootId(rootId);

          // Persist all handles
          await saveDirectoryHandles(deps.rootHandles());

          // Load entries
          state.setLoading(true);
          const entries = await readTree(handle);
          state.updateRootEntries(rootId, entries);
          state.setLoading(false);

          state.setSelectedFile(null);
          state.setHtml("");
          setHashFromPath(null);
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
