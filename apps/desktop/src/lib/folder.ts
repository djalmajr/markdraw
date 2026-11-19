import type { Accessor, Setter } from "solid-js";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { FSEntry } from "@markdraw/core/types.ts";
import {
  getPendingTabRoots,
  loadOpenRoots,
  setOpenRoots,
  setPendingTabRoots,
  type OpenRoot,
} from "@markdraw/core/tabs.ts";
import { findEntryInTree, type AppState } from "@markdraw/ui/composables/create-app-state.ts";
import type { PaneStore } from "@markdraw/ui/composables/create-pane-store.ts";
import { copyPath, createDir, createFile, movePath, openDirectory, readFileContent, readTree, renameFile, trashPath, writeFile } from "./fs.ts";
import { joinRelative, nextAvailableName, withDefaultExtension } from "./fs-paths.ts";
import type { FileWatcher } from "./watcher.ts";
import { invoke } from "./chaos-invoke.ts";

interface FolderDeps {
  rootPaths: Accessor<Map<string, string>>;
  setRootPaths: Setter<Map<string, string>>;
  state: AppState;
  watcher: FileWatcher;
  onRootClosed?: (rootId: string) => void;
  onFileRenamed?: (pane: PaneStore, rootId: string, oldPath: string, entry: FSEntry, newRootId?: string, tabId?: string) => void;
}

interface ColdStartDeps {
  /** Reopen the saved folders (resolves once every one has an outcome). */
  restoreOpenRoots: () => Promise<unknown>;
  /** The saved folders are final: settle the tab session and activate. */
  settleSession: () => void;
  /** The file passed on the command line, if any. */
  getStartupFile: () => Promise<string | null>;
  openStartupFile: (path: string) => Promise<void>;
}

/**
 * What the app does once when it starts or its webview reloads: reopen the
 * saved folders, settle the tab session (so the saved active tab wins even when
 * its folder opens last), then honor a command-line file, which therefore opens
 * after every restored folder and tab.
 */
export async function runColdStart(deps: ColdStartDeps): Promise<void> {
  try {
    await deps.restoreOpenRoots();
  } catch (e) {
    console.warn("Could not restore the saved folders:", e);
  }
  try {
    deps.settleSession();
  } catch (e) {
    console.warn("Could not settle the saved tabs:", e);
  }
  try {
    const file = await deps.getStartupFile();
    if (file) await deps.openStartupFile(file);
  } catch {
    // No args or command not available
  }
}

