import type { Accessor, Setter } from "solid-js";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { FSEntry } from "@asciimark/core/types.ts";
import type { AppState } from "@asciimark/ui/composables/create-app-state.ts";
import { copyPath, createDir, createFile, movePath, openDirectory, readTree, renameFile, trashPath, writeFile } from "./fs.ts";
import { joinRelative, nextAvailableName, withDefaultExtension } from "./fs-paths.ts";
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
    // Normalize to forward slashes so Windows paths match the events emitted
    // by the Rust watcher (which also normalizes slashes).
    path = path.replace(/\\/g, "/");

    // If this root is already open, just select it
    if (rootPaths().has(path)) {
      state.setSelectedRootId(path);
      return true;
    }

    try {
      state.setLoading(true);
      const entries = await readTree(
        path,
        state.showHiddenEntries(),
        state.respectGitignore(),
      );

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
    // Pin the per-doc target BEFORE the await so the cleanup below
    // writes to the same pane that observed the stale selectedFile.
    // The AppState proxy resolves `paneManager.activePane()` on each
    // call — if the user flips panes mid-read, naive `state.setHtml`
    // would clear the wrong pane's preview. See wiki Round 4 Lesson 6.
    const targetPane = state.paneManager.activePane();
    try {
      const entries = await readTree(
        rootPath,
        state.showHiddenEntries(),
        state.respectGitignore(),
      );
      const currentPath = targetPane.selectedFile()?.path;
      state.updateRootEntries(rootId, entries);

      // If selected file was in this root and was deleted, clear the selection
      if (currentPath && targetPane.selectedRootId() === rootId && !state.findEntryByPath(currentPath, rootId)) {
        targetPane.setSelectedFile(null);
        targetPane.setHtml("");
      }
    } catch (e) {
      console.error("Failed to refresh root:", e);
    }
  }

  /**
   * Re-read every workspace root from disk. Reads the current values
   * of `showHiddenEntries` and `respectGitignore` from state at call
   * time — callers used to pass `includeHiddenEntries` as a
   * parameter, but that diverged from `refreshRoot`'s state-driven
   * path. Reading the toggles inline keeps the two refresh entry
   * points consistent and is required for the new `respectGitignore`
   * toggle to take effect when re-reading.
   */
  async function refreshAllRoots() {
    const includeHiddenEntries = state.showHiddenEntries();
    const respectGitignore = state.respectGitignore();
    const ids = Array.from(rootPaths().keys());
    // Same race rule as refreshRoot: pin at call time so a pane flip
    // during the parallel reads doesn't redirect the cleanup to the
    // wrong pane.
    const targetPane = state.paneManager.activePane();
    await Promise.allSettled(ids.map(async (rootId) => {
      const rootPath = rootPaths().get(rootId);
      if (!rootPath) return;

      const entries = await readTree(rootPath, includeHiddenEntries, respectGitignore);
      const currentPath = targetPane.selectedFile()?.path;
      state.updateRootEntries(rootId, entries);

      if (currentPath && targetPane.selectedRootId() === rootId && !state.findEntryByPath(currentPath, rootId)) {
        targetPane.setSelectedFile(null);
        targetPane.setHtml("");
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
    // Pin the pane that originated the save — autosave fires 1s after
    // the last edit, and the user can flip panes during that window.
    // Without pinning, `state.setSavedContent` would clear the dirty
    // mark of whichever pane is active when the disk write returns,
    // not the pane whose buffer we actually persisted. See Round 4
    // Lesson 6 for the canonical write-up.
    const targetPane = state.paneManager.activePane();
    const entry = targetPane.selectedFile();
    const rootId = targetPane.selectedRootId();
    const rootPath = rootId ? rootPaths().get(rootId) : null;
    if (!entry || !rootPath) return;

    try {
      const absolutePath = `${rootPath}/${entry.path}`;
      const content = targetPane.editorContent();
      await writeFile(absolutePath, content);
      targetPane.setSavedContent(content);
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

  async function handleRevealInFileManager(entry: FSEntry, rootId: string): Promise<void> {
    const rootPath = rootPaths().get(rootId);
    if (!rootPath) return;
    // Root id IS the absolute path on desktop; join with the relative entry.
    const absolutePath = entry.path ? `${rootPath}/${entry.path}` : rootPath;
    try {
      // Reveals (and selects) the item in Finder / Explorer / the Linux
      // file manager via tauri-plugin-opener.
      await revealItemInDir(absolutePath);
    } catch (e) {
      console.error("Failed to reveal in file manager:", e);
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

    // Pin the per-doc target BEFORE the rename round-trip so a
    // mid-await pane flip can't redirect the path rewrite to the
    // wrong pane. See Round 4 Lesson 6.
    const targetPane = state.paneManager.activePane();
    await renameFile(rootPath, entry.path, newRelative);

    // If the renamed entry is (or contains) the open file, rewrite its path
    const sel = targetPane.selectedFile();
    if (sel && targetPane.selectedRootId() === rootId) {
      if (sel.path === entry.path) {
        targetPane.setSelectedFile({ ...sel, path: newRelative, name: newName });
      } else if (sel.path.startsWith(entry.path + "/")) {
        const newSelPath = newRelative + sel.path.slice(entry.path.length);
        targetPane.setSelectedFile({ ...sel, path: newSelPath });
      }
    }

    await refreshRoot(rootId);
  }

  async function handleDelete(entry: FSEntry, rootId: string): Promise<void> {
    const rootPath = rootPaths().get(rootId);
    if (!rootPath) throw new Error("Root not found");

    // Same rationale as handleRename / handleEditorSave — pin the
    // pane whose preview we'll need to clear if the open file lived
    // inside the deleted entry.
    const targetPane = state.paneManager.activePane();
    await trashPath(rootPath, entry.path);

    // If the deleted entry is (or contains) the open file, clear selection
    const sel = targetPane.selectedFile();
    if (sel && targetPane.selectedRootId() === rootId) {
      if (sel.path === entry.path || sel.path.startsWith(entry.path + "/")) {
        targetPane.setSelectedFile(null);
        targetPane.setHtml("");
        targetPane.setFrontmatter(null);
        targetPane.setEditorContent("");
        targetPane.setSavedContent("");
      }
    }

    await refreshRoot(rootId);
  }

  /** Create an empty file under `parentRel` (default `.md` extension;
   *  `sub/dir/name` creates the intermediate folders) and return its new
   *  workspace-relative path so the caller can open it. */
  async function handleCreateFile(
    parentRel: string,
    name: string,
    rootId: string,
  ): Promise<string> {
    const rootPath = rootPaths().get(rootId);
    if (!rootPath) throw new Error("Root not found");
    const relative = joinRelative(parentRel, withDefaultExtension(name));
    await createFile(rootPath, relative);
    await refreshRoot(rootId);
    return relative;
  }

  /** Create a directory under `parentRel` and return its new path. */
  async function handleCreateFolder(
    parentRel: string,
    name: string,
    rootId: string,
  ): Promise<string> {
    const rootPath = rootPaths().get(rootId);
    if (!rootPath) throw new Error("Root not found");
    const relative = joinRelative(parentRel, name);
    await createDir(rootPath, relative);
    await refreshRoot(rootId);
    return relative;
  }

  /** Move `entry` into the directory at `targetDirRel` ("" = workspace root)
   *  of `targetRootId` (defaults to `rootId` for within-root moves). Within a
   *  root it reuses `rename_file`; across roots it uses `move_path`. Refuses
   *  to drop a folder into itself and rewrites the open file's path. */
  async function handleMove(
    entry: FSEntry,
    targetDirRel: string,
    rootId: string,
    targetRootId: string = rootId,
  ): Promise<void> {
    const rootPath = rootPaths().get(rootId);
    const targetRootPath = rootPaths().get(targetRootId);
    if (!rootPath || !targetRootPath) throw new Error("Root not found");
    const newRelative = joinRelative(targetDirRel, entry.name);
    const sameRoot = targetRootId === rootId;
    if (sameRoot && newRelative === entry.path) return;
    if (
      entry.kind === "directory"
      && sameRoot
      && (targetDirRel === entry.path || targetDirRel.startsWith(entry.path + "/"))
    ) {
      throw new Error("Cannot move a folder into itself");
    }

    const targetPane = state.paneManager.activePane();
    if (sameRoot) {
      await renameFile(rootPath, entry.path, newRelative);
    } else {
      await movePath(rootPath, entry.path, targetRootPath, newRelative);
    }

    // Keep the open file pointing at its new location (path, and root when it
    // crossed workspaces).
    const sel = targetPane.selectedFile();
    if (sel && targetPane.selectedRootId() === rootId) {
      const rewrite = (path: string) => {
        if (!sameRoot) targetPane.setSelectedRootId(targetRootId);
        targetPane.setSelectedFile({ ...sel, path });
      };
      if (sel.path === entry.path) {
        rewrite(newRelative);
      } else if (sel.path.startsWith(entry.path + "/")) {
        rewrite(newRelative + sel.path.slice(entry.path.length));
      }
    }

    await refreshRoot(rootId);
    if (!sameRoot) await refreshRoot(targetRootId);
  }

  /** Copy `entry` into the directory at `targetDirRel` ("" = workspace root) of
   *  `targetRootId` (defaults to `rootId`; differs for cross-workspace copies).
   *  On a name collision (notably copying into the entry's own parent) the copy
   *  is suffixed ` (1)`, ` (2)`, … before the extension. Returns the new copy's
   *  workspace-relative path. */
  async function handleCopy(
    entry: FSEntry,
    targetDirRel: string,
    rootId: string,
    targetRootId: string = rootId,
  ): Promise<string> {
    const rootPath = rootPaths().get(rootId);
    const targetRootPath = rootPaths().get(targetRootId);
    if (!rootPath || !targetRootPath) throw new Error("Root not found");
    const sameRoot = targetRootId === rootId;
    if (
      entry.kind === "directory"
      && sameRoot
      && (targetDirRel === entry.path || targetDirRel.startsWith(entry.path + "/"))
    ) {
      throw new Error("Cannot copy a folder into itself");
    }

    const taken = (candidate: string) =>
      state.findEntryByPath(joinRelative(targetDirRel, candidate), targetRootId) != null;
    const name = nextAvailableName(entry.name, taken, entry.kind === "directory");
    const newRelative = joinRelative(targetDirRel, name);
    await copyPath(rootPath, entry.path, targetRootPath, newRelative);
    await refreshRoot(targetRootId);
    if (!sameRoot) await refreshRoot(rootId);
    return newRelative;
  }

  return {
    getPathName,
    handleCreateFile,
    handleCreateFolder,
    handleMove,
    handleCopy,
    handleCloseRoot,
    handleCopyPath,
    handleRevealInFileManager,
    handleDelete,
    handleEditorSave,
    handleOpenFolder,
    handleRename,
    openFolderPath,
    refreshAllRoots,
    refreshRoot,
  };
}
