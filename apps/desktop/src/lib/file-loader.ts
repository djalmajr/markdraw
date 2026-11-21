import { untrack, type Accessor } from "solid-js";
import type { FSEntry } from "@markdraw/core/types.ts";
import { getIncludePaths } from "@markdraw/core/asciidoc.ts";
import { getMarkdownIncludePaths } from "@markdraw/core/markdown.ts";
import { fileKind, isMdFile, isSupportedFile, UNSUPPORTED_CONTENT } from "@markdraw/core/utils.ts";
import type { AppState, ConvertedDoc, DocReader } from "@markdraw/ui/composables/create-app-state.ts";
import type { PaneStore } from "@markdraw/ui/composables/create-pane-store.ts";
import type { TabState } from "@markdraw/core/tabs.ts";
import {
  readFileByPath,
  readFileContent,
  readFilesRelative,
} from "./fs.ts";
import type { FileWatcher } from "./watcher.ts";
import { decideExternalReload, eventIsOnly, hashContent, type OwnWrites } from "./external-reload.ts";

interface FileLoaderDeps {
  rootPaths: Accessor<Map<string, string>>;
  state: AppState;
  watcher: FileWatcher;
  /** What the autosave just wrote: a watcher event that is only the echo of
   *  that write does not convert the document again. */
  ownWrites?: OwnWrites;
}

interface LoadOptions {
  pushHistory: boolean;
  force: boolean;
  rootId?: string;
  /** A file-watcher refresh: the buffer may hold newer text than the disk. */
  external: boolean;
  /** Absolute paths the watcher event named (external refreshes only). */
  eventPaths?: readonly string[];
  diskChange?: symbol;
  reload?: boolean;
  tab?: { pane: PaneStore; id: string };
}

interface WatcherRefresh {
  pane: PaneStore;
  tab?: TabState;
  fileHit: boolean;
  diskChange?: symbol;
}

function normalizeEventPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