export function createFolder(deps: FolderDeps) {
  const { rootPaths, setRootPaths, state, watcher, onRootClosed, onFileRenamed } = deps;

  // Serialize authorization changes together with their UI publication. In
  // particular a close is acknowledged by Rust before it disappears locally;
  // a later open cannot replay an older snapshot over the closed roots.
  const rootUpdateRejected = Symbol("MCP workspace update rejected");
  let rootUpdates = invoke<void>("mcp_set_roots", { roots: [] }).catch(() => {
    console.warn("Could not initialize MCP workspaces");
  });

  // The roots the user wants open across reloads, in order. It is the single
  // source of the persisted list and it is only ever changed inside the queue
  // above, so opens, closes and prunes line up in one order: a root still
  // pending (or refused by the registry) stays in it, a root the user closed
  // is never written back by an open that finishes later.
  //
  // `inventoryKnown` is whether storage held a usable list when this page first
  // read it. A start without one (an update from a version that predates the
  // key, or unreadable storage) cannot say which roots the saved tabs belong
  // to: `adoptSessionRoots` parks those roots in `pending`, so the first list
  // written afterwards (only the folders opened since) never reads as complete.
  let desired: Map<string, string> | null = null;
  let inventoryKnown = true;
  function desiredRoots(): Map<string, string> {
    if (!desired) {
      const stored = loadOpenRoots();
      inventoryKnown = stored !== null;
      desired = new Map((stored ?? []).map((root) => [root.path, root.path]));
    }
    return desired;
  }

  // Roots whose saved tabs predate the list: kept until the folder opens (the
  // list holds it from then on) or the directory is confirmed gone. Persisted,
  // so a second start still knows them.
  let pending: Set<string> | null = null;
  function pendingRoots(): Set<string> {
    pending ??= new Set(getPendingTabRoots());
    return pending;
  }

  function persistPending(): void {
    try {
      setPendingTabRoots(pendingRoots());
    } catch (e) {
      console.warn("Could not persist the pending tab roots:", e);
    }
  }

  /** Drops the pending roots the list now holds (they restore as any saved
   *  folder). Returns whether anything changed. */
  function releaseListed(wanted: ReadonlyMap<string, string>): boolean {
    let changed = false;
    for (const id of pendingRoots()) {
      if (wanted.has(id)) {
        pendingRoots().delete(id);
        changed = true;
      }
    }
    return changed;
  }

  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = rootUpdates.then(task);
    rootUpdates = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Runs `change` on copies of the roots when its turn in the queue comes;
   *  it may return `false` to apply nothing (the facts it checked changed while
   *  the update waited). Resolves to whether the update was applied. */
  function updateRoots(
    change: (next: Map<string, string>, wanted: Map<string, string>) => void | false,
    publish: (next: ReadonlyMap<string, string>) => void,
  ): Promise<boolean> {
    // A failed update leaves the registry, the local roots and the persisted
    // list unchanged; later user actions may retry without a poisoned queue.
    return serial(async () => {
      const next = new Map(rootPaths());
      const wanted = new Map(desiredRoots());
      if (change(next, wanted) === false) return false;
      await invoke("mcp_set_roots", {
        roots: Array.from(next.values(), (path) => ({ path, name: getPathName(path) })),
      }).catch(() => {
        console.warn("Could not update MCP workspaces");
        throw rootUpdateRejected;
      });
      setRootPaths(next);
      desired = wanted;
      persistOpenRoots(wanted);
      if (releaseListed(wanted)) persistPending();
      publish(next);
      return true;
    });
  }

  // The token that ties a persisted root to the tab session: tabs are filed
  // under the root's absolute path, which is also the id `openFolderPath`
  // uses, so `{ id, path }` stays stable if roots ever get an opaque id.
  function openRootList(roots: ReadonlyMap<string, string>): OpenRoot[] {
    return Array.from(roots, ([id, path]) => ({ id, path }));
  }

  function persistOpenRoots(roots: ReadonlyMap<string, string>): void {
    try {
      setOpenRoots(openRootList(roots));
    } catch (e) {
      // Storage can be full or disabled; losing the reload snapshot must never
      // fail the root change that just succeeded in Rust and in the UI.
      console.warn("Could not persist the open roots:", e);
    }
  }

  function getPathName(path: string) {
    const normalizedPath = path.replace(/\\/g, "/");
    const parts = normalizedPath.split("/").filter(Boolean);
    const name = parts[parts.length - 1];
    return !name || name.includes("\0") ? "Root" : name;
  }

  // A tree read that began before a successful rename or move (or before its
  // root closed) describes a layout that no longer exists. Each root counts the
  // operations that supersede its reads; a read keeps its starting count and
  // publishes only while the count is unchanged.
  const treeGenerations = new Map<string, number>();
  const treeGeneration = (rootId: string) => treeGenerations.get(rootId) ?? 0;
  function supersedeTreeReads(...rootIds: string[]) {
    for (const rootId of rootIds) treeGenerations.set(rootId, treeGeneration(rootId) + 1);
  }

  async function openFolderPath(path: string): Promise<boolean> {
    return (await openRootPath(path)) === "opened";
  }

  /** Why a root did not open. `missing` is the directory confirmed gone from
   *  disk (drop it from the persisted list); `rejected` is the MCP registry
   *  refusing the snapshot and `failed` any other error (permission denied, a
   *  transient I/O error): both keep the entry for the next attempt. `closed`
   *  is a restore the user overtook by closing the folder: nothing to do. */
  type OpenRootOutcome = "opened" | "missing" | "rejected" | "failed" | "closed";

  /** Paths the user closed in this page's lifetime. A restore that reaches one
   *  later must not bring it back. */
  const closedByUser = new Set<string>();

  // Rust reports the OS error text without the path, so absence is read from
  // the "no such file or directory" family (POSIX ENOENT, Windows 2 and 3).
  function isNotFound(error: unknown): boolean {
    const text = error instanceof Error ? error.message : String(error);
    return /os error (?:2|3)\b|no such (?:file or )?directory|cannot find the (?:path|file)|ENOENT/i.test(text);
  }

  // Whether the root path itself is gone. A recursive read cannot tell: it
  // reports the same unqualified error for the root and for any descendant that
  // vanishes while it walks. Reading the root path directly fails with
  // "is a directory" when it exists (and with not-found only when it is gone),
  // so only that answer counts; any other outcome leaves the absence unproven.
  async function rootIsGone(path: string): Promise<boolean> {
    try {
      await readFileContent(path);
      return false;
    } catch (e) {
      return isNotFound(e);
    }
  }

  async function openRootPath(
    path: string,
    { restore = false }: { restore?: boolean } = {},
  ): Promise<OpenRootOutcome> {
    // Normalize to forward slashes so Windows paths match the events emitted
    // by the Rust watcher (which also normalizes slashes).
    path = path.replace(/\\/g, "/");
    if (!restore) closedByUser.delete(path);

    // A restore runs in the background: it must not move the selection away
    // from the document the user is looking at, only fill an empty one.
    const select = () => {
      if (!restore || state.selectedRootId() === null) state.setSelectedRootId(path);
    };

    // If this root is already open, just select it
    if (rootPaths().has(path)) {
      select();
      return "opened";
    }

    try {
      state.setLoading(true);
      const read = () => readTree(path, state.showHiddenEntries(), state.respectGitignore());
      let entries: FSEntry[];
      try {
        entries = await read();
      } catch (e) {
        // A subfolder vanishing mid-walk reads the same as the root vanishing:
        // ask the root itself before calling it gone, and walk once more while
        // it still answers (a second failure keeps the entry for the next start).
        if (!restore || !isNotFound(e)) throw e;
        if (await rootIsGone(path)) throw Object.assign(new Error("missing root"), { missingRoot: true });
        try {
          entries = await read();
        } catch (again) {
          if (isNotFound(again) && await rootIsGone(path)) {
            throw Object.assign(new Error("missing root"), { missingRoot: true });
          }
          throw again;
        }
      }

      // Everything above waited on the disk: what the user did meanwhile is
      // decided here, in the queue, when this update's turn comes. A folder
      // closed since the restore started stays closed, and one a manual open
      // already published is not published again.
      let overtaken = null as OpenRootOutcome | null;
      const applied = await updateRoots((next, wanted) => {
        if (restore && closedByUser.has(path)) {
          overtaken = "closed";
          return false;
        }
        if (next.has(path)) {
          overtaken = "opened";
          return false;
        }
        next.set(path, path);
        wanted.set(path, path);
      }, () => {
        state.addRoot({
          collapsed: false,
          entries,
          id: path,
          name: getPathName(path),
        });
      });
      if (!applied) {
        if (overtaken === "opened") select();
        return overtaken ?? "failed";
      }

      select();
      state.setSidebarVisible(true);
      state.pushRecentFolder(path);
      return "opened";
    } catch (e) {
      if (e === rootUpdateRejected) return "rejected";
      const missing = restore
        ? (e as { missingRoot?: boolean }).missingRoot === true
        : isNotFound(e);
      // A root that vanished between sessions is expected during a restore:
      // drop it from the list without surfacing an error the user cannot act on.
      if (!restore) console.error("Failed to open directory:", e);
      else if (!missing) console.warn("Could not reopen a saved folder:", e);
      return missing ? "missing" : "failed";
    } finally {
      state.setLoading(false);
    }
  }

  /**
   * Reopen the roots the last session had open, in their original order. This
   * is what makes a webview reload (Vite HMR in dev) land back on the folder
   * and tabs the user had: `rootPaths` is in-memory only, and the tab restore
   * effect skips tabs whose root is not open. Only a directory confirmed gone
   * is dropped from storage; a root the MCP registry refused, or one that
   * failed with a read error, stays for the next start. Pruning, opens and
   * closes share one queue, so none of them can write back a stale list.
   */
  async function restoreOpenRoots(): Promise<string[]> {
    const stored = Array.from(desiredRoots().keys());
    const reopened: string[] = [];
    for (const path of stored) {
      if (closedByUser.has(path)) continue;
      const outcome = await openRootPath(path, { restore: true });
      if (outcome === "opened") reopened.push(path);
      else if (outcome === "closed") continue;
      else if (outcome === "missing") {
        await serial(async () => {
          if (rootPaths().has(path) || !desiredRoots().has(path)) return;
          const wanted = new Map(desiredRoots());
          wanted.delete(path);
          desired = wanted;
          persistOpenRoots(wanted);
        });
      }
    }
    // Saved tabs filed under roots the list does not hold (an update from a
    // version without it): only a directory confirmed gone releases them.
    for (const id of Array.from(pendingRoots())) {
      if (closedByUser.has(id) || desiredRoots().has(id) || rootPaths().has(id)) continue;
      if (!(await rootIsGone(id))) continue;
      await serial(async () => {
        if (rootPaths().has(id) || desiredRoots().has(id) || !pendingRoots().delete(id)) return;
        persistPending();
      });
    }
    return reopened;
  }

  /**
   * Tell the folders which roots the saved tab sessions (every pane) have tabs
   * under, read before any write. Without a usable list of open folders those
   * roots are parked as pending, so a list that only holds the folders opened
   * since the update is never mistaken for the whole inventory.
   */
  function adoptSessionRoots(rootIds: Iterable<string>): void {
    desiredRoots();
    if (inventoryKnown) return;
    let changed = false;
    for (const id of rootIds) {
      if (id.length === 0 || pendingRoots().has(id)) continue;
      pendingRoots().add(id);
      changed = true;
    }
    if (changed) persistPending();
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
    const generation = treeGeneration(rootId);
    try {
      const entries = await readTree(
        rootPath,
        state.showHiddenEntries(),
        state.respectGitignore(),
      );
      // Superseded by a rename or move that finished while this read was in
      // flight (or by closing the root): publish nothing, clear nothing. The
      // operation's own refresh publishes the tree that follows it.
      if (generation !== treeGeneration(rootId)) return;
      const currentPath = targetPane.selectedFile()?.path;
      state.updateRootEntries(rootId, entries);

      // If selected file was in this root and was deleted, clear the selection
      if (currentPath && targetPane.selectedRootId() === rootId && !findEntryInTree(entries, currentPath)) {
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
  async function refreshAllRoots({
    includeHiddenEntries = state.showHiddenEntries(),
    respectGitignore = state.respectGitignore(),
  } = {}) {
    const ids = Array.from(rootPaths().keys());
    // Same race rule as refreshRoot: pin at call time so a pane flip
    // during the parallel reads doesn't redirect the cleanup to the
    // wrong pane.
    const targetPane = state.paneManager.activePane();
    await Promise.allSettled(ids.map(async (rootId) => {
      const rootPath = rootPaths().get(rootId);
      if (!rootPath) return;

      const generation = treeGeneration(rootId);
      const entries = await readTree(rootPath, includeHiddenEntries, respectGitignore);
      if (generation !== treeGeneration(rootId)) return;
      const currentPath = targetPane.selectedFile()?.path;
      state.updateRootEntries(rootId, entries);

      if (currentPath && targetPane.selectedRootId() === rootId && !findEntryInTree(entries, currentPath)) {
        targetPane.setSelectedFile(null);
        targetPane.setHtml("");
      }
    }));
  }

  async function handleCloseRoot(rootId: string) {
    try {
      closedByUser.add(rootId);
      await updateRoots((next, wanted) => { next.delete(rootId); wanted.delete(rootId); }, (next) => {
        supersedeTreeReads(rootId);
        state.removeRoot(rootId);
        if (next.size === 0) void watcher.destroy();
        if (!next.has(rootId)) onRootClosed?.(rootId);
      });
    } catch (e) {
      if (e !== rootUpdateRejected) console.error("Could not close workspace: MCP authorization update failed");
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
    const tab = targetPane.tabs.getActiveTab();
    const entry = targetPane.selectedFile();
    if (!entry || tab?.needsLoad) return;
    // The destination is the active document's own identity (root and path of
    // its tab), never the root the sidebar happens to have selected: opening a
    // folder moves the selection while the open tab stays where it was. When
    // the pane's file is not the tab's file (a rename still settling) nothing
    // is guessed and nothing is written; the next autosave retries.
    if (tab && entry.path !== tab.filePath) {
      console.warn("Skipped saving: the open file and its tab disagree");
      return;
    }
    const rootId = tab ? tab.rootId : targetPane.selectedRootId();
    const rootPath = rootId ? rootPaths().get(rootId) : null;
    if (!rootId || !rootPath) return;

    try {
      const absolutePath = `${rootPath}/${entry.path}`;
      const content = targetPane.editorContent();
      await writeFile(absolutePath, content);
      if (targetPane.tabs.activeTabId() === (tab?.id ?? null)
        && targetPane.selectedFile()?.path === entry.path
        && (tab !== undefined || targetPane.selectedRootId() === rootId)) {
        targetPane.setSavedContent(content);
      }
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

  // Publish every open document's new identity before the tree read can wait.
  function repointTabs(rootId: string, oldPath: string, newPath: string, newRootId = rootId) {
    for (const pane of state.paneManager.panes()) {
      const tabs = pane.tabs.tabs();
      const activeId = pane.tabs.activeTabId();
      const active = tabs.find((tab) => tab.id === activeId);
      const ordered = active ? [active, ...tabs.filter((tab) => tab.id !== activeId)] : tabs;
      for (const tab of ordered) {
        if (tab.rootId !== rootId) continue;
        if (tab.filePath !== oldPath && !tab.filePath.startsWith(oldPath + "/")) continue;
        const path = newPath + tab.filePath.slice(oldPath.length);
        onFileRenamed?.(pane, rootId, tab.filePath, {
          kind: "file", path, name: path.slice(path.lastIndexOf("/") + 1),
        }, newRootId, tab.id);
      }
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
    supersedeTreeReads(rootId);

    // If the renamed entry is (or contains) the open file, rewrite its path.
    // `renamedSel` keeps the new entry so the tab and the OS watcher can
    // follow it once the root refresh settles.
    const sel = targetPane.selectedFile();
    let renamedSel: FSEntry | null = null;
    if (sel && targetPane.selectedRootId() === rootId) {
      if (sel.path === entry.path) {
        renamedSel = { ...sel, path: newRelative, name: newName };
      } else if (sel.path.startsWith(entry.path + "/")) {
        renamedSel = { ...sel, path: newRelative + sel.path.slice(entry.path.length) };
      }
      if (renamedSel) targetPane.setSelectedFile(renamedSel);
    }

    // Every open tab takes the new identity right now, before the tree is read
    // again: the pane already points at the new path, and an autosave that fires
    // while the refresh is pending must find the tab and the pane in agreement.
    repointTabs(rootId, entry.path, newRelative);
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
    supersedeTreeReads(rootId, targetRootId);

    // Keep the open file pointing at its new location (path, and root when it
    // crossed workspaces).
    const sel = targetPane.selectedFile();
    let movedSel: FSEntry | null = null;
    if (sel && targetPane.selectedRootId() === rootId) {
      const rewrite = (path: string) => {
        if (!sameRoot) targetPane.setSelectedRootId(targetRootId);
        targetPane.setSelectedFile({ ...sel, path });
      };
      if (sel.path === entry.path) {
        movedSel = { ...sel, path: newRelative };
        rewrite(newRelative);
      } else if (sel.path.startsWith(entry.path + "/")) {
        movedSel = { ...sel, path: newRelative + sel.path.slice(entry.path.length) };
        rewrite(movedSel.path);
      }
    }

    // A move renames the file on disk as well: repoint every open tab (and the
    // OS watcher) at the new location before any tree is read again. With the
    // same relative path in two workspaces, a tab still filed under the old
    // root would let an autosave in that window write to the origin.
    repointTabs(rootId, entry.path, newRelative, targetRootId);
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
    restoreOpenRoots,
    adoptSessionRoots,
    // The roots whose saved tabs survive this start: the folders wanted for the
    // next one plus the pending roots not yet opened or confirmed gone.
    savedRootIds: () => Array.from(new Set([...desiredRoots().keys(), ...pendingRoots()])),
    refreshAllRoots,
    refreshRoot,
  };
}
