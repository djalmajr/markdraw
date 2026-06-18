import type { Accessor, Setter } from "solid-js";
import type { FSEntry } from "@markdraw/core/types.ts";
import type { AppState } from "@markdraw/ui/composables/create-app-state.ts";
import { getPathFromHash, setHashFromPath } from "./hash.ts";
import {
  openDirectory,
  openDirectoryFallback,
  buildTreeFromFiles,
  buildFileMap,
  readTree,
  saveDirectoryHandle,
  saveDirectoryHandles,
  loadDirectoryHandles,
  hasNativePicker,
} from "./fs.ts";

interface FolderDeps {
  fallbackFileMap: Accessor<Map<string, File> | null>;
  loadFileContent: (entry: FSEntry, pushHistory?: boolean, force?: boolean, rootId?: string) => Promise<void>;
  rootHandle: Accessor<FileSystemDirectoryHandle | null>;
  rootHandles: Accessor<Map<string, FileSystemDirectoryHandle>>;
  setFallbackFileMap: Setter<Map<string, File> | null>;
  setRootHandle: Setter<FileSystemDirectoryHandle | null>;
  setRootHandles: Setter<Map<string, FileSystemDirectoryHandle>>;
  state: AppState;
}

export function createFolder(deps: FolderDeps) {
  const { loadFileContent, setFallbackFileMap, setRootHandle, setRootHandles, state } = deps;
  let fallbackFiles: File[] | null = null;

  async function initFolderMode() {
    // Fallback mode has no persistence
    if (!hasNativePicker) return;

    const saved = await loadDirectoryHandles();
    if (saved.size === 0) return;

    let firstId: string | null = null;

    for (const [id, handle] of saved) {
      try {
        const perm = await (handle as any).requestPermission({ mode: "read" });
        if (perm !== "granted") continue;

        if (!firstId) firstId = id;

        state.addRoot({
          collapsed: false,
          entries: [],
          id,
          name: handle.name,
        });
      } catch {
        // Skip handles we can't get permission for
        continue;
      }
    }

    if (!firstId) return;

    // Set the first root as selected
    state.setSelectedRootId(firstId);

    // Update rootHandles signal with all permitted handles
    const permittedHandles = new Map<string, FileSystemDirectoryHandle>();
    for (const [id] of saved) {
      if (state.roots().has(id)) {
        permittedHandles.set(id, saved.get(id)!);
      }
    }
    setRootHandles(permittedHandles);

    // Keep backward compat rootHandle pointing to the selected root
    setRootHandle(permittedHandles.get(firstId) ?? null);

    // Load entries for all roots
    state.setLoading(true);
    for (const [id, handle] of permittedHandles) {
      try {
        const entries = await readTree(handle, "", state.showHiddenEntries());
        state.updateRootEntries(id, entries);
      } catch {
        // Skip roots that fail to read
      }
    }
    state.setLoading(false);

    // Restore file from URL hash
    const hashPath = getPathFromHash();
    if (hashPath) {
      const entry = state.findEntryByPath(hashPath);
      if (entry && entry.kind === "file") {
        loadFileContent(entry, false, false, firstId);
      }
    }
  }

  async function handleOpenFolder() {
    try {
      if (hasNativePicker) {
        const handle = await openDirectory();
        const rootId = handle.name;

        // Add the handle to rootHandles map
        setRootHandles((prev) => {
          const next = new Map(prev);
          next.set(rootId, handle);
          return next;
        });

        // Keep backward compat rootHandle pointing to last opened
        setRootHandle(handle);
        setFallbackFileMap(null);
        fallbackFiles = null;

        // Add root to state
        state.addRoot({
          collapsed: false,
          entries: [],
          id: rootId,
          name: handle.name,
        });
        state.setSelectedRootId(rootId);

        // Persist all handles
        await saveDirectoryHandles(deps.rootHandles());

        // Also save as legacy single handle for backward compat
        await saveDirectoryHandle(handle);

        // Load entries
        state.setLoading(true);
        const entries = await readTree(handle, "", state.showHiddenEntries());
        state.updateRootEntries(rootId, entries);
        state.setLoading(false);
      } else {
        const { rootName: name, files } = await openDirectoryFallback();
        fallbackFiles = files;
        const { entries } = buildTreeFromFiles(files, state.showHiddenEntries());
        const fileMap = buildFileMap(files);
        const rootId = name;

        setRootHandle(null);
        setFallbackFileMap(fileMap);

        state.addRoot({
          collapsed: false,
          entries,
          id: rootId,
          name,
        });
        state.setSelectedRootId(rootId);
      }

      state.setSelectedFile(null);
      state.setHtml("");
      state.setSavedContent("");
      state.clearToc();
      setHashFromPath(null);
    } catch (e: any) {
      if (e.name === "AbortError") return;
      if (e instanceof DOMException) {
        console.info("Open Folder requires a direct click. Try the button on the empty state page.");
      } else {
        console.error("Failed to open directory:", e);
      }
    }
  }

  async function refreshRoot(rootId: string) {
    const handle = deps.rootHandles().get(rootId);
    if (!handle) return;
    try {
      const newEntries = await readTree(handle, "", state.showHiddenEntries());
      const currentPath = state.selectedFile()?.path;
      state.updateRootEntries(rootId, newEntries);

      // If selected file was in this root and was deleted, clear the selection
      if (
        currentPath &&
        state.selectedRootId() === rootId &&
        !state.findEntryByPath(currentPath, rootId)
      ) {
        state.setSelectedFile(null);
        state.setHtml("");
      }
    } catch (e) {
      console.error("Failed to refresh root:", e);
    }
  }

  async function refreshAllRoots(includeHiddenEntries: boolean) {
    const handles = deps.rootHandles();
    const ids = Array.from(handles.keys());

    await Promise.allSettled(ids.map(async (rootId) => {
      const handle = handles.get(rootId);
      if (!handle) return;

      const entries = await readTree(handle, "", includeHiddenEntries);
      const currentPath = state.selectedFile()?.path;
      state.updateRootEntries(rootId, entries);

      if (currentPath && state.selectedRootId() === rootId && !state.findEntryByPath(currentPath, rootId)) {
        state.setSelectedFile(null);
        state.setHtml("");
      }
    }));

    if (handles.size === 0 && fallbackFiles && state.selectedRootId()) {
      const rootId = state.selectedRootId()!;
      const { entries } = buildTreeFromFiles(fallbackFiles, includeHiddenEntries);
      const currentPath = state.selectedFile()?.path;
      state.updateRootEntries(rootId, entries);
      if (currentPath && !state.findEntryByPath(currentPath, rootId)) {
        state.setSelectedFile(null);
        state.setHtml("");
      }
    }
  }

  function closeRoot(rootId: string) {
    // Remove handle from map
    setRootHandles((prev) => {
      const next = new Map(prev);
      next.delete(rootId);
      return next;
    });

    // Remove from state
    state.removeRoot(rootId);

    // Persist updated handles
    saveDirectoryHandles(deps.rootHandles());

    // Update backward compat rootHandle
    const remaining = deps.rootHandles();
    if (remaining.size > 0) {
      const [firstId, firstHandle] = remaining.entries().next().value!;
      setRootHandle(firstHandle);
      if (!state.selectedRootId()) {
        state.setSelectedRootId(firstId);
      }
    } else {
      setRootHandle(null);
      if (deps.rootHandles().size === 0) {
        fallbackFiles = null;
      }
    }
  }

  async function handleEditorSave() {
    const entry = state.selectedFile();
    const targetRootId = state.selectedRootId();
    const root = targetRootId ? deps.rootHandles().get(targetRootId) : deps.rootHandle();
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

  return { closeRoot, handleEditorSave, handleOpenFolder, initFolderMode, refreshAllRoots, refreshRoot };
}