export function createFileLoader(deps: FileLoaderDeps) {
  const { rootPaths, state, watcher, ownWrites } = deps;
  // Watcher refreshes can overlap (a slow conversion outlives the next
  // watcher event); only the newest refresh of a pane may apply its result,
  // or an older disk version would win. Per pane: a refresh of another pane's
  // file must not cancel this one.
  let refreshSeq = 0;
  let eventOrder = 0;
  const latestRefresh = new WeakMap<object, number>();
  const latestClaim = new WeakMap<object, number>();
  // The newest event whose echo confirmed a publication: the preview of the
  // saved text is on screen. It does not outdate the success of an older event
  // (an include that really changed still refreshes), but the failure of work
  // that started before it says nothing about what is on screen any more.
  const latestConfirmed = new WeakMap<object, number>();
  // How many errors this loader published per pane: an echo that checked the
  // preview and then finds one more was published meanwhile did not confirm it.
  const errorsPublished = new WeakMap<object, number>();
  const latestLoad = new WeakMap<PaneStore, object>();

  /** How a document of the workspace at `root` reads its includes: one cache,
   *  one IPC per layer of nested includes, and the hook that keeps the tab and
   *  the watcher on what an accepted edit conversion depends on. */
  function createReader(
    root: string,
    rootId: string | null | undefined,
    includeFileCache = new Map<string, string>(),
    consulted?: Set<string>,
  ): DocReader {
    const readFile = async (relPath: string) => {
      consulted?.add(relPath);
      const cached = includeFileCache.get(relPath);
      if (cached !== undefined) return cached;

      const fileContent = await readFileByPath(root, relPath);
      if (fileContent !== null) {
        includeFileCache.set(relPath, fileContent);
      }
      return fileContent;
    };
    // One IPC for a whole layer of nested includes (what the converter asks
    // for), not one per file. Unreadable files come back as null, like
    // readFile; if the batch itself fails each file is read on its own, so
    // the error handling stays the one readFile always had.
    const readFiles = async (relPaths: string[]) => {
      const found = new Map<string, string | null>();
      const missing: string[] = [];
      for (const relPath of relPaths) {
        consulted?.add(relPath);
        const cached = includeFileCache.get(relPath);
        if (cached !== undefined) found.set(relPath, cached);
        else missing.push(relPath);
      }
      if (missing.length === 0) return found;
      let batch: Map<string, string> | null = null;
      try {
        batch = await readFilesRelative(root, missing);
      } catch (error) {
        console.warn("Batch include read failed, reading files one by one:", error);
      }
      for (const relPath of missing) {
        const fileContent = batch ? (batch.get(relPath) ?? null) : await readFileByPath(root, relPath);
        if (fileContent !== null) includeFileCache.set(relPath, fileContent);
        found.set(relPath, fileContent);
      }
      return found;
    };
    // After an edit conversion the document may depend on other includes
    // than at load: keep the tab snapshot and the watcher on them, or an
    // include typed after the load would never refresh the preview.
    // The document is named by the conversion (`doc`), not by the loaded entry:
    // after a rename the tab, the base directory and the watched target all use
    // the path now in use. The tab may be a background one (its conversion ended
    // after a tab switch): its snapshot gets the dependencies, and the
    // watcher only follows the tab on screen.
    // `consulted` is what the accepted conversion asked for (missing paths it
    // tried to read included), so an include the edit removed leaves the list
    // even though the cache still holds its text.
    const converted = (pane: PaneStore, _text: string, doc: ConvertedDoc, pathsRead: ReadonlySet<string>) => {
      consulted = undefined;
      if (doc.rootId !== rootId || doc.tabId === null) return;
      const current = pane.tabs.getTab(doc.tabId);
      if (!current || current.filePath !== doc.filePath || current.rootId !== rootId) return;
      const paths = Array.from(pathsRead);
      const known = new Set(current.includePaths);
      if (paths.length !== known.size || paths.some((p) => !known.has(p))) {
        pane.tabs.updateTabContent(current.id, { includePaths: paths });
      }
      if (pane === state.paneManager.activePane() && pane.tabs.activeTabId() === current.id) {
        syncWatcher({ kind: "file", name: current.fileName, path: doc.filePath }, root, paths);
      }
    };
    return { readFile, readFiles, converted };
  }

  // A loaded tab moved to another workspace gets a reader for that workspace
  // (new root, empty cache) before its pending conversion is carried over.
  // Tests give the loader a partial state, hence the optional call.
  state.setReaderFactory?.((rootId) => {
    const root = rootPaths().get(rootId);
    return root ? createReader(root, rootId) : undefined;
  });

  function syncWatcher(entry: FSEntry | null, rootPath?: string | null, includePaths: string[] = []) {
    if (entry?.kind === "file" && rootPath) {
      const kind = fileKind(entry.path);
      if (kind !== "image" && kind !== "pdf" && kind !== "excalidraw") {
        watcher.setTarget({ filePath: `${rootPath}/${entry.path}`, includePaths, rootPath });
        // The app-level effect owns the on/off decision; this is a current-value
        // check for this sync, not a dependency of the effect that called it.
        if (untrack(() => state.autoRefresh())) void watcher.start();
        return;
      }
    }
    void watcher.stop();
  }

  async function markDiskChanges(paths: readonly string[], focusedWatcher = false): Promise<WatcherRefresh[]> {
    // The focused watcher and the recursive workspace watcher use the same
    // normalized event paths, including on Windows.
    const changed = new Set(paths.map(normalizeEventPath));
    const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
    const matches = (path: string) => {
      let current = normalizeEventPath(path);
      while (current) {
        if (changed.has(current)) return true;
        current = parent(current);
      }
      return false;
    };
    const change = Symbol();
    const roots = rootPaths();
    const echoes = new Map<string, string>();
    if (ownWrites?.revision()) {
      const absolutePaths = new Map<string, string>();
      for (const pane of state.paneManager.panes()) {
        for (const tab of pane.tabs.tabs()) {
          const root = roots.get(tab.rootId);
          if (!root || !tab.filePath) continue;
          const absolute = `${root}/${tab.filePath}`;
          const normalized = normalizeEventPath(absolute);
          if (changed.has(normalized)) absolutePaths.set(normalized, absolute);
        }
      }
      if (absolutePaths.size > 0) {
        // Verify each notification against disk. A later notification for the
        // same path might be an external write even if an earlier one was ours.
        await Promise.all(Array.from(absolutePaths, async ([normalized, absolute]) => {
          try {
            const content = await readFileContent(absolute);
            if (await ownWrites.matches(absolute, await hashContent(content))) echoes.set(normalized, content);
          } catch {
            // A file that disappeared or could not be read still needs invalidation.
          }
        }));
      }
    }
    // Selection may have changed during the disk read or the hash check.
    const focused = focusedWatcher ? state.paneManager.activePane() : undefined;
    const focusedTabId = focused?.tabs.activeTabId();
    const refreshes: WatcherRefresh[] = [];
    if (focused && !focusedTabId) refreshes.push({ pane: focused, fileHit: false });
    for (const pane of state.paneManager.panes()) {
      for (const tab of pane.tabs.tabs()) {
        const root = roots.get(tab.rootId);
        if (!root || !tab.filePath) continue;
        const isFocusedTab = pane === focused && tab.id === focusedTabId;
        const absolute = normalizeEventPath(`${root}/${tab.filePath}`);
        const fileHit = matches(absolute);
        const includeHit = tab.includePaths.some((path) => matches(`${root}/${path}`));
        if (!fileHit && !includeHit && !(changed.size === 0 && isFocusedTab)) continue;
        const active = pane.tabs.activeTabId() === tab.id;
        const echo = echoes.get(absolute);
        if (!includeHit && echo !== undefined && !matches(parent(absolute))) {
          const saved = active ? pane.savedContent() : tab.savedContent;
          const buffer = active ? pane.editorContent() : tab.editorContent;
          // Another pane may still have a clean preview of an older revision.
          if (echo === saved || buffer !== saved) {
            // Only the content watcher verifies the preview of an own-write echo.
            if (isFocusedTab) refreshes.push({ pane, tab, fileHit });
            continue;
          }
        }
        pane.tabs.updateTabContent(tab.id, { diskChange: change });
        if (active) refreshes.push({ pane, tab, fileHit, diskChange: change });
      }
    }
    return refreshes;
  }

  async function handleWatcherChange(
    eventPaths: readonly string[],
    source: "focused" | "recursive",
    onRefreshed?: (pane: PaneStore, tabId: string | undefined, changedElsewhere: boolean) => void,
  ) {
    const refreshes = await markDiskChanges(eventPaths, source === "focused");
    if (!state.autoRefresh()) return;
    await Promise.all(refreshes.map(async ({ pane, tab, fileHit, diskChange }) => {
      const file = pane.selectedFile();
      const rootId = pane.selectedRootId();
      const activation = pane.tabs.activationVersion();
      const isCurrent = () => state.paneManager.panes().includes(pane)
        && (diskChange !== undefined || state.paneManager.activePane() === pane)
        && pane.tabs.activationVersion() === activation
        && pane.tabs.activeTabId() === (tab?.id ?? null)
        && pane.selectedFile() === file && pane.selectedRootId() === rootId;
      if (!file || !isCurrent() || pane.loading() || pane.tabs.getActiveTab()?.needsLoad
        || (tab && (tab.filePath !== file.path || tab.rootId !== rootId))) return;

      // An include-only event can rerender the live buffer. If the document
      // itself changed, keep the invalidation mark and leave local edits alone.
      if (fileHit && pane.editorContent() !== pane.savedContent()) return;

      const changedElsewhere = await refreshFromDisk(file, rootId ?? undefined, eventPaths, diskChange, pane);
      if (isCurrent()) onRefreshed?.(pane, tab?.id, changedElsewhere);
    }));
  }

  async function loadFileContent(entry: FSEntry, pushHistory = true, force = false, rootId?: string) {
    await load(entry, { pushHistory, force, rootId, external: false });
  }

  async function loadTabContent(pane: PaneStore, entry: FSEntry, tab: Pick<TabState, "id" | "rootId">, pushHistory = false, reload = false) {
    await load(entry, { pushHistory, force: true, rootId: tab.rootId, external: false, tab: { pane, id: tab.id }, reload });
  }

  /** Re-read the open file after a watcher event without clobbering unsaved
   *  edits — the event is often our own autosave (see external-reload.ts). */
  async function refreshFromDisk(entry: FSEntry, rootId?: string, eventPaths?: readonly string[], diskChange?: symbol, pane?: PaneStore): Promise<boolean> {
    // true only when the buffer adopted the disk text: the file changed
    // elsewhere (our own autosave writes and include changes don't count).
    return (await load(entry, { pushHistory: false, force: true, rootId, external: true, eventPaths, diskChange }, pane)) === true;
  }

  /** Resolves true when a watcher refresh adopted the disk text. */
  async function load(entry: FSEntry, opts: LoadOptions, pane?: PaneStore): Promise<boolean | undefined> {
    const { pushHistory, force, rootId, external, eventPaths, tab, reload } = opts;
    // Pin the target pane at call time. AppState's per-doc setters
    // (setHtml, setEditorContent, …) are proxies that route to
    // `paneManager.activePane()` on each call — without pinning, a
    // pane switch between this function's await points would route
    // the convert result to the wrong pane (the original symptom:
    // "intro.adoc shows blank preview" when the user clicked another
    // pane mid-conversion). Writing directly to the captured pane
    // keeps the load atomic from the user's perspective: the file
    // they asked for lands where they asked for it.
    const targetPane = tab?.pane ?? pane ?? state.paneManager.activePane();
    const targetRootId = rootId ?? targetPane.selectedRootId();
    const root = targetRootId ? rootPaths().get(targetRootId) : null;
    if (!root || entry.kind !== "file") return;
    const isSameFile =
      targetPane.selectedFile()?.path === entry.path
      && targetPane.selectedRootId() === targetRootId;
    if (!force && isSameFile) return;
    if (external && targetPane.tabs.getActiveTab()?.needsLoad) return;
    const getDocumentTab = () => {
      const liveTab = tab ? targetPane.tabs.getTab(tab.id) : targetPane.tabs.getActiveTab();
      return liveTab?.filePath === entry.path && liveTab.rootId === targetRootId ? liveTab : undefined;
    };
    let documentTab = getDocumentTab();
    let diskChange = external ? opts.diskChange : documentTab?.diskChange;
    const clearDiskChange = () => {
      if (documentTab && diskChange) targetPane.tabs.clearTabDiskChange(documentTab.id, diskChange);
    };
    const activation = targetPane.tabs.activationVersion();
    // An autosave echo does not claim a conversion or invalidate one in flight.
    const order = external ? ++eventOrder : 0;
    let seq = 0;
    const claim = () => {
      // A newer event already claimed: this one read an older disk.
      if ((latestClaim.get(targetPane) ?? 0) > order) return false;
      latestClaim.set(targetPane, order);
      seq = ++refreshSeq;
      latestRefresh.set(targetPane, seq);
      return true;
    };
    const request = {};
    const lastExplicitLoad = latestLoad.get(targetPane);
    if (!external) latestLoad.set(targetPane, request);
    // A watcher refresh runs in the background and must drop its result once
    // a newer refresh started or the pane switched to another file (tab
    // switch) — otherwise this file's text could land in another tab.
    // An event that has not claimed yet (`seq` 0) is outdated once a newer one
    // claimed: its read or conversion, failure included, says nothing about the
    // file any more, and must not replace what the newer event published. Echoes
    // never claim, so they outdate nothing.
    const superseded = () => external
      ? ((seq !== 0 ? latestRefresh.get(targetPane) !== seq : (latestClaim.get(targetPane) ?? 0) > order)
        || latestLoad.get(targetPane) !== lastExplicitLoad
        || targetPane.tabs.activationVersion() !== activation
        || targetPane.selectedFile()?.path !== entry.path
        || targetPane.selectedRootId() !== targetRootId
        || targetPane.tabs.getActiveTab()?.needsLoad)
      : latestLoad.get(targetPane) !== request
        || (tab !== undefined && targetPane.tabs.activeTabId() !== tab.id)
        || targetPane.selectedFile()?.path !== entry.path
        || targetPane.selectedRootId() !== targetRootId;
    // The same rule for an error: besides being superseded, a failure of work
    // older than the last confirmed publication must not replace that preview.
    const failureStale = () => superseded() || (external && (latestConfirmed.get(targetPane) ?? 0) > order);
    const isFocused = () => targetPane === state.paneManager.activePane();
    const markTabLoaded = (content: string, html: string, frontmatter: ReturnType<PaneStore["frontmatter"]>, includePaths: string[]) => {
      if (tab) {
        targetPane.tabs.updateTabContent(tab.id, { editorContent: content, savedContent: content, html, frontmatter, includePaths, needsLoad: false });
      } else {
        const activeTab = targetPane.tabs.getActiveTab();
        if (activeTab?.filePath === entry.path && activeTab.rootId === targetRootId) {
          targetPane.tabs.updateTabContent(activeTab.id, { includePaths });
        }
      }
    };
    const watch = (includePaths: string[]) => {
      if (isFocused()) syncWatcher(entry, root, includePaths);
    };
    let reloadBuffer: string | undefined;
    const keepLocalReload = () => {
      if (!reload) return false;
      const buffer = targetPane.editorContent();
      if (buffer === targetPane.savedContent() && (reloadBuffer === undefined || reloadBuffer === buffer)) {
        reloadBuffer = buffer;
        return false;
      }
      if (!targetPane.html() && documentTab?.html) {
        targetPane.setHtml(documentTab.html);
        targetPane.setFrontmatter(documentTab.frontmatter);
      }
      watch(documentTab?.includePaths ?? []);
      return true;
    };

    targetPane.setSelectedRootId(targetRootId);
    targetPane.setSelectedFile(entry);
    if (!isSameFile || (!external && diskChange)) {
      targetPane.setHtml("");
      state.notePreviewFailed(targetPane, targetRootId ?? null, entry.path, tab ? tab.id : undefined);
    }
    // A watcher refresh is background work (every autosave triggers one):
    // no loading state, which would flash the preview.
    if (!external) targetPane.setLoading(true);

    if (pushHistory) {
      // Nav stack lives on AppState (global) — same handler whether
      // we're pinning the pane or not.
      state.pushNavHistory({
        entry,
        rootId: targetRootId!,
      });
    }

    // Image/PDF skip the text pipeline entirely. The media viewer reads
    // the file straight off disk via the asset protocol, so there's
    // nothing to read into JS (reading binary as UTF-8 would throw) and
    // nothing to convert. Clear the text-centric signals, stop any
    // watcher left running on the previous file, and let PaneView swap
    // to the viewer based on viewerKind().
    const kind = fileKind(entry.path);
    // Image/PDF use the builtin media viewer; `.excalidraw` uses the embedded
    // Excalidraw editor (the host's `renderExcalidraw` capability reads/writes
    // the file itself). Either way there's no text pipeline — clear the
    // text-centric signals and let PaneView swap to the right view by kind.
    if (kind === "image" || kind === "pdf" || kind === "excalidraw") {
      targetPane.setHtml("");
      targetPane.setFrontmatter(null);
      targetPane.setEditorContent("");
      targetPane.setSavedContent("");
      watch([]);
      markTabLoaded("", "", null, []);
      clearDiskChange();
      if (!external) targetPane.setLoading(false);
      return;
    }

    // Yield to let the UI render loading state before heavy conversion
    await new Promise((r) => setTimeout(r, 0));
    if (tab && !documentTab) {
      documentTab = getDocumentTab();
      diskChange = documentTab?.diskChange;
    }

    // Paths this load wants to watch. Filled as soon as they are known so the
    // error path below can keep the watcher on the file that failed.
    let watchedIncludes: string[] = [];
    let readContent: string | undefined;

    try {
      if (superseded() || keepLocalReload()) return;
      const absolutePath = `${root}/${entry.path}`;
      // A save can land while a watcher read is in flight: the text read may
      // then predate it, and adopting it would put the old disk text back over
      // a confirmed save. A save confirmed (saved text changed) or begun (own
      // write counted) since the read started means read again; if saves keep
      // landing, their own events refresh the document.
      const writeState = () => ({ saved: targetPane.savedContent(), writes: ownWrites?.revision() ?? 0 });
      let content = "";
      let settled = false;
      for (let attempt = 0; attempt < 3 && !settled; attempt++) {
        const before = writeState();
        try {
          content = await readFileContent(absolutePath);
        } catch (readErr) {
          if (failureStale() || keepLocalReload()) return;
          // The buffer may have become dirty while the watcher read was in flight.
          if (external && targetPane.editorContent() !== targetPane.savedContent()) return;
          // read_file (read_to_string) throws on non-UTF8 input. A binary
          // that isn't an image/PDF (handled above) can be neither rendered
          // nor edited as text → mark it unsupported so PaneView shows the
          // notice. A *document* that fails to read is a real error — rethrow
          // to the outer catch.
          if (isSupportedFile(entry.path)) throw readErr;
          targetPane.setHtml(UNSUPPORTED_CONTENT);
          state.notePreviewFailed(targetPane, targetRootId ?? null, entry.path);
          targetPane.setFrontmatter(null);
          targetPane.setEditorContent("");
          targetPane.setSavedContent("");
          if (isFocused()) void watcher.stop();
          return;
        }
        if (superseded() || keepLocalReload()) return;
        const after = writeState();
        settled = !external || (after.saved === before.saved && after.writes === before.writes);
      }
      if (!settled) return;
      readContent = content;
      // A watcher refresh decides between the disk and the live buffer.
      // `source` is the text to render; `adoptDisk` whether the buffer takes
      // the disk text. A normal load always adopts the disk.
      const bufferAtRead = targetPane.editorContent();
      let source = content;
      let adoptDisk = true;
      if (external) {
        const decision = decideExternalReload({
          disk: content,
          saved: targetPane.savedContent(),
          current: bufferAtRead,
        });
        if (decision === "keep-local") return;
        if (decision === "rerender") {
          // The event is only the echo of our own autosave: the preview was
          // converted from this very text when it was typed. Converting again
          // is the whole cost of a second render per edit.
          // That holds only while the HTML on screen was converted from exactly
          // this text (or a conversion of it is on its way): an error on
          // screen, the HTML of another text or nothing published converts
          // again. A file with no preview has nothing to publish.
          if (ownWrites && eventIsOnly(normalizeEventPath(absolutePath), eventPaths?.map(normalizeEventPath))) {
            const errorsBefore = errorsPublished.get(targetPane) ?? 0;
            if (await ownWrites.matches(absolutePath, await hashContent(content))
              && (!isSupportedFile(entry.path)
                || await state.previewReflects(targetPane, targetRootId ?? null, entry.path, bufferAtRead))
              // Checked in the same turn that confirms: an error published while
              // the preview was being checked is on screen now.
              && (errorsPublished.get(targetPane) ?? 0) === errorsBefore) {
              // The echo confirmed the publication: work that started before it
              // can no longer put an error over this preview.
              if (!superseded()) {
                latestConfirmed.set(targetPane, Math.max(latestConfirmed.get(targetPane) ?? 0, order));
              }
              return false;
            }
          }
          source = bufferAtRead;
          adoptDisk = false;
        }
        if (!claim()) return;
        // The echo check above awaits: re-validate the pane after it.
        if (superseded()) return;
      }
      // Includes and conversion are async: by the time they finish, the
      // refresh may be outdated, or the user may have typed — never apply a
      // result over text newer than what it was based on.
      const stale = () =>
        superseded() || (external && targetPane.editorContent() !== bufferAtRead);

      // Non-previewable text (json, txt, yaml, …) skips conversion entirely
      // and opens straight in the editor. The createEffect in app state
      // forces "edit" mode because canPreview() is false for these.
      if (!isSupportedFile(entry.path)) {
        if (!adoptDisk) return;
        targetPane.setHtml("");
        targetPane.setFrontmatter(null);
        targetPane.setEditorContent(content);
        targetPane.setSavedContent(content);
        markTabLoaded(content, "", null, []);
        clearDiskChange();
        watch([]);
        return external;
      }

      // Direct include paths of a text. Markdown includes are resolved one by
      // one by its processor, so they are batch-read here in a single IPC call;
      // AsciiDoc's collector reads the first layer itself, in one batch, and
      // reads a missing file there too (no second batch for the same layer).
      const baseDir = entry.path.includes("/") ? entry.path.substring(0, entry.path.lastIndexOf("/")) : "";
      const isMarkdown = isMdFile(entry.path);
      const scanPaths = isMarkdown
        ? getMarkdownIncludePaths(source, baseDir)
        : getIncludePaths(source, baseDir);
      watchedIncludes = scanPaths;

      const includeFileCache = new Map<string, string>();
      if (isMarkdown && scanPaths.length > 0) {
        for (const [path, text] of await readFilesRelative(root, scanPaths)) includeFileCache.set(path, text);
        watchedIncludes = Array.from(new Set([...scanPaths, ...includeFileCache.keys()]));
      }

      // Edits of this document convert with this reader (this root and cache),
      // not with whichever file loaded last. An outdated load must not replace
      // a newer one's reader.
      if (superseded() || keepLocalReload()) return;
      const consulted = new Set(scanPaths);
      const reader = createReader(root, targetRootId, includeFileCache, consulted);
      const { readFile, readFiles } = reader;
      state.registerReader(targetPane, targetRootId ?? null, entry.path, reader);

      const result = await state.convert(entry.path, source, readFile, readFiles!);
      watchedIncludes = Array.from(new Set([...scanPaths, ...includeFileCache.keys()]));

      // Yield again before DOM update to prevent long frame
      await new Promise((r) => setTimeout(r, 0));

      if (stale() || keepLocalReload()) return;
      if (tab && documentTab && targetPane.tabs.getTab(tab.id)?.diskChange !== diskChange) {
        // A watcher event arrived after this load began. The newer load
        // inherits the target without adding a second history entry.
        return await load(entry, { ...opts, pushHistory: false });
      }
      targetPane.setHtml(result.html);
      targetPane.setFrontmatter(result.frontmatter);
      state.notePreviewed(targetPane, targetRootId ?? null, entry.path, source);
      if (adoptDisk) {
        targetPane.setEditorContent(content);
        targetPane.setSavedContent(content);
      }

      markTabLoaded(content, result.html, result.frontmatter, Array.from(consulted));
      clearDiskChange();
      watch(watchedIncludes);
      return external && adoptDisk;
    } catch (e) {
      if (failureStale() || keepLocalReload()) return;
      console.error("Failed to convert file:", e);
      const errorHtml = `<div class="error">Error converting file: ${e}</div>`;
      errorsPublished.set(targetPane, (errorsPublished.get(targetPane) ?? 0) + 1);
      targetPane.setHtml(errorHtml);
      state.notePreviewFailed(targetPane, targetRootId ?? null, entry.path);
      // A completed first read remains editable and recoverable even when
      // conversion fails. Read failures must remain pending instead.
      if (tab && readContent !== undefined) {
        targetPane.setEditorContent(readContent);
        targetPane.setSavedContent(readContent);
        targetPane.setFrontmatter(null);
        markTabLoaded(readContent, errorHtml, null, watchedIncludes);
      }
      if (documentTab && !targetPane.tabs.getTab(documentTab.id)?.diskChange) {
        targetPane.tabs.updateTabContent(documentTab.id, { diskChange: Symbol() });
      }
      // Keep the watcher on the file (and its includes) that failed: the next
      // save on disk must reach refreshFromDisk, or the preview stays on the
      // error until the user reopens the tab. A previous file's target must
      // not linger here, which is exactly what used to happen.
      watch(watchedIncludes);
    } finally {
      if (!external && latestLoad.get(targetPane) === request) targetPane.setLoading(false);
    }
  }

  return { loadFileContent, loadTabContent, refreshFromDisk, syncWatcher, markDiskChanges, handleWatcherChange };
}
