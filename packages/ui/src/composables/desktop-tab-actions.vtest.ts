import { createComponent, createRoot, createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { EditorView } from "@codemirror/view";
import type { FSEntry } from "@markdraw/core/types.ts";
import type { TabState } from "@markdraw/core/tabs.ts";
import { UNSUPPORTED_CONTENT } from "@markdraw/core/utils.ts";
import { createFileAutosave } from "../../../../apps/desktop/src/lib/file-autosave.ts";
import { createFolder } from "../../../../apps/desktop/src/lib/folder.ts";
import { createFileLoader } from "../../../../apps/desktop/src/lib/file-loader.ts";
import { createOwnWrites, type OwnWrites } from "../../../../apps/desktop/src/lib/external-reload.ts";
import { createTabActions } from "../../../../apps/desktop/src/lib/tab-actions.ts";
import { SCRATCH_ROOT_ID, isScratchPath } from "../../../../apps/desktop/src/lib/scratch.ts";
import { setLocale } from "@markdraw/i18n/runtime";
import { switchLocale } from "@markdraw/i18n/solid";
import { FileWatcher } from "../../../../apps/desktop/src/lib/watcher.ts";
import { createAppState, type AppState } from "./create-app-state.ts";
import { createPaneManager } from "./create-pane-manager.ts";
import { createPaneStore, createSessionRestore, type PaneStore } from "./create-pane-store.ts";
import { getOpenRoots, setOpenRoots, setPendingTabRoots, setTabSession } from "@markdraw/core/tabs.ts";
import { PaneView } from "../components/pane-view.tsx";
import { TabBar } from "../components/tab-bar.tsx";
import { DragDropProvider } from "../lib/dnd/index.ts";
import { tabDisplayName } from "./create-tab-store.ts";
import { createNavigation } from "../../../../apps/desktop/src/lib/navigation.ts";

// Partial mock: the pane tests render without a drag provider, but the mounted
// app needs the real `DragDropProvider` and the rest of the module.
vi.mock("../lib/dnd/index.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/dnd/index.ts")>(),
  useDroppable: () => ({ ref: () => {}, isDropTarget: () => false }),
}));

const workspace = "/workspace";
const alpha: FSEntry = { kind: "file", name: "alpha.md", path: "alpha.md" };
const beta: FSEntry = { kind: "file", name: "beta.md", path: "beta.md" };
const layoutKey = "markdraw-pane-layout";
const invoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>();
const disposeFixtures: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  invoke.mockImplementation(async (command) => {
    if (command === "read_dir") return [alpha, beta];
    if (command === "plugin:event|listen") return 1;
  });
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke, transformCallback: () => 1 });
  vi.stubGlobal("__TAURI_EVENT_PLUGIN_INTERNALS__", { unregisterListener: vi.fn() });
});

afterEach(async () => {
  try {
    cleanup();
    for (const dispose of disposeFixtures.splice(0)) await dispose();
    vi.clearAllTimers();
  } finally {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    invoke.mockReset();
    vi.restoreAllMocks();
  }
});

function fixture(readIncludes = false, ownWrites?: OwnWrites) {
  const watcher = new FileWatcher(() => {});
  return createRoot((dispose) => {
    disposeFixtures.push(async () => {
      dispose();
      await watcher.destroy();
    });
    const paneManager: ReturnType<typeof createPaneManager> = createPaneManager({
      onTabSelected: (pane, tab) => { void actions.selectTab(pane, tab); },
    });
    const state: AppState = createAppState({
      paneManager,
      getStoredTheme: () => "system",
      applyTheme: () => {},
      convertAdoc: async () => { throw new Error("Unexpected conversion"); },
      convertMarkdown: async ({ fileContent, readFile }) => {
        const include = readIncludes ? fileContent.match(/<!-- include: (.+?) -->/)?.[1] : undefined;
        const text = include ? await readFile?.(include) : fileContent;
        return { html: `<p>${text}</p>`, frontmatter: null, toc: null, meta: {} };
      },
    });
    const [rootPaths, setRootPaths] = createSignal(new Map<string, string>());
    const loader = createFileLoader({ state, rootPaths, watcher, ownWrites });
    const actions: ReturnType<typeof createTabActions> = createTabActions({
      state, rootPaths, syncWatcher: loader.syncWatcher, loadTabContent: loader.loadTabContent,
      loadFileContent: loader.loadFileContent,
    });
    const folder: ReturnType<typeof createFolder> = createFolder({
      state, rootPaths, setRootPaths, watcher,
      onRootClosed: actions.closeRootTabs,
      onFileRenamed: actions.renameOpenTab,
    });
    createFileAutosave(state, folder.handleEditorSave, () => {});
    return { state, paneManager, rootPaths, actions, folder, watcher, loader };
  });
}

function openDocument(pane: PaneStore, entry: FSEntry, buffer: string) {
  const id = pane.tabs.openTab(entry, workspace);
  pane.setEditorContent(buffer);
  pane.setSavedContent(buffer);
  pane.setEditorMode("split");
  pane.setSelectedFile(entry);
  pane.setSelectedRootId(workspace);
  flush();
  return id;
}

function calls(command: string) {
  return invoke.mock.calls.filter(([called]) => called === command).map(([, args]) => args);
}

function mockWatcherHolder(holdFirst: "watch_paths" | "stop_watching") {
  const defaultImplementation = invoke.getMockImplementation()!;
  const response = Promise.withResolvers<void>();
  const applied: (string[] | null)[] = [];
  let blocked = false;
  invoke.mockImplementation(async (command, args) => {
    if (command !== "watch_paths" && command !== "stop_watching") {
      return defaultImplementation(command, args);
    }
    if (command === holdFirst && !blocked) {
      blocked = true;
      await response.promise;
    }
    applied.push(command === "watch_paths" ? args.paths as string[] : null);
  });
  return { response, applied };
}

function holdMcpClose() {
  const response = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  const defaultImplementation = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => {
    if (command === "mcp_set_roots") {
      received.resolve();
      return response.promise;
    }
    return defaultImplementation(command, args);
  });
  return { response, received };
}

describe("watcher recovery and rename regressions", () => {
  it("recovers an initially failed conversion on the next watcher event", async () => {
    const { state, folder, paneManager } = fixture();
    const doc: FSEntry = { kind: "file", name: "broken.adoc", path: "broken.adoc" };
    let disk = "broken";
    const convert = vi.spyOn(state, "convert").mockImplementation(async (_path, source) => {
      if (source === "broken") throw new Error("conversion failed");
      return { html: "<p>corrected</p>", frontmatter: null, toc: null, meta: {} };
    });
    const callbacks: (() => void)[] = [];
    let live: ((event: { payload: unknown }) => void) | undefined;
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke, transformCallback: (callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length;
    } });
    let observed: Promise<boolean> | undefined;
    let loader: ReturnType<typeof createFileLoader>;
    const refresh = new FileWatcher(() => {
      const pane = paneManager.activePane();
      const file = pane.selectedFile();
      if (!file || pane.tabs.getActiveTab()?.needsLoad) return;
      observed = loader.refreshFromDisk(file);
    });
    disposeFixtures.push(() => refresh.destroy());
    const setup = createRoot((dispose) => {
      const [rootPaths] = createSignal(new Map([[workspace, workspace]]));
      loader = createFileLoader({ state, rootPaths, watcher: refresh });
      const actions = createTabActions({ state, rootPaths, syncWatcher: loader.syncWatcher,
        loadTabContent: loader.loadTabContent, loadFileContent: loader.loadFileContent });
      return { actions, dispose };
    });
    disposeFixtures.push(async () => setup.dispose());
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return [doc];
      if (command === "read_file") return disk;
      if (command === "plugin:event|listen") {
        if (args.event === "fs-change") live = callbacks[Number(args.handler) - 1];
        return 1;
      }
      if (command === "stop_watching") live = undefined;
    });
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    const opened = setup.actions.openFile(doc, workspace, true);
    await vi.advanceTimersByTimeAsync(10);
    await opened;
    expect(pane.html()).toContain("conversion failed");
    const tabId = pane.tabs.activeTabId();
    expect(pane.editorContent()).toBe("broken");
    expect(pane.tabs.getActiveTab()?.needsLoad).toBe(false);
    expect(live).toBeDefined();
    disk = "corrected";
    live?.({ payload: { paths: [`${workspace}/broken.adoc`] } });
    await vi.advanceTimersByTimeAsync(10);
    await observed;
    expect(pane.html()).toBe("<p>corrected</p>");
    expect(pane.editorContent()).toBe("corrected");
    expect(pane.tabs.activeTabId()).toBe(tabId);
    expect(convert).toHaveBeenCalledTimes(2);
    expect(calls("plugin:event|listen").filter((args) => args.event === "fs-change")).toHaveLength(1);
  });

  it("keeps the moved buffer and watcher when a deleted destination still has an open tab", async () => {
    const { folder, paneManager, watcher } = fixture();
    const other = "/other";
    const moved = { ...alpha, path: "sub/alpha.md" };
    const sub: FSEntry = { kind: "directory", path: "sub", name: "sub", children: [] };
    let didMove = false;
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return args.path === other ? [{ ...sub, children: didMove ? [moved] : [] }] : didMove ? [beta] : [alpha, beta];
      if (command === "move_path") { didMove = true; return; }
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(other);
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    const stale = pane.tabs.openTab(moved, other, { background: true });
    pane.tabs.updateTabContent(stale, { editorContent: "Stale unsaved", savedContent: "Stale saved" });
    flush();
    openDocument(pane, alpha, "Source saved");
    pane.setEditorContent("Source unsaved");
    watcher.setTarget({ filePath: `${workspace}/alpha.md`, includePaths: [], rootPath: workspace });
    await watcher.start();
    flush();
    await folder.handleMove(alpha, "sub", workspace, other);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls("move_path")).toHaveLength(1);
    expect(pane.tabs.getActiveTab()).toMatchObject({ rootId: other, filePath: moved.path, editorContent: "Source unsaved" });
    expect(pane.tabs.activeTabId()).not.toBe(`${workspace}::alpha.md`);
    expect(pane.selectedFile()).toEqual(moved);
    expect(pane.editorContent()).toBe("Source unsaved");
    expect(calls("watch_paths").at(-1)).toEqual({ paths: [`${other}/sub/alpha.md`] });
    expect(new Set(pane.tabs.tabs().map((tab) => tab.id)).size).toBe(pane.tabs.tabs().length);
    expect(pane.tabs.tabs()).toHaveLength(1);
    expect(stale).toBe(`${other}::sub/alpha.md`);
    // The displaced edits survive only as a draft with no file behind it.
    const restored = pane.tabs.reopenClosedTab();
    flush();
    expect(restored).toMatchObject({
      rootId: SCRATCH_ROOT_ID, editorContent: "Stale unsaved", savedContent: "", needsLoad: false,
    });
    expect(isScratchPath(restored?.filePath)).toBe(true);
    expect(restored?.id).not.toBe(stale);
    expect(new Set(pane.tabs.tabs().map((tab) => tab.id)).size).toBe(pane.tabs.tabs().length);
    expect(pane.editorContent()).toBe("Stale unsaved");
    expect(pane.selectedRootId()).toBe(SCRATCH_ROOT_ID);
    // Neither the draft's activation nor its autosave may touch the moved file.
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls("write_file").map((args) => args.content)).not.toContain("Stale unsaved");
    expect(calls("write_file").every((args) => args.path === `${other}/sub/alpha.md`)).toBe(true);
    // The tab of the moved file still shows what the move put on disk.
    const file = pane.tabs.findTabByFile(moved.path, other)!;
    expect(file).toMatchObject({ savedContent: "Source saved", needsLoad: false });
  });

  it("drops a clean displaced destination tab instead of keeping an obsolete buffer", async () => {
    const { folder, paneManager } = fixture();
    const other = "/other";
    const moved = { ...alpha, path: "sub/alpha.md" };
    const sub: FSEntry = { kind: "directory", path: "sub", name: "sub", children: [] };
    let didMove = false;
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return args.path === other ? [{ ...sub, children: didMove ? [moved] : [] }] : didMove ? [beta] : [alpha, beta];
      if (command === "move_path") { didMove = true; return; }
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(other);
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    const stale = pane.tabs.openTab(moved, other, { background: true });
    pane.tabs.updateTabContent(stale, { editorContent: "Old disk", savedContent: "Old disk" });
    flush();
    openDocument(pane, alpha, "Source saved");
    await folder.handleMove(alpha, "sub", workspace, other);
    await vi.advanceTimersByTimeAsync(10);
    expect(pane.tabs.getActiveTab()).toMatchObject({ rootId: other, filePath: moved.path, editorContent: "Source saved" });
    expect(pane.tabs.tabs()).toHaveLength(1);
    expect(pane.tabs.reopenClosedTab()).toBeUndefined();
  });

  it.each([
    ["rename", "directory"], ["move", "directory"], ["rename", "file"], ["move", "file"],
  ] as const)("retains the moved identity after switching tabs while %s of a %s refreshes", async (operation, kind) => {
    const { folder, paneManager, actions } = fixture();
    const guide = kind === "directory" ? { ...alpha, path: "docs/alpha.md" } : alpha;
    const path = kind === "directory"
      ? operation === "rename" ? "manual/alpha.md" : "manual/docs/alpha.md"
      : operation === "rename" ? "manual.md" : "manual/alpha.md";
    const renamed = { ...alpha, path, name: path.slice(path.lastIndexOf("/") + 1) };
    const dir: FSEntry = { kind: "directory", name: "docs", path: "docs", children: [guide] };
    const entry = kind === "directory" ? dir : guide;
    const refresh = Promise.withResolvers<FSEntry[]>();
    let moved = false;
    invoke.mockImplementation(async (command) => {
      if (command === "read_dir") return moved ? refresh.promise : [entry, beta];
      if (command === "rename_file") { moved = true; return; }
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(workspace);
    openDocument(paneManager.activePane(), beta, "Left");
    const right = paneManager.splitFromActive()!;
    flush();
    const betaId = openDocument(right, beta, "Beta");
    openDocument(right, guide, "Saved");
    right.setEditorContent("Unsaved");
    paneManager.setActivePane(0);
    flush();
    const pending = operation === "rename"
      ? folder.handleRename(entry, workspace, kind === "directory" ? "manual" : "manual.md")
      : folder.handleMove(entry, "manual", workspace);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(moved).toBe(true);
      expect(right.tabs.getActiveTab()?.filePath).toBe(path);
      paneManager.setActivePane(1);
      flush();
      const movedId = right.tabs.activeTabId()!;
      await actions.activateTab(right, betaId);
      flush();
      await actions.activateTab(right, movedId);
      flush();
      expect(right.selectedFile()?.path).toBe(path);
      expect(right.editorContent()).toBe("Unsaved");
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls("write_file")).toEqual([{ path: `${workspace}/${path}`, content: "Unsaved" }]);
    } finally {
      refresh.resolve(operation === "rename" && kind === "file"
        ? [renamed, beta]
        : [{ kind: "directory", name: "manual", path: "manual", children: [renamed] }, beta]);
      await pending;
    }
  });

  it("keeps the pending identity when a read started before the rename resolves first with another change", async () => {
    const { folder, paneManager, actions } = fixture();
    const guide = { ...alpha, path: "docs/alpha.md" };
    const renamed = { ...alpha, path: "manual/alpha.md" };
    const dir: FSEntry = { kind: "directory", name: "docs", path: "docs", children: [guide] };
    const sibling: FSEntry = { kind: "file", name: "created.md", path: "created.md" };
    const reads: PromiseWithResolvers<FSEntry[]>[] = [];
    let held = false;
    let moved = false;
    invoke.mockImplementation(async (command) => {
      if (command === "read_dir") {
        if (!held) return [dir, beta];
        const read = Promise.withResolvers<FSEntry[]>();
        reads.push(read);
        return read.promise;
      }
      if (command === "rename_file") { moved = true; return; }
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    const betaId = openDocument(pane, beta, "Beta");
    const docId = openDocument(pane, guide, "Saved");
    pane.setEditorContent("Unsaved");
    flush();
    held = true;
    const older = folder.refreshRoot(workspace);
    await vi.advanceTimersByTimeAsync(1);
    const pending = folder.handleRename(dir, workspace, "manual");
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(moved).toBe(true);
      expect(reads).toHaveLength(2);
      // The older read answers after the rename with a sibling created beside the folder.
      reads[0]!.resolve([dir, beta, sibling]);
      await older;
      await vi.advanceTimersByTimeAsync(1);
      const movedId = pane.tabs.activeTabId()!;
      expect(movedId).not.toBe(docId);
      await actions.activateTab(pane, betaId);
      flush();
      await actions.activateTab(pane, movedId);
      flush();
      expect(pane.selectedFile()?.path).toBe(renamed.path);
      expect(pane.selectedRootId()).toBe(workspace);
      expect(pane.editorContent()).toBe("Unsaved");
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls("write_file")).toEqual([{ path: `${workspace}/${renamed.path}`, content: "Unsaved" }]);
    } finally {
      reads[1]?.resolve([{ kind: "directory", name: "manual", path: "manual", children: [renamed] }, beta, sibling]);
      await pending;
    }
    // Once the tree has read the new name, the lookup no longer needs the fallback.
    await actions.activateTab(pane, betaId);
    flush();
    await actions.activateTab(pane, pane.tabs.findTabByFile(renamed.path, workspace)!.id);
    flush();
    expect(pane.selectedFile()?.path).toBe(renamed.path);
    expect(pane.selectedRootId()).toBe(workspace);
    // The fallback is gone: a file removed from disk afterwards is not resurrected by it.
    held = false;
    invoke.mockImplementation(async (command) => {
      if (command === "read_dir") return [beta, sibling];
      if (command === "plugin:event|listen") return 1;
    });
    await folder.refreshRoot(workspace);
    await actions.activateTab(pane, betaId);
    flush();
    await actions.activateTab(pane, pane.tabs.findTabByFile(renamed.path, workspace)!.id);
    flush();
    expect(pane.selectedFile()).toBeNull();
  });

  it("retargets duplicate background tabs without replacing the active stale destination buffer", async () => {
    const { folder, paneManager, actions } = fixture();
    const guide = { ...alpha, path: "docs/alpha.md" };
    const renamed = { ...alpha, path: "manual/alpha.md" };
    const dir: FSEntry = { kind: "directory", name: "docs", path: "docs", children: [guide] };
    const refresh = Promise.withResolvers<FSEntry[]>();
    let moved = false;
    invoke.mockImplementation(async (command) => {
      if (command === "read_dir") return moved ? refresh.promise : [dir, beta];
      if (command === "rename_file") { moved = true; return; }
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(workspace);
    openDocument(paneManager.activePane(), beta, "Left");
    const right = paneManager.splitFromActive()!;
    flush();
    const first = right.tabs.openTab(guide, workspace, { background: true });
    const second = right.tabs.openTab(guide, workspace, { background: true });
    right.tabs.updateTabContent(first, { editorContent: "First", savedContent: "First" });
    right.tabs.updateTabContent(second, { editorContent: "Second", savedContent: "Second" });
    flush();
    const stale = openDocument(right, renamed, "Stale buffer");
    paneManager.setActivePane(0);
    flush();
    const pending = folder.handleRename(dir, workspace, "manual");
    try {
      await vi.advanceTimersByTimeAsync(1);
      const tabs = right.tabs.tabs();
      expect(tabs.filter((tab) => tab.filePath === guide.path)).toEqual([]);
      expect(tabs.filter((tab) => tab.filePath === renamed.path)).toHaveLength(3);
      expect(new Set(tabs.map((tab) => tab.id)).size).toBe(tabs.length);
      expect(right.tabs.activeTabId()).toBe(stale);
      expect(right.editorContent()).toBe("Stale buffer");
      const movedTab = tabs.find((tab) => tab.editorContent === "Second")!;
      paneManager.setActivePane(1);
      flush();
      await actions.activateTab(right, movedTab.id);
      flush();
      expect(right.selectedFile()).toEqual(renamed);
      expect(right.editorContent()).toBe("Second");
    } finally {
      refresh.resolve([{ ...dir, name: "manual", path: "manual", children: [renamed] }, beta]);
      await pending;
    }
  });

  it("preserves duplicate source buffers when the active copy is moved first", async () => {
    const { folder, paneManager } = fixture();
    const guide = { ...alpha, path: "docs/alpha.md" };
    const renamed = { ...alpha, path: "manual/alpha.md" };
    const dir: FSEntry = { kind: "directory", name: "docs", path: "docs", children: [guide] };
    let moved = false;
    invoke.mockImplementation(async (command) => {
      if (command === "read_dir") return moved ? [{ ...dir, name: "manual", path: "manual", children: [renamed] }] : [dir];
      if (command === "rename_file") { moved = true; return; }
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    const background = pane.tabs.openTab(guide, workspace, { background: true });
    pane.tabs.updateTabContent(background, { editorContent: "Background unsaved", savedContent: "Background saved" });
    flush();
    openDocument(pane, guide, "Active saved");
    pane.setEditorContent("Active unsaved");
    flush();
    await folder.handleRename(dir, workspace, "manual");
    await vi.advanceTimersByTimeAsync(1);
    const tabs = pane.tabs.tabs();
    expect(tabs).toHaveLength(2);
    expect(tabs.map((tab) => tab.filePath)).toEqual([renamed.path, renamed.path]);
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(2);
    expect(tabs.find((tab) => tab.editorContent === "Background unsaved")?.savedContent).toBe("Background saved");
    expect(pane.tabs.getActiveTab()?.filePath).toBe(renamed.path);
    expect(pane.editorContent()).toBe("Active unsaved");
  });

  it("keeps a cross-root move in another pane when switching tabs during the source refresh", async () => {
    const { folder, paneManager, actions } = fixture();
    const other = "/other";
    const moved = { ...alpha, path: "sub/alpha.md" };
    const sub: FSEntry = { kind: "directory", name: "sub", path: "sub", children: [] };
    const refresh = Promise.withResolvers<FSEntry[]>();
    let didMove = false;
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return args.path === other ? [{ ...sub, children: didMove ? [moved] : [] }] : didMove ? refresh.promise : [alpha, beta];
      if (command === "move_path") { didMove = true; return; }
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(other);
    await folder.openFolderPath(workspace);
    openDocument(paneManager.activePane(), beta, "Left");
    const right = paneManager.splitFromActive()!;
    flush();
    const betaId = openDocument(right, beta, "Beta");
    openDocument(right, alpha, "Saved");
    right.setEditorContent("Unsaved");
    paneManager.setActivePane(0);
    flush();
    const moving = folder.handleMove(alpha, "sub", workspace, other);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(didMove).toBe(true);
      expect(right.tabs.getActiveTab()).toMatchObject({ rootId: other, filePath: moved.path });
      paneManager.setActivePane(1);
      flush();
      const movedId = right.tabs.activeTabId()!;
      await actions.activateTab(right, betaId);
      flush();
      await actions.activateTab(right, movedId);
      flush();
      expect(right.selectedRootId()).toBe(other);
      expect(right.selectedFile()).toEqual(moved);
      expect(right.editorContent()).toBe("Unsaved");
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls("write_file")).toEqual([{ path: `${other}/${moved.path}`, content: "Unsaved" }]);
    } finally {
      refresh.resolve([beta]);
      await moving;
    }
  });

  it("moves a dirty active tab across roots without selecting a pending sibling", async () => {
    const { folder, paneManager, watcher } = fixture();
    const other = "/other";
    const moved = { ...alpha, path: "sub/alpha.md" };
    const sub: FSEntry = { kind: "directory", path: "sub", name: "sub", children: [moved] };
    let didMove = false;
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return args.path === other ? [sub] : didMove ? [beta] : [alpha, beta];
      if (command === "move_path") { didMove = true; return; }
      if (command === "read_file") return "Beta disk";
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(other);
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    openDocument(pane, alpha, "Alpha saved");
    const sibling = pane.tabs.openTab(beta, workspace, { background: true });
    pane.tabs.markTabNeedsLoad(sibling);
    pane.setEditorContent("Alpha unsaved");
    watcher.setTarget({ filePath: workspace + "/alpha.md", includePaths: [], rootPath: workspace });
    await watcher.start();
    flush();
    await vi.advanceTimersByTimeAsync(0);
    await folder.handleMove(alpha, "sub", workspace, other);
    await vi.advanceTimersByTimeAsync(10);
    expect(pane.tabs.getActiveTab()).toMatchObject({ rootId: other, filePath: moved.path,
      editorContent: "Alpha unsaved", savedContent: "Alpha saved" });
    expect(pane.editorContent()).toBe("Alpha unsaved");
    expect(pane.tabs.getTab(sibling)?.needsLoad).toBe(true);
    expect(calls("read_file")).toEqual([]);
    expect(calls("watch_paths").at(-1)).toEqual({ paths: [other + "/sub/alpha.md"] });
    expect(calls("stop_watching")).toHaveLength(0);
  });

  it("renames an active descendant in another pane and autosaves only at the new path", async () => {
    const { folder, paneManager } = fixture();
    const guide: FSEntry = { ...alpha, path: "docs/alpha.md" };
    const next: FSEntry = { ...alpha, path: "manual/alpha.md" };
    const dir: FSEntry = { kind: "directory", name: "docs", path: "docs", children: [guide] };
    let entries = [dir, beta];
    invoke.mockImplementation(async (command) => {
      if (command === "read_dir") return entries;
      if (command === "rename_file") entries = [{ ...dir, name: "manual", path: "manual", children: [next] }, beta];
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(workspace);
    const left = paneManager.activePane();
    openDocument(left, beta, "Beta saved");
    const right = paneManager.splitFromActive()!;
    flush();
    openDocument(right, guide, "Alpha saved");
    right.setEditorContent("Alpha unsaved");
    paneManager.setActivePane(0);
    flush();
    await folder.handleRename(dir, workspace, "manual");
    await vi.advanceTimersByTimeAsync(0);
    expect(right.tabs.getActiveTab()?.filePath).toBe(next.path);
    expect(right.selectedFile()?.path).toBe(next.path);
    expect(right.editorContent()).toBe("Alpha unsaved");
    paneManager.setActivePane(1);
    flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls("watch_paths").at(-1)).toEqual({ paths: [workspace + "/manual/alpha.md"] });
    expect(calls("write_file")).toEqual([{ path: workspace + "/manual/alpha.md", content: "Alpha unsaved" }]);
  });

  it("updates another pane before a delayed tree refresh can autosave", async () => {
    const { folder, paneManager } = fixture();
    const guide = { ...alpha, path: "docs/alpha.md" };
    const renamed = { ...alpha, path: "manual/alpha.md" };
    const dir: FSEntry = { kind: "directory", name: "docs", path: "docs", children: [guide] };
    const refresh = Promise.withResolvers<FSEntry[]>();
    let moved = false;
    invoke.mockImplementation(async (command) => {
      if (command === "read_dir") return moved ? refresh.promise : [dir, beta];
      if (command === "rename_file") { moved = true; return; }
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(workspace);
    openDocument(paneManager.activePane(), beta, "Beta");
    const right = paneManager.splitFromActive()!;
    flush();
    openDocument(right, guide, "Saved");
    right.setEditorContent("Unsaved");
    paneManager.setActivePane(0);
    flush();
    const rename = folder.handleRename(dir, workspace, "manual");
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(right.selectedFile()?.path).toBe(renamed.path);
      paneManager.setActivePane(1);
      flush();
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls("write_file")).toEqual([{ path: `${workspace}/${renamed.path}`, content: "Unsaved" }]);
    } finally {
      refresh.resolve([{ ...dir, name: "manual", path: "manual", children: [renamed] }, beta]);
      await rename;
    }
  });

  it("autosaves a cross-root move at the destination while the trees still refresh, even with the same relative path", async () => {
    const { folder, paneManager, state } = fixture();
    const other = "/workspace-two";
    const refresh = Promise.withResolvers<FSEntry[]>();
    const reached = Promise.withResolvers<void>();
    let moved = false;
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") {
        if (moved && args.path === workspace) {
          reached.resolve();
          return refresh.promise;
        }
        return args.path === other && moved ? [alpha] : [alpha, beta];
      }
      if (command === "move_path") { moved = true; return; }
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(other);
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    openDocument(pane, alpha, "original buffer");

    const moving = folder.handleMove(alpha, "", workspace, other);
    try {
      await reached.promise;
      flush();
      // The tab changed identity as soon as the file moved on disk, before any read.
      expect(pane.selectedRootId()).toBe(other);
      expect(pane.tabs.getActiveTab()).toMatchObject({ rootId: other, filePath: alpha.path });
      expect(state.selectedRootId()).toBe(other);
      pane.setEditorContent("edit during refresh");
      flush();
      await vi.advanceTimersByTimeAsync(1001);
      expect(calls("write_file")).toEqual([{ path: `${other}/alpha.md`, content: "edit during refresh" }]);
      expect(calls("write_file").map(({ path }) => path)).not.toContain(`${workspace}/alpha.md`);
    } finally {
      refresh.resolve([beta]);
      await moving;
    }
  });

  it.each(["rename", "move"])("restarts another pane's pending read after an ancestor %s", async (operation) => {
    const { folder, paneManager, actions } = fixture();
    const oldRead = Promise.withResolvers<string>();
    const newRead = Promise.withResolvers<string>();
    const guide = { ...alpha, path: "docs/alpha.md" };
    const renamed = { ...alpha, path: operation === "rename" ? "manual/alpha.md" : "manual/docs/alpha.md" };
    const dir: FSEntry = { kind: "directory", name: "docs", path: "docs", children: [guide] };
    let entries = [dir, beta];
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return entries;
      if (command === "read_file") return args.path === `${workspace}/${guide.path}` ? oldRead.promise : newRead.promise;
      if (command === "rename_file") entries = [{ ...dir, name: "manual", path: "manual", children: [renamed] }, beta];
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(workspace);
    const left = paneManager.activePane();
    openDocument(left, beta, "Beta");
    const right = paneManager.splitFromActive()!;
    flush();
    paneManager.setActivePane(1);
    flush();
    const opening = actions.openFile(guide, workspace, true);
    try {
      await vi.advanceTimersByTimeAsync(1);
      paneManager.setActivePane(0);
      flush();
      if (operation === "rename") await folder.handleRename(dir, workspace, "manual");
      else await folder.handleMove(dir, "manual", workspace);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls("read_file")).toEqual([{ path: `${workspace}/${guide.path}` }, { path: `${workspace}/${renamed.path}` }]);
      oldRead.resolve("stale");
      await vi.advanceTimersByTimeAsync(1);
      await opening;
      expect(right.tabs.getActiveTab()?.needsLoad).toBe(true);
      newRead.resolve("new content");
      await vi.advanceTimersByTimeAsync(10);
      expect(right.selectedFile()?.path).toBe(renamed.path);
      expect(right.editorContent()).toBe("new content");
      expect(right.tabs.getActiveTab()?.needsLoad).toBe(false);
    } finally {
      oldRead.resolve("");
      newRead.resolve("");
      await vi.advanceTimersByTimeAsync(10);
      await opening;
    }
  });

  it("rescans includes when the containing folder is renamed", async () => {
    const { folder, paneManager, watcher } = fixture();
    const guide: FSEntry = { ...alpha, path: "docs/alpha.md" };
    const next: FSEntry = { ...alpha, path: "manual/alpha.md" };
    const dir: FSEntry = { kind: "directory", name: "docs", path: "docs", children: [guide] };
    let entries = [dir];
    invoke.mockImplementation(async (command) => {
      if (command === "read_dir") return entries;
      if (command === "rename_file") entries = [{ ...dir, name: "manual", path: "manual", children: [next] }];
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    const id = openDocument(pane, guide, "<!-- include: chapter.md -->");
    pane.tabs.updateTabContent(id, { includePaths: ["docs/chapter.md"] });
    watcher.setTarget({ filePath: workspace + "/docs/alpha.md", includePaths: ["docs/chapter.md"], rootPath: workspace });
    await watcher.start();
    flush();
    await vi.advanceTimersByTimeAsync(0);
    await folder.handleRename(dir, workspace, "manual");
    await vi.advanceTimersByTimeAsync(0);
    expect(pane.tabs.getActiveTab()?.filePath).toBe(next.path);
    expect(calls("watch_paths").at(-1)).toEqual({ paths: [workspace + "/manual/alpha.md", workspace + "/manual/chapter.md"] });
  });
});

// A tree read that began before a successful rename or move is superseded: it
// must publish nothing, clear no selection, and never end or revive the
// identity a renamed tab keeps while the confirming tree is pending.
describe("superseded tree reads and the pending tab identity", () => {
  async function pendingRename() {
    const { state, folder, paneManager, actions } = fixture();
    const before = { ...alpha, path: "docs/alpha.md" };
    const after = { ...alpha, path: "manual/alpha.md" };
    const oldDir: FSEntry = { kind: "directory", name: "docs", path: "docs", children: [before] };
    const newDir: FSEntry = { kind: "directory", name: "manual", path: "manual", children: [after] };
    const sibling: FSEntry = { kind: "file", name: "created.md", path: "created.md" };
    const responses: PromiseWithResolvers<FSEntry[]>[] = [];
    let held = false;
    invoke.mockImplementation(async (command) => {
      if (command === "read_dir") {
        if (!held) return [oldDir, beta];
        const response = Promise.withResolvers<FSEntry[]>();
        responses.push(response);
        return response.promise;
      }
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    const betaId = openDocument(pane, beta, "Beta");
    openDocument(pane, before, "Saved");
    pane.setEditorContent("Unsaved");
    flush();
    held = true;
    const older = folder.refreshRoot(workspace);
    const rename = folder.handleRename(oldDir, workspace, "manual");
    await vi.advanceTimersByTimeAsync(1);
    expect(responses).toHaveLength(2);
    const movedId = pane.tabs.activeTabId()!;
    expect(pane.tabs.getActiveTab()?.filePath).toBe(after.path);
    const olderArrives = async () => { responses[0]!.resolve([oldDir, beta, sibling]); await older; flush(); };
    const newerArrives = async () => { responses[1]!.resolve([newDir, beta, sibling]); await rename; flush(); };
    const switchBack = async () => {
      await actions.activateTab(pane, betaId);
      flush();
      await actions.activateTab(pane, movedId);
      flush();
    };
    const observed = () => ({
      selected: pane.selectedFile()?.path ?? null,
      root: pane.selectedRootId(),
      oldInTree: !!state.findEntryByPath(before.path, workspace),
      newInTree: !!state.findEntryByPath(after.path, workspace),
      buffer: pane.editorContent(),
      reads: calls("read_file"),
      writes: calls("write_file"),
    });
    const release = () => { held = false; };
    return { folder, olderArrives, newerArrives, switchBack, observed, after, responses, pane, release };
  }

  it("keeps the selection and the save target when the older read resolves first", async () => {
    const f = await pendingRename();
    try {
      await f.olderArrives();
      expect(f.observed()).toMatchObject({ selected: f.after.path, oldInTree: true, newInTree: false });
      await f.switchBack();
      await vi.advanceTimersByTimeAsync(1100);
      expect(f.observed()).toMatchObject({
        selected: f.after.path, root: workspace, buffer: "Unsaved", reads: [],
        writes: [{ path: `${workspace}/${f.after.path}`, content: "Unsaved" }],
      });
    } finally { await f.newerArrives(); }
  });

  it("keeps the selected moved file without a tab switch and publishes only the newer tree", async () => {
    const f = await pendingRename();
    await f.olderArrives();
    await vi.advanceTimersByTimeAsync(1100);
    await f.newerArrives();
    await vi.advanceTimersByTimeAsync(1100);
    expect(f.observed()).toMatchObject({
      selected: f.after.path, oldInTree: false, newInTree: true,
      writes: [{ path: `${workspace}/${f.after.path}`, content: "Unsaved" }],
    });
  });

  it("does not roll the tree or the selection back when the older read resolves last", async () => {
    const f = await pendingRename();
    await f.newerArrives();
    await f.switchBack();
    await f.olderArrives();
    await f.switchBack();
    await vi.advanceTimersByTimeAsync(1100);
    expect(f.observed()).toMatchObject({
      selected: f.after.path, oldInTree: false, newInTree: true,
      writes: [{ path: `${workspace}/${f.after.path}`, content: "Unsaved" }],
    });
  });

  it("rejects a superseded read of refreshAllRoots without clearing the selection", async () => {
    const f = await pendingRename();
    // The fixture holds every read: start the all-roots refresh, then
    // supersede it with a second successful rename.
    const all = f.folder.refreshAllRoots();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.responses).toHaveLength(3);
    // A later successful rename supersedes the all-roots read in flight.
    const again = f.folder.handleRename(
      { kind: "directory", name: "manual", path: "manual", children: [f.after] }, workspace, "guides",
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(f.responses).toHaveLength(4);
    f.responses[2]!.resolve([{ kind: "directory", name: "manual", path: "manual", children: [f.after] }]);
    await all;
    flush();
    expect(f.observed()).toMatchObject({ selected: "guides/alpha.md", root: workspace });
    expect(f.observed().oldInTree).toBe(true);
    f.responses[0]!.resolve([]);
    f.responses[1]!.resolve([]);
    f.responses[3]!.resolve([{
      kind: "directory", name: "guides", path: "guides", children: [{ ...f.after, path: "guides/alpha.md" }],
    }]);
    await again;
  });

  it("ends the pending identity once the confirming tree is published", async () => {
    const f = await pendingRename();
    await f.olderArrives();
    await f.newerArrives();
    expect(f.observed().newInTree).toBe(true);
    // The tab is not reselected; the file then vanishes from disk.
    const remove = f.folder.refreshRoot(workspace);
    await vi.advanceTimersByTimeAsync(1);
    f.responses[2]!.resolve([beta]);
    await remove;
    await f.switchBack();
    await vi.advanceTimersByTimeAsync(1100);
    expect(f.observed()).toMatchObject({ selected: null, oldInTree: false, newInTree: false, writes: [] });
  });

  it("drops the pending identity when its root is closed and reopened", async () => {
    const f = await pendingRename();
    await f.olderArrives();
    await f.folder.handleCloseRoot(workspace);
    f.responses[1]!.resolve([]);
    f.release();
    // The root comes back with a tree that does not list the renamed file.
    await f.folder.openFolderPath(workspace);
    flush();
    const reopened = f.pane.tabs.reopenClosedTab();
    flush();
    expect(reopened).toMatchObject({ rootId: workspace, filePath: f.after.path });
    await vi.advanceTimersByTimeAsync(1100);
    expect(f.observed()).toMatchObject({ selected: null, newInTree: false });
    expect(f.observed().writes).toEqual([]);
  });
});

describe("superseded tree reads around move and close", () => {
  const other = "/other";
  const guide = { ...alpha, path: "docs/alpha.md" };
  const docs: FSEntry = { kind: "directory", name: "docs", path: "docs", children: [guide] };

  async function held() {
    const { state, folder, paneManager } = fixture();
    const reads = new Map<string, PromiseWithResolvers<FSEntry[]>[]>();
    const trees = new Map<string, FSEntry[]>([[workspace, [docs, beta]], [other, []]]);
    let hold = false;
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") {
        const root = String(args.path);
        if (!hold) return trees.get(root);
        const read = Promise.withResolvers<FSEntry[]>();
        reads.set(root, [...(reads.get(root) ?? []), read]);
        return read.promise;
      }
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(other);
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    openDocument(pane, beta, "Beta");
    openDocument(pane, guide, "Saved");
    pane.setEditorContent("Unsaved");
    flush();
    hold = true;
    return { state, folder, pane, reads, trees, release: () => { hold = false; } };
  }

  it("rejects a read started before a same-root move", async () => {
    const f = await held();
    const older = f.folder.refreshRoot(workspace);
    const move = f.folder.handleMove(docs.children![0]!, "manual", workspace);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.reads.get(workspace)).toHaveLength(2);
    f.reads.get(workspace)![0]!.resolve([docs, beta]);
    await older;
    flush();
    expect(f.pane.selectedFile()?.path).toBe("manual/alpha.md");
    expect(f.state.findEntryByPath(guide.path, workspace)).not.toBeNull();
    const moved = { ...guide, path: "manual/alpha.md" };
    f.reads.get(workspace)![1]!.resolve([{ kind: "directory", name: "manual", path: "manual", children: [moved] }, beta]);
    await move;
    flush();
    expect(f.state.findEntryByPath(guide.path, workspace)).toBeNull();
    expect(f.pane.selectedFile()?.path).toBe("manual/alpha.md");
  });

  it.each([["target", other], ["source", workspace]] as const)(
    "rejects a %s-root read started before a cross-root move",
    async (_side, rootId) => {
      const f = await held();
      const older = f.folder.refreshRoot(rootId);
      const move = f.folder.handleMove(guide, "sub", workspace, other);
      await vi.advanceTimersByTimeAsync(1);
      const source = f.reads.get(workspace)!;
      expect(f.reads.get(rootId)!.length).toBe(rootId === workspace ? 2 : 1);
      // The move's refreshes publish the real layout first.
      source[source.length - 1]!.resolve([beta]);
      await vi.advanceTimersByTimeAsync(1);
      const target = f.reads.get(other)!;
      target[target.length - 1]!.resolve([{
        kind: "directory", name: "sub", path: "sub", children: [{ ...guide, path: "sub/alpha.md" }],
      }]);
      await move;
      flush();
      // The older read then answers with the layout from before the move.
      f.reads.get(rootId)![0]!.resolve(rootId === workspace ? [docs, beta] : []);
      await older;
      flush();
      expect(f.pane.selectedRootId()).toBe(other);
      expect(f.pane.selectedFile()?.path).toBe("sub/alpha.md");
      expect(f.state.findEntryByPath(guide.path, workspace)).toBeNull();
      expect(f.state.findEntryByPath("sub/alpha.md", other)).not.toBeNull();
    },
  );

  it("rejects a read started before its root was closed and reopened", async () => {
    const f = await held();
    const older = f.folder.refreshRoot(workspace);
    await vi.advanceTimersByTimeAsync(1);
    await f.folder.handleCloseRoot(workspace);
    f.release();
    f.trees.set(workspace, [beta]);
    await f.folder.openFolderPath(workspace);
    flush();
    expect(f.state.findEntryByPath(guide.path, workspace)).toBeNull();
    f.reads.get(workspace)![0]!.resolve([docs, beta]);
    await older;
    flush();
    expect(f.state.findEntryByPath(guide.path, workspace)).toBeNull();
  });
});

describe("recovered draft name", () => {
  async function displacedDraft() {
    const { folder, paneManager } = fixture();
    const other = "/other";
    const moved = { ...alpha, path: "sub/alpha.md" };
    const sub: FSEntry = { kind: "directory", path: "sub", name: "sub", children: [] };
    let didMove = false;
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return args.path === other ? [{ ...sub, children: didMove ? [moved] : [] }] : didMove ? [beta] : [alpha, beta];
      if (command === "move_path") { didMove = true; return; }
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(other);
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    const stale = pane.tabs.openTab(moved, other, { background: true });
    pane.tabs.updateTabContent(stale, { editorContent: "Stale unsaved", savedContent: "Stale saved" });
    flush();
    openDocument(pane, alpha, "Source saved");
    await folder.handleMove(alpha, "sub", workspace, other);
    await vi.advanceTimersByTimeAsync(10);
    return pane.tabs.reopenClosedTab();
  }

  it.each([
    ["en", "alpha (recovered 1).md"],
    ["pt-BR", "alpha (recuperado 1).md"],
    ["es", "alpha (recuperado 1).md"],
  ] as const)("shows the %s suffix and keeps the internal identity language-independent", async (locale, name) => {
    setLocale(locale, { reload: false });
    try {
      const draft = await displacedDraft();
      expect(draft).toMatchObject({ rootId: SCRATCH_ROOT_ID });
      expect(tabDisplayName(draft!)).toBe(name);
      expect(draft?.filePath).toBe("scratch://alpha (recovered 1).md");
      expect(draft?.id).toBe(`${SCRATCH_ROOT_ID}::scratch://alpha (recovered 1).md`);
    } finally {
      setLocale("en", { reload: false });
    }
  });

  it("stores only the base name: the suffix is derived, never saved in the tab", async () => {
    const draft = await displacedDraft();
    expect(draft?.fileName).toBe("alpha.md");
    expect(tabDisplayName({ fileName: "alpha.md", filePath: "scratch://Untitled-1.md" })).toBe("alpha.md");
    expect(tabDisplayName({ fileName: "alpha (recovered 2).md", filePath: "alpha (recovered 2).md" })).toBe("alpha (recovered 2).md");
  });

  it("re-derives the draft name in the tab bar when the language changes, keeping path and id", async () => {
    const { folder, paneManager } = fixture();
    const other = "/other";
    const moved = { ...alpha, path: "sub/alpha.md" };
    const sub: FSEntry = { kind: "directory", path: "sub", name: "sub", children: [] };
    let didMove = false;
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return args.path === other ? [{ ...sub, children: didMove ? [moved] : [] }] : didMove ? [beta] : [alpha, beta];
      if (command === "move_path") { didMove = true; return; }
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(other);
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    const stale = pane.tabs.openTab(moved, other, { background: true });
    pane.tabs.updateTabContent(stale, { editorContent: "Stale unsaved", savedContent: "Stale saved" });
    flush();
    openDocument(pane, alpha, "Source saved");
    await folder.handleMove(alpha, "sub", workspace, other);
    await vi.advanceTimersByTimeAsync(10);
    const draft = pane.tabs.reopenClosedTab()!;
    flush();
    const { getByRole, queryByRole, unmount } = render(() => createComponent(DragDropProvider, {
      get children() {
        return createComponent(TabBar, { paneIndex: 0, tabStore: pane.tabs, onActivateTab: () => {}, onCloseTab: () => {} });
      },
    }));
    try {
      expect(getByRole("button", { name: "alpha (recovered 1).md" })).toBeTruthy();
      switchLocale("pt-BR");
      flush();
      expect(getByRole("button", { name: "alpha (recuperado 1).md" })).toBeTruthy();
      expect(queryByRole("button", { name: "alpha (recovered 1).md" })).toBeNull();
      const kept = pane.tabs.getTab(draft.id)!;
      expect(kept.id).toBe(draft.id);
      expect(kept.filePath).toBe("scratch://alpha (recovered 1).md");
      expect(kept.fileName).toBe("alpha.md");
    } finally {
      switchLocale("en");
      unmount();
    }
  });

  it("names a draft reopened after a language change in the language in use then", async () => {
    const { folder, paneManager } = fixture();
    const other = "/other";
    const moved = { ...alpha, path: "sub/alpha.md" };
    const sub: FSEntry = { kind: "directory", path: "sub", name: "sub", children: [] };
    let didMove = false;
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return args.path === other ? [{ ...sub, children: didMove ? [moved] : [] }] : didMove ? [beta] : [alpha, beta];
      if (command === "move_path") { didMove = true; return; }
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(other);
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    const stale = pane.tabs.openTab(moved, other, { background: true });
    pane.tabs.updateTabContent(stale, { editorContent: "Stale unsaved", savedContent: "Stale saved" });
    flush();
    openDocument(pane, alpha, "Source saved");
    await folder.handleMove(alpha, "sub", workspace, other);
    await vi.advanceTimersByTimeAsync(10);
    switchLocale("pt-BR");
    try {
      const draft = pane.tabs.reopenClosedTab()!;
      flush();
      expect(pane.selectedFile()?.name).toBe("alpha (recuperado 1).md");
      expect(draft.filePath).toBe("scratch://alpha (recovered 1).md");
    } finally {
      switchLocale("en");
    }
  });
});

describe("reopening a closed tab whose id a live tab now holds", () => {
  const other = "/other";
  const moved = { ...alpha, path: "sub/alpha.md" };
  const target = `${other}/${moved.path}`;
  const source = `${workspace}/alpha.md`;

  // A closed tab for other::sub/alpha.md, then a background tab moved onto that
  // path: the moved tab takes the canonical id the history entry still carries.
  async function movedOntoClosedPath(history: { editorContent: string; savedContent: string }) {
    const f = fixture();
    const sub: FSEntry = { kind: "directory", path: "sub", name: "sub", children: [] };
    const disk = new Map([[source, "Source on disk"], [target, "Former destination"]]);
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return args.path === other
        ? [{ ...sub, children: disk.has(target) ? [moved] : [] }]
        : disk.has(source) ? [alpha, beta] : [beta];
      if (command === "move_path") {
        expect(disk.has(target)).toBe(false);
        disk.set(target, disk.get(source)!);
        disk.delete(source);
      }
      if (command === "write_file") disk.set(String(args.path), String(args.content));
      if (command === "plugin:event|listen") return 1;
    });
    await f.folder.openFolderPath(other);
    await f.folder.openFolderPath(workspace);
    const pane = f.paneManager.activePane();
    const stale = pane.tabs.openTab(moved, other, { background: true });
    pane.tabs.updateTabContent(stale, { ...history, editorMode: "split" });
    flush();
    pane.tabs.closeTab(stale);
    const sourceId = pane.tabs.openTab(alpha, workspace, { background: true });
    pane.tabs.updateTabContent(sourceId, { editorContent: "Source on disk", savedContent: "Source on disk" });
    openDocument(pane, beta, "Sibling");
    disk.delete(target);
    await f.folder.refreshRoot(other);
    await f.folder.handleMove(alpha, "sub", workspace, other);
    flush();
    expect(pane.selectedFile()?.path).toBe(beta.path);
    const liveId = `${other}::${moved.path}`;
    expect(pane.tabs.getTab(liveId)?.editorContent).toBe("Source on disk");
    return { ...f, pane, disk, liveId };
  }

  const ids = (pane: PaneStore) => pane.tabs.tabs().map(tab => tab.id);

  it("keeps the unsaved edits of the closed tab as a draft with a new id, never writing them to the moved file", async () => {
    const { pane, disk, liveId } = await movedOntoClosedPath({
      editorContent: "Unsaved former destination", savedContent: "Former destination",
    });
    const reopened = pane.tabs.reopenClosedTab();
    flush();
    expect(new Set(ids(pane)).size).toBe(ids(pane).length);
    expect(ids(pane).filter(id => id === liveId)).toHaveLength(1);
    expect(reopened).toMatchObject({
      rootId: SCRATCH_ROOT_ID, editorContent: "Unsaved former destination", fileName: "alpha.md",
    });
    expect(isScratchPath(reopened?.filePath)).toBe(true);
    expect(reopened?.id).not.toBe(liveId);
    expect(pane.tabs.activeTabId()).toBe(reopened?.id);
    expect(pane.selectedFile()?.path).toBe(reopened?.filePath);
    expect(pane.tabs.getTab(liveId)?.editorContent).toBe("Source on disk");
    await vi.advanceTimersByTimeAsync(2100);
    expect(disk.get(target)).toBe("Source on disk");
    expect(calls("write_file").filter(args => args.path === target)).toEqual([]);
    // The two tabs are operable independently: closing the draft leaves the moved file's tab.
    pane.tabs.closeTab(reopened!.id);
    flush();
    expect(ids(pane)).toContain(liveId);
  });

  it("activates the live tab instead of duplicating it when the closed tab had no unsaved edits", async () => {
    const { pane, liveId } = await movedOntoClosedPath({
      editorContent: "Former destination", savedContent: "Former destination",
    });
    const before = ids(pane);
    const reopened = pane.tabs.reopenClosedTab();
    flush();
    expect(ids(pane)).toEqual(before);
    expect(reopened?.id).toBe(liveId);
    expect(pane.tabs.activeTabId()).toBe(liveId);
    expect(pane.selectedFile()?.path).toBe(moved.path);
  });

  it("activates the live tab when the closed tab's unsaved content is what the live tab holds", async () => {
    const { pane, liveId } = await movedOntoClosedPath({
      editorContent: "Source on disk", savedContent: "Former destination",
    });
    const before = ids(pane);
    const reopened = pane.tabs.reopenClosedTab();
    flush();
    expect(ids(pane)).toEqual(before);
    expect(reopened?.id).toBe(liveId);
    expect(pane.tabs.activeTabId()).toBe(liveId);
  });

  it("reopens a displaced draft, edits it, and leaves the moved tab in sync with disk", async () => {
    const { folder, paneManager, actions } = fixture();
    const disk = new Map([[source, "Source on disk"]]);
    const sub: FSEntry = { kind: "directory", path: "sub", name: "sub", children: [] };
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return args.path === other
        ? [{ ...sub, children: disk.has(target) ? [moved] : [] }]
        : disk.has(source) ? [alpha, beta] : [beta];
      if (command === "move_path") {
        disk.set(target, disk.get(source)!);
        disk.delete(source);
      }
      if (command === "write_file") disk.set(String(args.path), String(args.content));
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(other);
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    const stale = pane.tabs.openTab(moved, other, { background: true });
    pane.tabs.updateTabContent(stale, { editorContent: "Stale unsaved", savedContent: "Stale saved" });
    const sibling = openDocument(pane, beta, "Sibling saved");
    pane.setEditorContent("Sibling unsaved");
    flush();
    openDocument(pane, alpha, "Source on disk");
    pane.setEditorContent("Source edited");
    flush();
    await folder.handleMove(alpha, "sub", workspace, other);
    await vi.advanceTimersByTimeAsync(1100);
    const movedId = pane.tabs.activeTabId()!;
    expect(disk.get(target)).toBe("Source edited");
    const recovered = pane.tabs.reopenClosedTab();
    flush();
    expect(pane.editorContent()).toBe("Stale unsaved");
    expect(pane.selectedRootId()).toBe(SCRATCH_ROOT_ID);
    expect(recovered?.filePath).toMatch(/^scratch:\/\//);
    expect(recovered?.id).not.toBe(stale);
    pane.setEditorContent("Draft edited again");
    flush();
    await vi.advanceTimersByTimeAsync(2100);
    await actions.activateTab(pane, movedId);
    flush();
    expect(pane.editorContent()).toBe(disk.get(target));
    await actions.activateTab(pane, sibling);
    flush();
    expect(disk.get(target)).toBe("Source edited");
    expect(calls("write_file")).toMatchObject([{ path: target, content: "Source edited" }]);
    expect(pane.editorContent()).toBe("Sibling unsaved");
    expect(pane.savedContent()).toBe("Sibling saved");
  });

  it("does not even ask the resolver about a closed tab without unsaved edits", async () => {
    const { pane, liveId } = await movedOntoClosedPath({
      editorContent: "Former destination", savedContent: "Former destination",
    });
    const asked = vi.fn((closed: TabState) => ({ ...closed, id: "__scratch__::scratch://never.md", rootId: "__scratch__" }));
    pane.tabs.setReopenResolver(asked);
    const before = ids(pane);
    expect(pane.tabs.reopenClosedTab()?.id).toBe(liveId);
    flush();
    expect(asked).not.toHaveBeenCalled();
    expect(ids(pane)).toEqual(before);
  });

  it("never inserts a draft whose id is taken either: it activates the holder", async () => {
    const { pane, liveId } = await movedOntoClosedPath({
      editorContent: "Unsaved former destination", savedContent: "Former destination",
    });
    pane.tabs.setReopenResolver((closed) => ({ ...closed, id: liveId }));
    const before = ids(pane);
    const reopened = pane.tabs.reopenClosedTab();
    flush();
    expect(ids(pane)).toEqual(before);
    expect(reopened?.id).toBe(liveId);
    expect(pane.tabs.activeTabId()).toBe(liveId);
  });

  it("falls back to the live tab when no resolver is set and drops the edits it cannot keep as a draft", async () => {
    const { pane, liveId } = await movedOntoClosedPath({
      editorContent: "Unsaved former destination", savedContent: "Former destination",
    });
    pane.tabs.setReopenResolver(null);
    const before = ids(pane);
    expect(pane.tabs.reopenClosedTab()?.id).toBe(liveId);
    flush();
    expect(ids(pane)).toEqual(before);
  });

  it("reopens with the same id when nothing holds it", async () => {
    const { folder, paneManager } = fixture();
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    const id = pane.tabs.openTab(alpha, workspace, { background: true });
    openDocument(pane, beta, "Sibling");
    pane.tabs.closeTab(id);
    flush();
    const reopened = pane.tabs.reopenClosedTab();
    flush();
    expect(reopened?.id).toBe(id);
    expect(ids(pane).filter(tabId => tabId === id)).toHaveLength(1);
    expect(pane.tabs.activeTabId()).toBe(id);
  });
});

describe("recovered draft selection from the store alone", () => {
  it("names the selection of the draft that becomes active after a bulk close in the current language", () => {
    const disposers: (() => void)[] = [];
    try {
      const pane = createRoot((dispose) => {
        disposers.push(dispose);
        return createPaneStore("draft-selection");
      });
      const draft = pane.tabs.openTab({ kind: "file", name: "alpha.md", path: "scratch://alpha (recovered 3).md" }, SCRATCH_ROOT_ID);
      const other = pane.tabs.openTab({ kind: "file", name: "beta.md", path: "beta.md" }, workspace);
      flush();
      switchLocale("pt-BR");
      pane.tabs.closeTabs([other]);
      flush();
      expect(pane.tabs.activeTabId()).toBe(draft);
      expect(pane.selectedFile()?.name).toBe("alpha (recuperado 3).md");
    } finally {
      switchLocale("en");
      for (const dispose of disposers) dispose();
    }
  });
});

describe("restoring the last session after a webview reload", () => {
  const otherRoot = "/workspace-two";
  const thirdRoot = "/workspace-three";
  const paneZeroKey = "markdraw-tab-session-pane-0";
  const gone = "No such file or directory (os error 2)";

  function persistedTab(rootId: string, filePath: string, isPinned = false) {
    return {
      id: `${rootId}::${filePath}`,
      filePath,
      rootId,
      fileName: filePath,
      isPinned,
      editorMode: "edit" as const,
    };
  }

  // What App does: the session is read once, when the restore is created.
  function sessionRestore(pane: PaneStore, state: AppState) {
    return createSessionRestore(pane, (filePath, rootId) => state.findEntryByPath(filePath, rootId));
  }

  // Park the directory read of one root (and fail the reads of `missing`).
  function holdRoot(path: string, failing: Record<string, string> = {}) {
    const held = Promise.withResolvers<FSEntry[]>();
    const reached = Promise.withResolvers<void>();
    const fallback = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir" && typeof args.path === "string" && args.path in failing) throw failing[args.path];
      // Asked about the root itself, a folder that failed to read answers like the
      // OS: not found only when it is really gone, "is a directory" when it exists.
      if (command === "read_file" && typeof args.path === "string" && args.path in failing) {
        throw failing[args.path] === gone ? gone : "Is a directory (os error 21)";
      }
      if (command === "read_dir" && args.path === path) {
        reached.resolve();
        return held.promise;
      }
      return fallback(command, args);
    });
    return { held, reached };
  }

  function savedSession() {
    return JSON.parse(localStorage.getItem(paneZeroKey) ?? "null") as
      { tabs: { id: string }[]; activeTabId: string | null } | null;
  }

  it("reopens the persisted roots and restores their tabs as needsLoad", async () => {
    const { folder, paneManager, rootPaths, state } = fixture();
    setOpenRoots([
      { id: workspace, path: workspace },
      { id: otherRoot, path: otherRoot },
    ]);
    setTabSession({
      activeTabId: `${otherRoot}::beta.md`,
      tabs: [persistedTab(workspace, "alpha.md"), persistedTab(otherRoot, "beta.md", true)],
    }, paneZeroKey);
    const pane = paneManager.activePane();
    const restore = sessionRestore(pane, state);

    expect(await folder.restoreOpenRoots()).toEqual([workspace, otherRoot]);
    expect(Array.from(rootPaths().keys())).toEqual([workspace, otherRoot]);
    expect(restore.rootsChanged(rootPaths().keys())).toBeNull();
    flush();

    const tabs = pane.tabs.tabs();
    expect(tabs.map((tab) => tab.id)).toEqual([`${workspace}::alpha.md`, `${otherRoot}::beta.md`]);
    // Every restored tab must read its content from disk before activation.
    expect(tabs.map((tab) => tab.needsLoad)).toEqual([true, true]);
    expect(pane.tabs.getTab(`${otherRoot}::beta.md`)?.isPinned).toBe(true);
    // Nothing is active until the whole batch is known; then the saved active
    // tab wins even though its root opened last.
    expect(pane.tabs.activeTabId()).toBeNull();
    expect(restore.settle([workspace, otherRoot])).toBe(`${otherRoot}::beta.md`);
  });

  it("restores per root: a root opened later restores only its own tabs, without a new activation", async () => {
    const { folder, paneManager, rootPaths, state } = fixture();
    setOpenRoots([{ id: workspace, path: workspace }]);
    setTabSession({
      activeTabId: `${workspace}::alpha.md`,
      tabs: [persistedTab(workspace, "alpha.md"), persistedTab(thirdRoot, "beta.md")],
    }, paneZeroKey);
    const pane = paneManager.activePane();
    const restore = sessionRestore(pane, state);
    expect(await folder.restoreOpenRoots()).toEqual([workspace]);

    expect(restore.rootsChanged(rootPaths().keys())).toBeNull();
    expect(restore.settle([workspace])).toBe(`${workspace}::alpha.md`);
    flush();
    expect(pane.tabs.tabs()).toHaveLength(1);

    // Same roots again: nothing is replayed, and no activation is requested.
    expect(restore.rootsChanged(rootPaths().keys())).toBeNull();
    expect(pane.tabs.tabs()).toHaveLength(1);

    // The settled session no longer keeps the tab of a folder that was not
    // reopened, so storage has lost it by now...
    await vi.advanceTimersByTimeAsync(501);
    expect(savedSession()?.tabs.map(({ id }) => id)).toEqual([`${workspace}::alpha.md`]);

    // ...yet a folder opened later still brings its own saved tab, from the
    // stable snapshot rather than from the storage rewritten since, and only it.
    expect(await folder.openFolderPath(thirdRoot)).toBe(true);
    flush();
    expect(restore.rootsChanged(rootPaths().keys())).toBeNull();
    flush();
    expect(pane.tabs.tabs().map((tab) => tab.id)).toEqual([
      `${workspace}::alpha.md`,
      `${thirdRoot}::beta.md`,
    ]);
  });

  it("keeps the tabs of a root whose read outlasts the tab-store debounce, and activates the saved one when it opens last", async () => {
    const { folder, paneManager, rootPaths, state } = fixture();
    const a = persistedTab(workspace, "alpha.md");
    const b = persistedTab(otherRoot, "beta.md");
    setOpenRoots([{ id: workspace, path: workspace }, { id: otherRoot, path: otherRoot }]);
    setTabSession({ tabs: [a, b], activeTabId: b.id }, paneZeroKey);
    const pane = paneManager.activePane();
    const restore = sessionRestore(pane, state);
    const pending = holdRoot(otherRoot);

    const restoring = folder.restoreOpenRoots();
    await pending.reached.promise;
    flush();
    expect(restore.rootsChanged(rootPaths().keys())).toBeNull();
    flush();
    expect(pane.tabs.tabs().map(({ id }) => id)).toEqual([a.id]);

    // The tab store rewrites its key after 500ms: the pending root's tab and
    // the saved active tab must survive that write.
    await vi.advanceTimersByTimeAsync(501);
    expect(savedSession()?.tabs.map(({ id }) => id)).toEqual([a.id, b.id]);
    expect(savedSession()?.activeTabId).toBe(b.id);

    pending.held.resolve([beta]);
    await restoring;
    flush();
    expect(restore.rootsChanged(rootPaths().keys())).toBeNull();
    flush();
    expect(pane.tabs.tabs().map(({ id }) => id)).toEqual([a.id, b.id]);
    expect(restore.settle([workspace, otherRoot])).toBe(b.id);
  });

  it("settling keeps the tabs of a root that failed to open and drops those of a confirmed-missing root", async () => {
    const { folder, paneManager, rootPaths, state } = fixture();
    const a = persistedTab(workspace, "alpha.md");
    const locked = persistedTab(otherRoot, "beta.md");
    const missing = persistedTab(thirdRoot, "beta.md");
    setOpenRoots([workspace, otherRoot, thirdRoot].map((path) => ({ id: path, path })));
    setTabSession({ tabs: [a, locked, missing], activeTabId: a.id }, paneZeroKey);
    const pane = paneManager.activePane();
    const restore = sessionRestore(pane, state);
    holdRoot("/unused", { [otherRoot]: "Permission denied (os error 13)", [thirdRoot]: gone });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await folder.restoreOpenRoots()).toEqual([workspace]);
    warnSpy.mockRestore();
    expect(restore.rootsChanged(rootPaths().keys())).toBeNull();
    expect(restore.settle(folder.savedRootIds())).toBe(a.id);
    flush();
    await vi.advanceTimersByTimeAsync(501);

    expect(getOpenRoots().map(({ path }) => path)).toEqual([workspace, otherRoot]);
    expect(savedSession()?.tabs.map(({ id }) => id)).toEqual([a.id, locked.id]);
  });

  it("an in-flight restore cannot reopen a root the user opened and closed meanwhile", async () => {
    const { folder, rootPaths } = fixture();
    setOpenRoots([{ id: workspace, path: workspace }]);
    const initialRead = Promise.withResolvers<FSEntry[]>();
    const started = Promise.withResolvers<void>();
    const fallback = invoke.getMockImplementation()!;
    let count = 0;
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir" && args.path === workspace && ++count === 1) {
        started.resolve();
        return initialRead.promise;
      }
      return fallback(command, args);
    });
    const restoring = folder.restoreOpenRoots();
    await started.promise;
    expect(await folder.openFolderPath(workspace)).toBe(true);
    await folder.handleCloseRoot(workspace);
    flush();
    expect(rootPaths().size).toBe(0);

    initialRead.resolve([alpha]);
    await restoring;
    flush();

    expect({
      roots: [...rootPaths().keys()],
      saved: getOpenRoots().map(({ path }) => path),
      registry: calls("mcp_set_roots").at(-1)?.roots,
    }).toEqual({ roots: [], saved: [], registry: [] });
  });

  it("activates a tab that is still open when the saved active tab's root was closed during startup", async () => {
    const { folder, paneManager, rootPaths, state } = fixture();
    const a = persistedTab(workspace, "alpha.md");
    const b = persistedTab(otherRoot, "beta.md");
    setOpenRoots([workspace, otherRoot].map((path) => ({ id: path, path })));
    setTabSession({ tabs: [a, b], activeTabId: a.id }, paneZeroKey);
    const pane = paneManager.activePane();
    const restore = sessionRestore(pane, state);
    const pending = holdRoot(otherRoot);

    const restoring = folder.restoreOpenRoots();
    await pending.reached.promise;
    flush();
    expect(restore.rootsChanged(rootPaths().keys())).toBeNull();
    flush();
    expect(pane.tabs.tabs().map(({ id }) => id)).toEqual([a.id]);
    // The user closes the root of the saved active tab while the other still reads.
    await folder.handleCloseRoot(workspace);
    flush();
    expect(pane.tabs.tabs()).toEqual([]);

    pending.held.resolve([beta]);
    await restoring;
    flush();
    expect(restore.rootsChanged(rootPaths().keys())).toBeNull();
    flush();
    expect(pane.tabs.tabs().map(({ id }) => id)).toEqual([b.id]);
    expect(restore.settle(folder.savedRootIds())).toBe(b.id);
  });

  it("keeps the activation pending until a restored tab is still open", async () => {
    const { folder, paneManager, rootPaths, state } = fixture();
    const a = persistedTab(workspace, "alpha.md");
    const b = persistedTab(otherRoot, "beta.md");
    setOpenRoots([workspace, otherRoot].map((path) => ({ id: path, path })));
    setTabSession({ tabs: [a, b], activeTabId: a.id }, paneZeroKey);
    const pane = paneManager.activePane();
    const restore = sessionRestore(pane, state);
    holdRoot("/unused", { [otherRoot]: "Permission denied (os error 13)" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await folder.restoreOpenRoots()).toEqual([workspace]);
    warnSpy.mockRestore();
    expect(restore.rootsChanged(rootPaths().keys())).toBeNull();
    flush();
    await folder.handleCloseRoot(workspace);
    flush();
    // Nothing alive to activate: the activation is not consumed.
    expect(restore.settle(folder.savedRootIds())).toBeNull();
    expect(pane.tabs.activeTabId()).toBeNull();

    // The root that failed opens later: its tab is the one to activate.
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return args.path === otherRoot ? [beta] : [alpha, beta];
      if (command === "plugin:event|listen") return 1;
    });
    expect(await folder.openFolderPath(otherRoot)).toBe(true);
    expect(restore.rootsChanged(rootPaths().keys())).toBe(b.id);
    flush();
    expect(restore.rootsChanged(rootPaths().keys())).toBeNull();
  });

  it("settles without an inventory by keeping the saved tabs' roots pending, then restores them when their folder opens", async () => {
    const { folder, paneManager, rootPaths, state } = fixture();
    const a = persistedTab(workspace, "alpha.md");
    const b = persistedTab(otherRoot, "beta.md");
    setTabSession({ tabs: [a, b], activeTabId: b.id }, paneZeroKey);
    const pane = paneManager.activePane();
    const restore = sessionRestore(pane, state);
    folder.adoptSessionRoots(restore.rootIds());

    expect(await folder.restoreOpenRoots()).toEqual([]);
    expect(folder.savedRootIds()).toEqual([workspace, otherRoot]);
    expect(restore.settle(folder.savedRootIds())).toBeNull();
    await vi.advanceTimersByTimeAsync(501);
    expect(savedSession()?.tabs.map(({ id }) => id)).toEqual([a.id, b.id]);
    expect(savedSession()?.activeTabId).toBe(b.id);

    // Opening one folder later restores only its tabs and keeps the other's.
    expect(await folder.openFolderPath(otherRoot)).toBe(true);
    expect(restore.rootsChanged(rootPaths().keys())).toBe(b.id);
    flush();
    await vi.advanceTimersByTimeAsync(501);
    expect(savedSession()?.tabs.map(({ id }) => id)).toEqual([b.id, a.id]);
  });

  it("keeps a legacy root's tabs through the partial list the first session wrote and a second restart", async () => {
    const b = persistedTab(otherRoot, "beta.md");
    setTabSession({ tabs: [b], activeTabId: b.id }, paneZeroKey);

    // First start after the update: no list yet; the user opens an unrelated folder.
    const first = fixture();
    const firstRestore = sessionRestore(first.paneManager.activePane(), first.state);
    first.folder.adoptSessionRoots(firstRestore.rootIds());
    expect(await first.folder.restoreOpenRoots()).toEqual([]);
    expect(firstRestore.settle(first.folder.savedRootIds())).toBeNull();
    expect(await first.folder.openFolderPath(workspace)).toBe(true);
    await vi.advanceTimersByTimeAsync(501);
    expect(getOpenRoots()).toEqual([{ id: workspace, path: workspace }]);
    expect(savedSession()?.tabs.map(({ id }) => id)).toEqual([b.id]);

    // Second start: the list exists but only holds the folder opened since.
    const second = fixture();
    const secondRestore = sessionRestore(second.paneManager.activePane(), second.state);
    second.folder.adoptSessionRoots(secondRestore.rootIds());
    expect(await second.folder.restoreOpenRoots()).toEqual([workspace]);
    secondRestore.rootsChanged(second.rootPaths().keys());
    expect(secondRestore.settle(second.folder.savedRootIds())).toBeNull();
    await vi.advanceTimersByTimeAsync(501);
    expect(savedSession()?.tabs.map(({ id }) => id)).toEqual([b.id]);

    // The control: the folder opens later and the saved tab comes back.
    expect(await second.folder.openFolderPath(otherRoot)).toBe(true);
    expect(secondRestore.rootsChanged(second.rootPaths().keys())).toBe(b.id);
  });

  it("drops a legacy root's tabs once its directory is confirmed gone, and only then", async () => {
    const b = persistedTab(otherRoot, "beta.md");
    const c = persistedTab(thirdRoot, "gamma.md");
    setTabSession({ tabs: [b, c], activeTabId: b.id }, paneZeroKey);
    // A previous start already parked both roots; the list is the partial one.
    setOpenRoots([{ id: workspace, path: workspace }]);
    setPendingTabRoots([otherRoot, thirdRoot]);
    holdRoot("/unused", { [thirdRoot]: gone });
    const { folder, paneManager, state } = fixture();
    const restore = sessionRestore(paneManager.activePane(), state);
    folder.adoptSessionRoots(restore.rootIds());

    await folder.restoreOpenRoots();
    restore.settle(folder.savedRootIds());
    await vi.advanceTimersByTimeAsync(501);

    expect(folder.savedRootIds()).toEqual([workspace, otherRoot]);
    expect(savedSession()?.tabs.map(({ id }) => id)).toEqual([b.id]);
  });

  it("preserves a root when two recursive reads return an unqualified not-found but the root still answers", async () => {
    const { folder } = fixture();
    setOpenRoots([{ id: workspace, path: workspace }]);
    const fallback = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir" && args.path === workspace) throw gone;
      // The root path itself still exists: reading it fails as "is a directory".
      if (command === "read_file" && args.path === workspace) throw "Is a directory (os error 21)";
      return fallback(command, args);
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await folder.restoreOpenRoots()).toEqual([]);
    warnSpy.mockRestore();

    expect(calls("read_dir")).toHaveLength(2);
    expect(getOpenRoots()).toEqual([{ id: workspace, path: workspace }]);
    expect(folder.savedRootIds()).toEqual([workspace]);
  });

  it("starts clean when the root storage is missing", async () => {
    const { folder, paneManager, rootPaths, state } = fixture();
    const pane = paneManager.activePane();
    const restore = sessionRestore(pane, state);
    expect(await folder.restoreOpenRoots()).toEqual([]);
    expect(rootPaths().size).toBe(0);

    expect(restore.settle([])).toBeNull();
    expect(pane.tabs.tabs()).toEqual([]);
  });

  it("starts clean when the root storage is corrupt or from another version", async () => {
    const { folder, paneManager, rootPaths, state } = fixture();
    localStorage.setItem("markdraw-open-roots-v1", "{not json");
    expect(await folder.restoreOpenRoots()).toEqual([]);

    localStorage.setItem("markdraw-open-roots-v1", JSON.stringify([{ path: workspace }]));
    expect(getOpenRoots()).toEqual([]);
    expect(await folder.restoreOpenRoots()).toEqual([]);

    const pane = paneManager.activePane();
    expect(sessionRestore(pane, state).rootsChanged([workspace])).toBeNull();
    expect(rootPaths().size).toBe(0);
    expect(pane.tabs.tabs()).toEqual([]);
  });

  it("reopens the roots but activates nothing when no tab session was persisted", async () => {
    const { folder, paneManager, rootPaths, state } = fixture();
    setOpenRoots([{ id: workspace, path: workspace }]);
    const pane = paneManager.activePane();
    const restore = sessionRestore(pane, state);

    expect(await folder.restoreOpenRoots()).toEqual([workspace]);
    expect(restore.rootsChanged(rootPaths().keys())).toBeNull();
    expect(restore.settle([workspace])).toBeNull();
    expect(pane.tabs.tabs()).toEqual([]);
    // The root itself is open and selected, so the user lands on the folder.
    expect(pane.selectedRootId()).toBe(workspace);
  });

  it("saves the open document to its own root after another folder is opened", async () => {
    const { folder, paneManager } = fixture();
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    openDocument(pane, alpha, "Alpha buffer");

    // Opening a second folder moves the selected root, not the open tab.
    expect(await folder.openFolderPath(otherRoot)).toBe(true);
    flush();
    expect(pane.selectedRootId()).toBe(otherRoot);
    pane.setEditorContent("Edited alpha");
    flush();
    await vi.advanceTimersByTimeAsync(1000);

    expect(calls("write_file")).toEqual([{ path: `${workspace}/alpha.md`, content: "Edited alpha" }]);
    expect(pane.savedContent()).toBe("Edited alpha");
  });

  it("restoring a second folder in the background keeps the selection and the save target", async () => {
    const { folder, paneManager } = fixture();
    setOpenRoots([{ id: workspace, path: workspace }, { id: otherRoot, path: otherRoot }]);
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    openDocument(pane, alpha, "Alpha buffer");

    expect(await folder.restoreOpenRoots()).toEqual([workspace, otherRoot]);
    flush();
    expect(pane.selectedRootId()).toBe(workspace);
    pane.setEditorContent("Edited alpha");
    flush();
    await folder.handleEditorSave();

    expect(calls("write_file")).toEqual([{ path: `${workspace}/alpha.md`, content: "Edited alpha" }]);
  });
});

// The real `App`, mounted: the reload bug lived in how App wires the startup
// (`runColdStart`, the session restore and the root-publishing effect), which
// calling the helpers directly cannot prove. Only the IPC is simulated.
describe("the mounted app restores the saved session at startup", () => {
  const otherRoot = "/workspace-two";
  const sessionKey = "markdraw-tab-session-pane-0";
  const missing = "No such file or directory (os error 2)";

  function persistedTab(rootId: string, filePath: string) {
    return {
      id: `${rootId}::${filePath}`, filePath, rootId, fileName: filePath,
      isPinned: true, editorMode: "edit" as const,
    };
  }

  async function settleApp(rounds = 12) {
    for (let i = 0; i < rounds; i++) {
      await vi.advanceTimersByTimeAsync(0);
      flush();
    }
  }

  // The first import transforms the whole app: far past the 5s default on a
  // busy machine.
  const APP_TIMEOUT = 60_000;

  async function mountApp(options: { held?: Record<string, Promise<FSEntry[]>>; args?: string[] } = {}) {
    const tree: Record<string, FSEntry[]> = { [workspace]: [alpha, beta], [otherRoot]: [beta] };
    invoke.mockImplementation(async (command, args) => {
      switch (command) {
        case "read_dir": {
          const path = args.path as string;
          if (options.held?.[path]) return options.held[path];
          if (path in tree) return tree[path];
          throw missing;
        }
        case "rename_file":
          tree[workspace] = [alpha, { ...beta, name: "renamed.md", path: "renamed.md" }];
          return;
        case "get_startup_args": return options.args ?? [];
        case "plugin:event|listen": return 1;
        case "ai_mcp_list_servers":
        case "mcp_discover":
        case "skills_discover": return [];
        case "read_file": {
          // Asking a root path itself (to confirm it is gone) answers like the OS:
          // not found for a folder that vanished, "is a directory" for one that exists.
          const path = args.path as string;
          if (path in tree) throw "Is a directory (os error 21)";
          if (!path.includes("/", 1)) throw missing;
          return "# content";
        }
      }
    });
    vi.stubGlobal("__TAURI_INTERNALS__", {
      invoke, transformCallback: () => 1,
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    });
    // The converter worker is a Vite `?worker`; the app only needs it to exist.
    vi.stubGlobal("Worker", class {
      onmessage = null;
      postMessage() {}
      terminate() {}
      addEventListener() {}
      removeEventListener() {}
    });
    const { App } = await import("../../../../apps/desktop/src/app.tsx");
    const view = render(() => createComponent(App, {}));
    disposeFixtures.push(async () => {
      view.unmount();
      await settleApp(3);
    });
    flush();
    await settleApp();
  }

  const tabIds = () => Array.from(document.querySelectorAll("[data-tab-id]"), (el) => el.getAttribute("data-tab-id"));
  const activeTabId = () => document.querySelector(".tab-bar-item-active")?.closest("[data-tab-id]")?.getAttribute("data-tab-id") ?? null;
  const commandOrder = () => invoke.mock.calls.map(([command, args]) => `${command}:${(args as { path?: string })?.path ?? ""}`);

  it("reopens the folders and tabs after a reload, whatever order they finish in", async () => {
    const a = persistedTab(workspace, "alpha.md");
    const b = persistedTab(otherRoot, "beta.md");
    setOpenRoots([workspace, otherRoot].map((path) => ({ id: path, path })));
    setTabSession({ tabs: [a, b], activeTabId: b.id }, sessionKey);
    const second = Promise.withResolvers<FSEntry[]>();

    await mountApp({ held: { [otherRoot]: second.promise } });

    // Folder one is open and its tab is restored in the background; folder two
    // is still reading, so nothing is active and the command-line step waits.
    expect(tabIds()).toEqual([a.id]);
    expect(activeTabId()).toBeNull();
    expect(commandOrder()).not.toContain("get_startup_args:");

    // The tab store's debounced write must not erase the pending folder's tab.
    await vi.advanceTimersByTimeAsync(501);
    expect(JSON.parse(localStorage.getItem(sessionKey)!)).toMatchObject({
      tabs: [{ id: a.id }, { id: b.id }], activeTabId: b.id,
    });

    second.resolve([beta]);
    await settleApp();

    expect(tabIds()).toEqual([a.id, b.id]);
    expect(activeTabId()).toBe(b.id);
    expect(calls("mcp_set_roots").at(-1)).toEqual({
      roots: [{ path: workspace, name: "workspace" }, { path: otherRoot, name: "workspace-two" }],
    });
    const order = commandOrder();
    expect(order.indexOf("get_startup_args:")).toBeGreaterThan(order.lastIndexOf(`read_dir:${otherRoot}`));
  }, APP_TIMEOUT);

  it("keeps the saved tabs when the update from a version without the folder list starts the app", async () => {
    const a = persistedTab(workspace, "alpha.md");
    const b = persistedTab(otherRoot, "beta.md");
    setTabSession({ tabs: [a, b], activeTabId: b.id }, sessionKey);
    expect(localStorage.getItem("markdraw-open-roots-v1")).toBeNull();

    await mountApp();
    expect(tabIds()).toEqual([]);
    await vi.advanceTimersByTimeAsync(501);

    // Nothing is open, so nothing is restored, and nothing is erased either.
    expect(JSON.parse(localStorage.getItem(sessionKey)!)).toMatchObject({
      tabs: [{ id: a.id }, { id: b.id }], activeTabId: b.id,
    });
    expect(JSON.parse(localStorage.getItem("markdraw-pending-tab-roots-v1")!)).toEqual([workspace, otherRoot]);
  }, APP_TIMEOUT);

  it("keeps the legacy tabs of another folder when the list the first session wrote is partial", async () => {
    const b = persistedTab(otherRoot, "beta.md");
    setTabSession({ tabs: [b], activeTabId: b.id }, sessionKey);

    // First start after the update, then the user opened an unrelated folder.
    await mountApp();
    cleanup();
    setOpenRoots([{ id: workspace, path: workspace }]);
    expect(JSON.parse(localStorage.getItem(sessionKey)!).tabs.map(({ id }: { id: string }) => id)).toEqual([b.id]);

    // Second start: the folder opens, the other one is not in the list.
    await mountApp();
    expect(tabIds()).toEqual([]);
    await vi.advanceTimersByTimeAsync(501);

    expect(JSON.parse(localStorage.getItem(sessionKey)!)).toMatchObject({ tabs: [{ id: b.id }], activeTabId: b.id });
    expect(getOpenRoots()).toEqual([{ id: workspace, path: workspace }]);
  }, APP_TIMEOUT);

  it("restores the tabs of a pane that does not have the focus when its folder opens", async () => {
    const left = persistedTab(workspace, "alpha.md");
    const right = persistedTab(otherRoot, "beta.md");
    localStorage.setItem(layoutKey, JSON.stringify({ paneCount: 2, activePaneIndex: 0 }));
    setOpenRoots([workspace, otherRoot].map((path) => ({ id: path, path })));
    setTabSession({ tabs: [left], activeTabId: left.id }, sessionKey);
    setTabSession({ tabs: [right], activeTabId: right.id }, "markdraw-tab-session-pane-1");

    await mountApp();

    // Both panes reopen their own tab, the right one active, the focus untouched.
    expect(tabIds()).toEqual([left.id, right.id]);
    expect(Array.from(document.querySelectorAll(".tab-bar-item-active"), (el) =>
      el.closest("[data-tab-id]")?.getAttribute("data-tab-id"))).toEqual([left.id, right.id]);
    expect(JSON.parse(localStorage.getItem(layoutKey)!)).toEqual({ paneCount: 2, activePaneIndex: 0 });
    await vi.advanceTimersByTimeAsync(501);
    expect(JSON.parse(localStorage.getItem("markdraw-tab-session-pane-1")!)).toMatchObject({ tabs: [{ id: right.id }] });
  }, APP_TIMEOUT);

  it("keeps the legacy tabs of the right pane, and its folder's tabs once that folder opens", async () => {
    const right = persistedTab(otherRoot, "beta.md");
    localStorage.setItem(layoutKey, JSON.stringify({ paneCount: 2, activePaneIndex: 0 }));
    setTabSession({ tabs: [right], activeTabId: right.id }, "markdraw-tab-session-pane-1");

    await mountApp();
    await vi.advanceTimersByTimeAsync(501);

    expect(tabIds()).toEqual([]);
    expect(JSON.parse(localStorage.getItem("markdraw-pending-tab-roots-v1")!)).toEqual([otherRoot]);
    expect(JSON.parse(localStorage.getItem("markdraw-tab-session-pane-1")!)).toMatchObject({ tabs: [{ id: right.id }] });
  }, APP_TIMEOUT);

  it("keeps the saved active tab on disk while another folder is still reopening, across a second reload", async () => {
    const first = persistedTab(workspace, "alpha.md");
    const second = persistedTab(workspace, "beta.md");
    setOpenRoots([workspace, otherRoot].map((path) => ({ id: path, path })));
    setTabSession({ tabs: [first, second], activeTabId: second.id }, sessionKey);
    const slow = Promise.withResolvers<FSEntry[]>();

    // The first folder restores both tabs while the second (no tab) still reads.
    await mountApp({ held: { [otherRoot]: slow.promise } });
    expect(tabIds()).toEqual([first.id, second.id]);
    await vi.advanceTimersByTimeAsync(501);

    expect(JSON.parse(localStorage.getItem(sessionKey)!)).toMatchObject({
      tabs: [{ id: first.id }, { id: second.id }], activeTabId: second.id,
    });

    // The reload lands before the slow folder finished: the saved tab is still the active one.
    cleanup();
    await mountApp();
    expect(activeTabId()).toBe(second.id);
  }, APP_TIMEOUT);

  it("lets an explicit choice during the restore win over the saved active tab on disk", async () => {
    const first = persistedTab(workspace, "alpha.md");
    const second = persistedTab(workspace, "beta.md");
    setOpenRoots([workspace, otherRoot].map((path) => ({ id: path, path })));
    setTabSession({ tabs: [first, second], activeTabId: second.id }, sessionKey);
    const slow = Promise.withResolvers<FSEntry[]>();

    await mountApp({ held: { [otherRoot]: slow.promise } });
    expect(activeTabId()).toBeNull();
    (document.querySelector(`[data-tab-id="${first.id}"] .tab-bar-item`) as HTMLElement).click();
    await settleApp();
    expect(activeTabId()).toBe(first.id);
    await vi.advanceTimersByTimeAsync(501);

    expect(JSON.parse(localStorage.getItem(sessionKey)!)).toMatchObject({ activeTabId: first.id });
  }, APP_TIMEOUT);

  it("keeps the saved active tab through a rename while another folder is still reopening", async () => {
    const first = persistedTab(workspace, "alpha.md");
    const second = persistedTab(workspace, "beta.md");
    const renamed = persistedTab(workspace, "renamed.md");
    setOpenRoots([workspace, otherRoot].map((path) => ({ id: path, path })));
    setTabSession({ tabs: [first, second], activeTabId: second.id }, sessionKey);
    const slow = Promise.withResolvers<FSEntry[]>();
    try {
      await mountApp({ held: { [otherRoot]: slow.promise } });
      expect(tabIds()).toEqual([first.id, second.id]);
      const label = Array.from(document.querySelectorAll<HTMLElement>(".tree-name"))
        .find((element) => element.textContent === "beta.md");
      expect(label).toBeDefined();
      label!.closest(".tree-item")!.dispatchEvent(new Event("tree-rename"));
      await settleApp();
      expect(label!.classList.contains("tree-name-editing")).toBe(true);
      label!.textContent = "renamed.md";
      label!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await settleApp();
      expect(calls("rename_file")).toHaveLength(1);
      expect(tabIds()).toEqual([first.id, renamed.id]);
      await vi.advanceTimersByTimeAsync(501);
      expect(JSON.parse(localStorage.getItem(sessionKey)!)).toMatchObject({
        tabs: [{ id: first.id }, { id: renamed.id }], activeTabId: renamed.id,
      });

      // The slow folder lands: the renamed tab is the one that gets activated.
      slow.resolve([]);
      await settleApp();
      expect(activeTabId()).toBe(renamed.id);
    } finally {
      slow.resolve([]);
      await settleApp();
    }
  }, APP_TIMEOUT);

  it("keeps an explicit choice over the renamed saved active tab", async () => {
    const first = persistedTab(workspace, "alpha.md");
    const second = persistedTab(workspace, "beta.md");
    const renamed = persistedTab(workspace, "renamed.md");
    setOpenRoots([workspace, otherRoot].map((path) => ({ id: path, path })));
    setTabSession({ tabs: [first, second], activeTabId: second.id }, sessionKey);
    const slow = Promise.withResolvers<FSEntry[]>();
    try {
      await mountApp({ held: { [otherRoot]: slow.promise } });
      const label = Array.from(document.querySelectorAll<HTMLElement>(".tree-name"))
        .find((element) => element.textContent === "beta.md");
      label!.closest(".tree-item")!.dispatchEvent(new Event("tree-rename"));
      await settleApp();
      label!.textContent = "renamed.md";
      label!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await settleApp();
      expect(tabIds()).toEqual([first.id, renamed.id]);
      (document.querySelector(`[data-tab-id="${first.id}"] .tab-bar-item`) as HTMLElement).click();
      await settleApp();
      slow.resolve([]);
      await settleApp();
      await vi.advanceTimersByTimeAsync(501);
      expect(activeTabId()).toBe(first.id);
      expect(JSON.parse(localStorage.getItem(sessionKey)!)).toMatchObject({ activeTabId: first.id });
    } finally {
      slow.resolve([]);
      await settleApp();
    }
  }, APP_TIMEOUT);

  it("does not restore or save a pane the user collapsed while its folder was still reopening", async () => {
    const left = persistedTab(workspace, "alpha.md");
    const right = persistedTab(otherRoot, "beta.md");
    const rightKey = "markdraw-tab-session-pane-1";
    localStorage.setItem(layoutKey, JSON.stringify({ paneCount: 2, activePaneIndex: 0 }));
    setOpenRoots([workspace, otherRoot].map((path) => ({ id: path, path })));
    setTabSession({ tabs: [left], activeTabId: left.id }, sessionKey);
    setTabSession({ tabs: [right], activeTabId: right.id }, rightKey);
    const slow = Promise.withResolvers<FSEntry[]>();

    await mountApp({ held: { [otherRoot]: slow.promise } });
    expect(tabIds()).toEqual([left.id]);
    (document.querySelector('[aria-label="Split editor"]') as HTMLElement).click();
    await settleApp();
    expect(localStorage.getItem(rightKey)).toBeNull();

    slow.resolve([beta]);
    await settleApp();
    await vi.advanceTimersByTimeAsync(501);

    expect(tabIds()).toEqual([left.id]);
    expect(localStorage.getItem(rightKey)).toBeNull();
    expect(JSON.parse(localStorage.getItem(layoutKey)!)).toEqual({ paneCount: 1, activePaneIndex: 0 });
  }, APP_TIMEOUT);

  it("opens a command-line file after the restored folders and lets it win the focus", async () => {
    const a = persistedTab(workspace, "alpha.md");
    const other = persistedTab(workspace, "beta.md");
    setOpenRoots([{ id: workspace, path: workspace }]);
    setTabSession({ tabs: [a, other], activeTabId: other.id }, sessionKey);

    await mountApp({ args: [`${workspace}/alpha.md`] });

    expect(tabIds()).toEqual([a.id, other.id]);
    expect(activeTabId()).toBe(a.id);
    expect(calls("mcp_set_roots").at(-1)).toEqual({ roots: [{ path: workspace, name: "workspace" }] });
  }, APP_TIMEOUT);

  it("starts empty when nothing was saved, and survives a folder that vanished", async () => {
    setOpenRoots([{ id: "/gone", path: "/gone" }]);
    await mountApp();

    expect(tabIds()).toEqual([]);
    expect(activeTabId()).toBeNull();
    // The vanished folder is dropped; the (now empty) inventory is still an inventory.
    expect(localStorage.getItem("markdraw-open-roots-v1")).toBe("[]");
  }, APP_TIMEOUT);
});

describe("desktop document transitions in Solid 2", () => {
  it("autosaves alpha.md through write_file after closing the active beta.md tab", async () => {
    const { actions, folder, paneManager, watcher } = fixture();
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    const alphaId = openDocument(pane, alpha, "Alpha buffer");
    pane.tabs.updateTabContent(alphaId, { includePaths: ["includes/alpha.md"] });
    flush();
    const betaId = openDocument(pane, beta, "Beta buffer");
    watcher.setTarget({ filePath: `${workspace}/beta.md`, includePaths: [], rootPath: workspace });
    await watcher.start();

    actions.closeTabs(pane, [betaId]);
    flush();
    pane.setEditorContent("Edited Alpha buffer");
    flush();
    await vi.advanceTimersByTimeAsync(1000);

    expect(calls("write_file")).toEqual([{ path: `${workspace}/alpha.md`, content: "Edited Alpha buffer" }]);
    expect(calls("watch_paths").at(-1)).toEqual({
      paths: [`${workspace}/alpha.md`, `${workspace}/includes/alpha.md`],
    });
    expect(pane.tabs.activeTabId()).toBe(alphaId);
    expect(pane.selectedFile()).toEqual(alpha);
  });

  it("moves a working buffer into a newly created pane", async () => {
    const { actions, folder, paneManager } = fixture();
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const source = paneManager.activePane();
    const id = openDocument(source, alpha, "Saved Alpha");
    source.setEditorContent("Unsaved Alpha");
    flush();

    actions.moveTab(id, 0);
    flush();

    const target = paneManager.panes()[1]!;
    expect(paneManager.activePane()).toBe(target);
    expect(target.tabs.getActiveTab()).toMatchObject({
      id, editorContent: "Unsaved Alpha", savedContent: "Saved Alpha", editorMode: "split",
    });
    expect(target.selectedFile()).toEqual(alpha);
    expect(target.editorContent()).toBe("Unsaved Alpha");
    expect(source.tabs.tabs()).toEqual([]);
    expect(source.selectedFile()).toBeNull();
  });

  it("moves between existing panes without overwriting either sibling's cache", async () => {
    const { actions, folder, paneManager } = fixture();
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const source = paneManager.activePane();
    const siblingId = openDocument(source, beta, "Source Beta");
    const id = openDocument(source, alpha, "Source Alpha");
    const target = paneManager.splitFromActive()!;
    flush();
    const targetSiblingId = openDocument(target, alpha, "Other Alpha");
    target.setEditorContent("Other Alpha live");
    flush();
    paneManager.setActivePane(0);
    flush();

    actions.moveTab(id, 0);
    flush();

    expect(target.tabs.getActiveTab()).toMatchObject({ filePath: "alpha.md", editorContent: "Source Alpha" });
    expect(target.tabs.activeTabId()).not.toBe(targetSiblingId);
    expect(target.tabs.getTab(targetSiblingId)?.editorContent).toBe("Other Alpha live");
    expect(target.editorContent()).toBe("Source Alpha");
    expect(target.selectedFile()).toEqual(alpha);
    expect(source.tabs.activeTabId()).toBe(siblingId);
    expect(source.editorContent()).toBe("Source Beta");
    expect(source.selectedFile()).toEqual(beta);
  });

  it("persists the split, focus and collapse before Solid publishes the signals", () => {
    const manager = createPaneManager();
    const second = manager.splitFromActive();
    expect(JSON.parse(localStorage.getItem(layoutKey)!)).toEqual({ paneCount: 2, activePaneIndex: 1 });
    flush();
    expect(manager.activePane()).toBe(second);

    manager.setActivePane(0);
    expect(JSON.parse(localStorage.getItem(layoutKey)!)).toEqual({ paneCount: 2, activePaneIndex: 0 });
    flush();
    manager.setActivePane(1);
    flush();

    manager.collapseRightPane();
    expect(JSON.parse(localStorage.getItem(layoutKey)!)).toEqual({ paneCount: 1, activePaneIndex: 0 });
    flush();
    expect(manager.activePane()).toBe(manager.panes()[0]);
  });

  it("keeps the collapsed pane's debounced write from bringing its session key back", async () => {
    const manager = createPaneManager();
    const right = manager.splitFromActive()!;
    flush();
    openDocument(right, alpha, "Right Alpha");
    const rightKey = "markdraw-tab-session-pane-1";

    manager.collapseRightPane();
    flush();
    right.tabs.persistSession();
    await vi.advanceTimersByTimeAsync(501);
    expect(localStorage.getItem(rightKey)).toBeNull();

    // A pane split again afterwards owns the key and saves normally.
    const again = manager.splitFromActive()!;
    flush();
    openDocument(again, beta, "Again Beta");
    await vi.advanceTimersByTimeAsync(501);
    expect(JSON.parse(localStorage.getItem(rightKey)!)).toMatchObject({ tabs: [{ filePath: "beta.md" }] });
  });

  it("opens nothing and writes nothing for a pane collapsed before its folder finished reopening", async () => {
    const rightKey = "markdraw-tab-session-pane-1";
    const saved = {
      id: `${workspace}::beta.md`, filePath: "beta.md", rootId: workspace,
      fileName: "beta.md", isPinned: true, editorMode: "edit" as const,
    };
    localStorage.setItem(layoutKey, JSON.stringify({ paneCount: 2, activePaneIndex: 0 }));
    setTabSession({ tabs: [saved], activeTabId: saved.id }, rightKey);
    const manager = createPaneManager();
    const right = manager.panes()[1];
    const restore = createSessionRestore(right, () => beta);

    manager.collapseRightPane();
    flush();

    expect(restore.rootsChanged([workspace])).toBeNull();
    expect(restore.settle([workspace])).toBeNull();
    flush();
    expect(right.tabs.tabs()).toEqual([]);
    await vi.advanceTimersByTimeAsync(501);
    expect(localStorage.getItem(rightKey)).toBeNull();
  });

  it("does not settle an activation for a pane collapsed after its tabs were restored", async () => {
    const rightKey = "markdraw-tab-session-pane-1";
    const saved = {
      id: `${workspace}::beta.md`, filePath: "beta.md", rootId: workspace,
      fileName: "beta.md", isPinned: true, editorMode: "edit" as const,
    };
    localStorage.setItem(layoutKey, JSON.stringify({ paneCount: 2, activePaneIndex: 0 }));
    setTabSession({ tabs: [saved], activeTabId: saved.id }, rightKey);
    const manager = createPaneManager();
    const right = manager.panes()[1];
    const restore = createSessionRestore(right, () => beta);
    expect(restore.rootsChanged([workspace])).toBeNull();
    flush();
    expect(right.tabs.tabs().map(({ id }) => id)).toEqual([saved.id]);

    manager.collapseRightPane();
    flush();

    expect(restore.settle([workspace])).toBeNull();
    await vi.advanceTimersByTimeAsync(501);
    expect(localStorage.getItem(rightKey)).toBeNull();
  });

  describe("a saved tab renamed during the restore", () => {
    const paneKey = "markdraw-tab-session-pane-0";
    const savedTab = (name: string) => ({
      id: `${workspace}::${name}`, filePath: name, rootId: workspace,
      fileName: name, isPinned: true, editorMode: "edit" as const,
    });
    const entryFor = (name: string): FSEntry => ({ ...beta, name, path: name });

    it("writes and activates the new id, however many times the tab was renamed", async () => {
      const first = savedTab("alpha.md");
      const second = savedTab("beta.md");
      setTabSession({ tabs: [first, second], activeTabId: second.id }, paneKey);
      const store = createPaneManager().panes()[0];
      const restore = createSessionRestore(store, (path) => entryFor(path));
      expect(restore.rootsChanged([workspace])).toBeNull();
      flush();

      const once = store.tabs.updateTabFile(second.id, "once.md", "once.md", workspace)!;
      flush();
      const twice = store.tabs.updateTabFile(once.id, "twice.md", "twice.md", workspace)!;
      flush();
      // Another folder opens afterwards: the snapshot is held again with the old id.
      expect(restore.rootsChanged([workspace, "/other"])).toBeNull();
      await vi.advanceTimersByTimeAsync(501);
      expect(JSON.parse(localStorage.getItem(paneKey)!)).toMatchObject({ activeTabId: twice.id });
      expect(store.tabs.resolveTabId(second.id)).toBe(twice.id);
      expect(store.tabs.resolveTabId(once.id)).toBe(twice.id);

      expect(restore.settle([workspace, "/other"])).toBe(twice.id);
    });

    it("leaves an id that was never renamed alone, and the saved active tab with it", async () => {
      const first = savedTab("alpha.md");
      const second = savedTab("beta.md");
      setTabSession({ tabs: [first, second], activeTabId: second.id }, paneKey);
      const store = createPaneManager().panes()[0];
      const restore = createSessionRestore(store, (path) => entryFor(path));
      restore.rootsChanged([workspace]);
      flush();

      store.tabs.updateTabFile(first.id, "other.md", "other.md", workspace);
      flush();
      expect(store.tabs.resolveTabId(second.id)).toBe(second.id);
      await vi.advanceTimersByTimeAsync(501);
      expect(JSON.parse(localStorage.getItem(paneKey)!)).toMatchObject({ activeTabId: second.id });
      expect(restore.settle([workspace])).toBe(second.id);
    });

    it("does not follow a rename that the store refused", async () => {
      const first = savedTab("alpha.md");
      const second = savedTab("beta.md");
      setTabSession({ tabs: [first, second], activeTabId: second.id }, paneKey);
      const store = createPaneManager().panes()[0];
      const restore = createSessionRestore(store, (path) => entryFor(path));
      restore.rootsChanged([workspace]);
      flush();

      // alpha.md is taken: the store keeps beta.md as it is.
      expect(store.tabs.updateTabFile(second.id, "alpha.md", "alpha.md", workspace)).toBeUndefined();
      expect(store.tabs.resolveTabId(second.id)).toBe(second.id);
      expect(restore.settle([workspace])).toBe(second.id);
    });
  });

  it("publishes the empty MCP snapshot before stopping the last root's watcher", async () => {
    const { folder, rootPaths, state, watcher } = fixture();
    expect(await folder.openFolderPath(workspace)).toBe(true);
    // With no open tab, a selection change cannot stop the watcher for us.
    watcher.setTarget({ filePath: `${workspace}/alpha.md`, includePaths: [], rootPath: workspace });
    await watcher.start();

    await folder.handleCloseRoot(workspace);

    expect(calls("mcp_set_roots")).toEqual([
      { roots: [] },
      { roots: [{ path: workspace, name: "workspace" }] },
      { roots: [] },
    ]);
    expect(invoke.mock.calls.slice(-3).map(([command]) => command)).toEqual([
      "mcp_set_roots", "plugin:event|unlisten", "stop_watching",
    ]);
    expect(rootPaths().size).toBe(0);
    expect(state.roots().has(workspace)).toBe(false);
  });

  it.each(["focus change", "last root close"])("unsubscribes the delayed watcher registration after a %s", async (route) => {
    const { folder, paneManager, rootPaths, watcher } = fixture();
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const registration = Promise.withResolvers<number>();
    invoke.mockImplementation(async (command) => {
      if (command === "plugin:event|listen") return registration.promise;
    });
    let starting: Promise<void> | undefined;
    try {
      if (route === "focus change") {
        openDocument(paneManager.activePane(), alpha, "Loaded Alpha");
        paneManager.splitFromActive();
        flush();
        paneManager.setActivePane(0);
        flush();
      } else {
        watcher.setTarget({ filePath: `${workspace}/alpha.md`, includePaths: [], rootPath: workspace });
        starting = watcher.start();
      }
      expect(calls("plugin:event|listen")).toHaveLength(1);
      expect(calls("watch_paths")).toEqual([]);

      if (route === "focus change") {
        paneManager.setActivePane(1);
        flush();
      } else {
        await folder.handleCloseRoot(workspace);
        expect(rootPaths().has(workspace)).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(calls("stop_watching")).toHaveLength(1);
      expect(calls("plugin:event|unlisten")).toEqual([]);

      registration.resolve(42);
      await starting;
      await vi.advanceTimersByTimeAsync(0);

      expect(calls("watch_paths")).toEqual([]);
      expect(calls("plugin:event|unlisten")).toEqual([{ event: "fs-change", eventId: 42 }]);
      expect(invoke.mock.calls.slice(-2).map(([command]) => command)).toEqual([
        "stop_watching", "plugin:event|unlisten",
      ]);
    } finally {
      registration.resolve(42);
      await starting;
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("publishes a changed target only when the current watcher registration is ready", async () => {
    const { watcher } = fixture();
    const oldRegistration = Promise.withResolvers<number>();
    const newRegistration = Promise.withResolvers<number>();
    const registrations = [oldRegistration.promise, newRegistration.promise];
    invoke.mockImplementation(async (command) => {
      if (command === "plugin:event|listen") return registrations.shift();
    });
    watcher.setTarget({ filePath: `${workspace}/alpha.md`, includePaths: [], rootPath: workspace });
    const oldStart = watcher.start();
    await watcher.stop();
    const newStart = watcher.start();
    try {
      watcher.setTarget({ filePath: `${workspace}/beta.md`, includePaths: [], rootPath: workspace });
      expect(calls("watch_paths")).toEqual([]);

      newRegistration.resolve(22);
      await newStart;
      expect(calls("watch_paths")).toEqual([{ paths: [`${workspace}/beta.md`] }]);

      oldRegistration.resolve(21);
      await oldStart;
      expect(calls("watch_paths")).toEqual([{ paths: [`${workspace}/beta.md`] }]);
      expect(calls("plugin:event|unlisten")).toEqual([{ event: "fs-change", eventId: 21 }]);

      await watcher.stop();
      expect(calls("plugin:event|unlisten").map(({ eventId }) => eventId)).toEqual([21, 22]);
    } finally {
      oldRegistration.resolve(21);
      newRegistration.resolve(22);
      await Promise.all([oldStart, newStart]);
    }
  });

  it.each(["watch_paths", "stop_watching"] as const)(
    "keeps the focused document in the native holder when an older %s is delayed",
    async (delayedCommand) => {
      const { folder, paneManager } = fixture();
      expect(await folder.openFolderPath(workspace)).toBe(true);
      const { response, applied } = mockWatcherHolder(delayedCommand);
      const alphaPath = `${workspace}/alpha.md`;
      const betaPath = `${workspace}/beta.md`;
      openDocument(paneManager.activePane(), alpha, "Loaded Alpha");
      const right = paneManager.splitFromActive()!;
      flush();
      if (delayedCommand === "watch_paths") openDocument(right, beta, "Loaded Beta");
      try {
        paneManager.setActivePane(0);
        flush();
        await vi.advanceTimersByTimeAsync(0);
        expect(calls("watch_paths")).toEqual([{ paths: [alphaPath] }]);

        paneManager.setActivePane(1);
        flush();
        await vi.advanceTimersByTimeAsync(0);
        if (delayedCommand === "stop_watching") {
          expect(calls("stop_watching")).toHaveLength(1);
          paneManager.setActivePane(0);
          flush();
          await vi.advanceTimersByTimeAsync(0);
        }
        const pathsBeforeResponse = calls("watch_paths");

        response.resolve();
        await vi.advanceTimersByTimeAsync(0);
        const expected = delayedCommand === "watch_paths" ? betaPath : alphaPath;
        expect(paneManager.activePane().selectedFile()?.path).toBe(expected.split("/").at(-1));
        expect(applied.at(-1)).toEqual([expected]);
        expect(pathsBeforeResponse).toEqual([{ paths: [alphaPath] }]);
        expect(applied).toEqual(delayedCommand === "watch_paths"
          ? [[alphaPath], [betaPath]]
          : [[alphaPath], null, [alphaPath]]);
      } finally {
        response.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it("discards superseded targets during rapid focus changes while a publication is in flight", async () => {
    const { folder, paneManager } = fixture();
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const { response, applied } = mockWatcherHolder("watch_paths");
    const alphaPath = `${workspace}/alpha.md`;
    openDocument(paneManager.activePane(), alpha, "Loaded Alpha");
    const right = paneManager.splitFromActive()!;
    flush();
    openDocument(right, beta, "Loaded Beta");
    try {
      paneManager.setActivePane(0);
      flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls("watch_paths")).toEqual([{ paths: [alphaPath] }]);

      for (const index of [1, 0, 1, 0]) {
        paneManager.setActivePane(index);
        flush();
        await vi.advanceTimersByTimeAsync(0);
      }

      response.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(applied).toEqual([[alphaPath], [alphaPath]]);
      expect(calls("watch_paths")).toEqual([{ paths: [alphaPath] }, { paths: [alphaPath] }]);
    } finally {
      response.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("continues with the newly focused target after a watcher IPC rejects", async () => {
    const { folder, paneManager } = fixture();
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const { response, applied } = mockWatcherHolder("watch_paths");
    openDocument(paneManager.activePane(), alpha, "Loaded Alpha");
    const right = paneManager.splitFromActive()!;
    flush();
    openDocument(right, beta, "Loaded Beta");
    try {
      paneManager.setActivePane(0);
      flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls("watch_paths")).toEqual([{ paths: [`${workspace}/alpha.md`] }]);

      paneManager.setActivePane(1);
      flush();
      await vi.advanceTimersByTimeAsync(0);
      response.reject(new Error("Native watcher failed to apply Alpha"));
      await vi.advanceTimersByTimeAsync(0);
      expect(applied).toEqual([[`${workspace}/beta.md`]]);
    } finally {
      response.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("drops waiting paths and finishes destroy with a stop after the in-flight publication", async () => {
    const { watcher } = fixture();
    flush();
    const { response, applied } = mockWatcherHolder("watch_paths");
    const alphaPath = `${workspace}/alpha.md`;
    watcher.setTarget({ filePath: alphaPath, includePaths: [], rootPath: workspace });
    try {
      await watcher.start();
      expect(calls("watch_paths")).toEqual([{ paths: [alphaPath] }]);
      watcher.setTarget({ filePath: `${workspace}/beta.md`, includePaths: [], rootPath: workspace });
      const destroying = watcher.destroy();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls("stop_watching")).toEqual([]);
      expect(applied).toEqual([]);

      response.resolve();
      await destroying;
      expect(applied).toEqual([[alphaPath], null]);
      expect(calls("watch_paths")).toEqual([{ paths: [alphaPath] }]);
    } finally {
      response.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("closes only the acknowledged root's tabs in the active pane, including a dirty tab", async () => {
    const { folder, paneManager, rootPaths, state, watcher } = fixture();
    const other = "/other";
    expect(await folder.openFolderPath(other)).toBe(true);
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const inactive = paneManager.activePane();
    const inactiveId = openDocument(inactive, alpha, "Inactive buffer");
    inactive.setEditorContent("Inactive unsaved changes");
    flush();

    const active = paneManager.splitFromActive()!;
    flush();
    const otherId = active.tabs.openTab(beta, other, { background: true });
    const alphaId = openDocument(active, alpha, "Active buffer");
    const betaId = openDocument(active, beta, "Another tab in this workspace");
    active.setEditorContent("Active unsaved changes");
    flush();
    expect(paneManager.activePane()).toBe(active);

    watcher.setTarget({ filePath: `${workspace}/beta.md`, includePaths: [], rootPath: workspace });
    await watcher.start();
    const update = holdMcpClose();
    const close = folder.handleCloseRoot(workspace);
    try {
      await update.received.promise;
      expect(calls("mcp_set_roots").at(-1)).toEqual({ roots: [{ path: other, name: "other" }] });
      expect(rootPaths().has(workspace)).toBe(true);
      expect(state.roots().has(workspace)).toBe(true);
      expect(active.tabs.tabs().map(({ id }) => id)).toEqual([otherId, alphaId, betaId]);
      expect(calls("stop_watching")).toEqual([]);

      update.response.resolve();
      await close;

      expect([...rootPaths().keys()]).toEqual([other]);
      expect([...state.roots().keys()]).toEqual([other]);
      expect(active.tabs.tabs().map(({ id }) => id)).toEqual([otherId]);
      expect(active.tabs.activeTabId()).toBe(otherId);
      expect(active.selectedFile()).toEqual(beta);
      expect(active.selectedRootId()).toBe(other);
      expect(inactive.tabs.activeTabId()).toBe(inactiveId);
      expect(inactive.editorContent()).toBe("Inactive unsaved changes");
      expect(calls("stop_watching")).toEqual([]);
      expect(calls("write_file")).toEqual([]);
    } finally {
      update.response.resolve();
      await close;
    }
  });

  it("preserves roots, tabs, buffer and watcher when MCP rejects the close", async () => {
    const { folder, paneManager, rootPaths, state, watcher } = fixture();
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    const id = openDocument(pane, alpha, "Saved text");
    pane.setEditorContent("Unsaved text");
    flush();
    watcher.setTarget({ filePath: `${workspace}/alpha.md`, includePaths: [], rootPath: workspace });
    await watcher.start();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const update = holdMcpClose();
    const close = folder.handleCloseRoot(workspace);
    try {
      await update.received.promise;
      update.response.reject(new Error("MCP rejected the workspace update"));
      await close;

      expect(calls("mcp_set_roots")).toEqual([
        { roots: [] },
        { roots: [{ path: workspace, name: "workspace" }] },
        { roots: [] },
      ]);
      expect(warn).toHaveBeenCalledWith("Could not update MCP workspaces");
      expect([...rootPaths().keys()]).toEqual([workspace]);
      expect([...state.roots().keys()]).toEqual([workspace]);
      expect(pane.tabs.tabs().map((tab) => tab.id)).toEqual([id]);
      expect(pane.tabs.activeTabId()).toBe(id);
      expect(pane.selectedFile()).toEqual(alpha);
      expect(pane.selectedRootId()).toBe(workspace);
      expect(pane.editorContent()).toBe("Unsaved text");
      expect(pane.savedContent()).toBe("Saved text");
      expect(calls("stop_watching")).toEqual([]);
      expect(calls("plugin:event|unlisten")).toEqual([]);
      expect(calls("write_file")).toEqual([]);
    } finally {
      update.response.resolve();
      await close;
    }
  });
});

describe("reopening a converted tab", () => {
  function tabCacheFixture(ownWrites?: OwnWrites) {
    const app = fixture(true, ownWrites);
    const pane = app.paneManager.activePane();
    const include = "includes/section.md";
    const path = `${workspace}/${alpha.path}`;
    let disk = `Alpha\n<!-- include: ${include} -->`;
    let section = "Section";
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return [alpha, beta];
      if (command === "read_file") return args.path === path ? disk : "Beta";
      if (command === "read_files_relative") return { [include]: section };
      if (command === "plugin:event|listen") return 1;
    });
    const run = async (action: void | Promise<unknown>) => {
      await vi.advanceTimersByTimeAsync(20);
      await action;
      flush();
    };
    const finishWatcher = async (event: Promise<void>) => {
      const settled = vi.fn();
      void event.then(settled, settled);
      await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
      await event;
      flush();
    };
    const holdDiskRead = () => {
      const response = Promise.withResolvers<string>();
      const reading = Promise.withResolvers<void>();
      const original = invoke.getMockImplementation()!;
      let blocked = false;
      invoke.mockImplementation(async (command, args) => {
        if (command === "read_file" && args.path === path && !blocked) {
          blocked = true;
          reading.resolve();
          return response.promise;
        }
        return original(command, args);
      });
      return { response, reading };
    };
    const open = (entry: FSEntry) => run(app.actions.openFile(entry, workspace, true));
    return {
      ...app, pane, path, include, run, open, finishWatcher, holdDiskRead,
      get disk() { return disk; },
      writeDisk: (text: string) => { disk = text; },
      writeInclude: (text: string) => { section = text; },
      reads: () => calls("read_file").filter((args) => args.path === path).length,
    };
  }

  it.each([
    { route: "tree", source: "recursive", includeChanged: false },
    { route: "tab bar", source: "recursive", includeChanged: false },
    { route: "tab bar", source: "focused", includeChanged: true },
    { route: "unfocused pane", source: "recursive", includeChanged: true },
  ] as const)(
    "refreshes HTML after late disk invalidation from the $source watcher on the $route",
    async ({ route, source, includeChanged }) => {
      const ownWrites = createOwnWrites();
      const app = tabCacheFixture(ownWrites);
      const { actions, finishWatcher, folder, holdDiskRead, include, loader, open, pane, paneManager, path, reads, run } = app;
      await folder.openFolderPath(workspace);
      await open(alpha);
      const id = pane.tabs.activeTabId()!;
      ownWrites.mark(path, app.disk);
      await open(beta);

      const nextText = "Latest text from disk";
      if (includeChanged) app.writeInclude(nextText);
      else app.writeDisk(nextText);
      const { reading, response } = holdDiskRead();
      const onRefreshed = vi.fn((target: PaneStore, tabId?: string) => {
        if (tabId) actions.updateLoadedTabCache(target, tabId);
      });
      const event = loader.handleWatcherChange(includeChanged ? [path, `${workspace}/${include}`] : [path], source, onRefreshed);
      try {
        await reading.promise;
        if (route === "unfocused pane") {
          const right = paneManager.splitFromActive()!;
          flush();
          await open(beta);
          expect(paneManager.activePane()).toBe(right);
        }
        if (route === "tree") await open(alpha);
        else await run(actions.activateTab(pane, id));
        expect(pane.tabs.activeTabId()).toBe(id);
        expect(pane.html()).toBe("<p>Section</p>");
        expect(pane.tabs.getActiveTab()?.diskChange).toBeUndefined();
        expect(reads()).toBe(2);

        response.resolve(app.disk);
        await finishWatcher(event);
        expect(pane.html()).toBe(`<p>${nextText}</p>`);
        expect(pane.tabs.getActiveTab()).toMatchObject({ html: `<p>${nextText}</p>`, diskChange: undefined });
        expect(pane.loading()).toBe(false);
        expect(reads()).toBe(3);
        expect(onRefreshed).toHaveBeenCalledExactlyOnceWith(pane, id, !includeChanged);
        if (route === "unfocused pane") {
          expect(paneManager.activePane()).not.toBe(pane);
          expect(paneManager.activePane().html()).toBe("<p>Beta</p>");
        }
      } finally {
        response.resolve(app.disk);
        await finishWatcher(event);
      }
    },
  );

  it("uses the late watcher focus to verify an autosave echo for the newly focused pane", async () => {
    const ownWrites = createOwnWrites();
    const app = tabCacheFixture(ownWrites);
    const { actions, finishWatcher, folder, holdDiskRead, loader, open, pane, paneManager, path, state } = app;
    await folder.openFolderPath(workspace);
    await open(alpha);
    ownWrites.mark(path, app.disk);
    const id = pane.tabs.activeTabId()!;
    pane.setHtml("<p>Previous preview error</p>");
    state.notePreviewFailed(pane, workspace, alpha.path, id);
    paneManager.splitFromActive();
    flush();
    await open(beta);
    const { reading, response } = holdDiskRead();
    const onRefreshed = vi.fn();
    const event = loader.handleWatcherChange([path], "focused", onRefreshed);
    try {
      await reading.promise;
      paneManager.setActivePane(0);
      flush();
      expect(paneManager.activePane()).toBe(pane);
      expect(pane.html()).toBe("<p>Previous preview error</p>");
      response.resolve(app.disk);
      await finishWatcher(event);
      expect(pane.html()).toBe("<p>Section</p>");
      expect(pane.tabs.getActiveTab()?.diskChange).toBeUndefined();
      expect(onRefreshed).toHaveBeenCalledExactlyOnceWith(pane, id, false);
    } finally {
      response.resolve(app.disk);
      await finishWatcher(event);
    }
  });

  it.each(["unsaved edit", "auto-refresh disabled"] as const)(
    "keeps the mark from a late watcher event with %s",
    async (condition) => {
      const ownWrites = createOwnWrites();
      const app = tabCacheFixture(ownWrites);
      const { finishWatcher, folder, holdDiskRead, loader, open, pane, path, reads, state } = app;
      await folder.openFolderPath(workspace);
      await open(alpha);
      ownWrites.mark(path, app.disk);
      const before = app.disk;
      app.writeDisk("External text");
      const { reading, response } = holdDiskRead();
      const event = loader.handleWatcherChange([path], "recursive");
      const expected = condition === "unsaved edit" ? `${before}\nUnsaved edit` : before;
      try {
        await reading.promise;
        if (condition === "unsaved edit") pane.setEditorContent(expected);
        else state.setAutoRefresh(false);
        flush();
        response.resolve(app.disk);
        await finishWatcher(event);
        expect(pane.tabs.getActiveTab()?.diskChange).toBeDefined();
        expect(pane.editorContent()).toBe(expected);
        expect(pane.savedContent()).toBe(before);
        expect(pane.html()).toBe("<p>Section</p>");
        // The read needed to classify the notification is the only extra read.
        expect(reads()).toBe(2);
      } finally {
        response.resolve(app.disk);
        await finishWatcher(event);
      }
    },
  );

  it.each([
    { order: "focused only", sources: ["focused"], unfocused: false },
    { order: "focused first", sources: ["focused", "recursive"], unfocused: false },
    { order: "recursive first", sources: ["recursive", "focused"], unfocused: false },
    { order: "recursive on an unfocused pane", sources: ["recursive"], unfocused: true },
  ] as const)("refreshes an include with unsaved edits ($order)", async ({ sources, unfocused }) => {
    const app = tabCacheFixture();
    const { disk, finishWatcher, folder, include, loader, open, pane, paneManager, state } = app;
    await folder.openFolderPath(workspace);
    await open(alpha);
    expect(pane.html()).toBe("<p>Section</p>");

    const edited = `${disk}\nUnsaved user edit`;
    pane.setEditorContent(edited);
    flush();
    if (unfocused) {
      paneManager.splitFromActive();
      flush();
      await open(beta);
      expect(paneManager.activePane()).not.toBe(pane);
    }
    app.writeInclude("Updated section");
    for (const source of sources) {
      await finishWatcher(loader.handleWatcherChange([`${workspace}/${include}`], source));
    }

    expect(pane.html()).toBe("<p>Updated section</p>");
    expect(pane.editorContent()).toBe(edited);
    expect(pane.savedContent()).toBe(disk);
    expect(pane.tabs.getActiveTab()?.diskChange).toBeUndefined();
    expect(await state.previewReflects(pane, workspace, alpha.path, edited)).toBe(true);
    if (unfocused) expect(paneManager.activePane().html()).toBe("<p>Beta</p>");
  });

  it.each([
    { source: "focused", batch: "file only" },
    { source: "recursive", batch: "file and include" },
  ] as const)("skips a main-file change with unsaved edits ($batch)", async ({ source, batch }) => {
    const app = tabCacheFixture();
    const { disk, finishWatcher, folder, include, loader, open, pane, path, reads } = app;
    await folder.openFolderPath(workspace);
    await open(alpha);
    const edited = `${disk}\nUnsaved user edit`;
    pane.setEditorContent(edited);
    flush();

    const paths = [path];
    if (batch === "file and include") {
      // Saving the main file can leave the same bytes on disk. The main-file
      // path still prevents this batch from becoming an include-only refresh.
      paths.push(`${workspace}/${include}`);
      app.writeInclude("Updated section");
    } else {
      app.writeDisk("External main-file text");
    }
    const onRefreshed = vi.fn();
    await finishWatcher(loader.handleWatcherChange(paths, source, onRefreshed));

    expect(pane.tabs.getActiveTab()?.diskChange).toBeDefined();
    expect(pane.html()).toBe("<p>Section</p>");
    expect(pane.editorContent()).toBe(edited);
    expect(pane.savedContent()).toBe(disk);
    expect(reads()).toBe(1);
    expect(onRefreshed).not.toHaveBeenCalled();
  });

  it.each([
    { error: "No such file or directory", edit: "before the event" },
    { error: "Stream did not contain valid UTF-8", edit: "before the event" },
    { error: "No such file or directory", edit: "during the read" },
    { error: "Stream did not contain valid UTF-8", edit: "during the read" },
    { error: "Permission denied", edit: "during the read" },
    { error: "No such file or directory", edit: "none" },
  ])("handles a watcher read error in an unfocused pane ($error, edit: $edit)", async ({ error, edit }) => {
    const { actions, finishWatcher, folder, loader, open, pane, paneManager } = tabCacheFixture();
    const notes: FSEntry = { kind: "file", name: "notes.txt", path: "notes.txt" };
    const path = `${workspace}/${notes.path}`;
    const saved = "Saved notes";
    const edited = "Unsaved notes";
    const response = Promise.withResolvers<string>();
    const original = invoke.getMockImplementation()!;
    let failRead = false;
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return [notes, beta];
      if (command !== "read_file" || args.path !== path) return original(command, args);
      if (!failRead) return saved;
      if (edit === "during the read") return response.promise;
      throw new Error(error);
    });
    await folder.openFolderPath(workspace);
    await open(notes);
    expect(pane.editorContent()).toBe(saved);
    expect(pane.savedContent()).toBe(saved);
    const id = pane.tabs.activeTabId()!;
    paneManager.splitFromActive();
    flush();
    await open(beta);
    expect(paneManager.activePane()).not.toBe(pane);

    if (edit === "before the event") {
      pane.setEditorContent(edited);
      flush();
      actions.updateLoadedTabCache(pane, id);
    }
    flush();
    failRead = true;
    const event = loader.handleWatcherChange([path], "recursive", (target, tabId) => {
      if (tabId) actions.updateLoadedTabCache(target, tabId);
    });
    try {
      if (edit === "during the read") {
        await vi.advanceTimersByTimeAsync(10);
        expect(calls("read_file").filter((args) => args.path === path)).toHaveLength(2);
        pane.setEditorContent(edited);
        flush();
        response.reject(new Error(error));
      }
      await finishWatcher(event);
    } finally {
      response.resolve(saved);
      await finishWatcher(event);
    }

    const expected = edit === "none"
      ? { editorContent: "", savedContent: "", html: UNSUPPORTED_CONTENT }
      : { editorContent: edited, savedContent: saved, html: "" };
    expect(pane.editorContent()).toBe(expected.editorContent);
    expect(pane.savedContent()).toBe(expected.savedContent);
    expect(pane.html()).toBe(expected.html);
    expect(pane.tabs.getTab(id)?.diskChange).toBeDefined();
    expect(pane.tabs.getTab(id)).toMatchObject(expected);
    expect(calls("read_file").filter((args) => args.path === path)).toHaveLength(edit === "before the event" ? 1 : 2);
    expect(paneManager.activePane().html()).toBe("<p>Beta</p>");
  });

  it.each(["active tab bar", "active tree", "inactive tab bar"])(
    "preserves unsaved text on the %s after an include event",
    async (route) => {
      const { folder, pane, open, disk, state, actions, include, loader, run, reads } = tabCacheFixture();
      await folder.openFolderPath(workspace);
      await open(alpha);
      const id = pane.tabs.activeTabId()!;
      const edited = `${disk}\nUnsaved user edit`;
      state.debouncedConvert(edited, alpha.path, async () => null);
      flush();
      expect(pane.tabs.getTab(id)?.editorContent).toBe(disk);
      if (route === "inactive tab bar") await open(beta);
      await loader.markDiskChanges([`${workspace}/${include}`]);
      flush();
      const mark = pane.tabs.getTab(id)?.diskChange;
      expect(mark).toBeDefined();

      const selection = route === "active tree" ? actions.openFile(alpha, workspace) : actions.activateTab(pane, id);
      try {
        flush();
        expect(pane.loading()).toBe(false);
        expect(pane.html()).toBe("<p>Section</p>");
      } finally {
        await run(selection);
      }

      expect(pane.editorContent()).toBe(edited);
      expect(pane.savedContent()).toBe(disk);
      expect(pane.tabs.getTab(id)?.diskChange).toBe(mark);
      expect(reads()).toBe(1);
    },
  );

  it.each(["stays on the tab", "switches away"])(
    "preserves edits made during a disk reload when the user %s",
    async (route) => {
      const { folder, pane, open, disk, actions, path, loader, run } = tabCacheFixture();
      await folder.openFolderPath(workspace);
      await open(alpha);
      const id = pane.tabs.activeTabId()!;
      await open(beta);
      await loader.markDiskChanges([path]);
      flush();
      const held = Promise.withResolvers<string>();
      const started = vi.fn();
      const original = invoke.getMockImplementation()!;
      invoke.mockImplementation(async (command, args) => {
        if (command === "read_file" && args.path === path) {
          started();
          return held.promise;
        }
        return original(command, args);
      });
      const loading = actions.activateTab(pane, id);
      try {
        await vi.advanceTimersByTimeAsync(5);
        expect(started).toHaveBeenCalledOnce();
        const edits = `${disk}\nTyped during the read`;
        pane.setEditorContent(edits);
        pane.tabs.updateTabContent(id, { previewScrollTop: 137, previewScrollAnchor: { blockIndex: 0, offset: 12 } });
        flush();
        if (route === "switches away") {
          pane.tabs.setScrollCapture(() => ({ previewScrollTop: 0, previewScrollAnchor: null }));
          await run(actions.activateTab(pane, pane.tabs.findTabByFile(beta.path, workspace)!.id));
          expect(pane.tabs.getTab(id)).toMatchObject({
            editorContent: edits,
            previewScrollTop: 137,
            previewScrollAnchor: { blockIndex: 0, offset: 12 },
          });
        }
        held.resolve("External text from the pending read");
        await run(loading);
        if (route === "switches away") await run(actions.activateTab(pane, id));
        expect(pane.editorContent()).toBe(edits);
        expect(pane.savedContent()).toBe(disk);
        expect(pane.html()).toBe("<p>Section</p>");
        expect(pane.tabs.getTab(id)?.diskChange).toBeDefined();
        expect(pane.loading()).toBe(false);
      } finally {
        held.resolve("");
        await run(loading);
      }
    },
  );

  it.each(["recursive first", "focused first", "overlapping"])(
    "keeps a saved preview through an autosave echo with the %s watcher delivery",
    async (order) => {
      const ownWrites = createOwnWrites();
      const app = tabCacheFixture(ownWrites);
      const { folder, pane, open, loader, path, actions, run, reads, include, finishWatcher } = app;
      await folder.openFolderPath(workspace);
      await open(alpha);
      const id = pane.tabs.activeTabId()!;
      const saved = `${app.disk}\nSaved edit`;
      ownWrites.mark(path, saved);
      app.writeDisk(saved);
      pane.setEditorContent(saved);
      pane.setSavedContent(saved);
      app.state.notePreviewed(pane, workspace, alpha.path, saved);
      flush();
      const paths = [path];
      const recursive = () => finishWatcher(loader.handleWatcherChange(paths, "recursive"));
      const focused = () => finishWatcher(loader.handleWatcherChange(paths, "focused"));

      if (order === "recursive first") await recursive();
      if (order === "overlapping") await Promise.all([focused(), recursive()]);
      else await focused();
      if (order === "focused first") await recursive();
      flush();
      expect(pane.tabs.getTab(id)?.diskChange).toBeUndefined();
      const beforeReturn = reads();
      await open(beta);
      await run(actions.activateTab(pane, id));
      expect(reads()).toBe(beforeReturn);
      expect(pane.html()).toBe("<p>Section</p>");

      await open(beta);
      app.writeInclude("Updated include");
      await loader.markDiskChanges([path, `${workspace}/${include}`]);
      flush();
      expect(pane.tabs.getTab(id)?.diskChange).toBeDefined();
      await run(actions.activateTab(pane, id));
      expect(pane.html()).toBe("<p>Updated include</p>");

      await open(beta);
      app.writeDisk("External text after the save");
      await recursive();
      flush();
      expect(pane.tabs.getTab(id)?.diskChange).toBeDefined();
      await run(actions.activateTab(pane, id));
      expect(pane.html()).toBe("<p>External text after the save</p>");
    },
  );

  it.each([
    { changed: "file", expectedHtml: "<p>Replacement main file</p>" },
    { changed: "include", expectedHtml: "<p>Replacement section</p>" },
  ])("retains the $changed disk change when moving a dirty tab between panes", async ({ changed, expectedHtml }) => {
    const app = tabCacheFixture();
    const { actions, disk, finishWatcher, folder, include, loader, open, pane, paneManager, path, reads, run } = app;
    await folder.openFolderPath(workspace);
    await open(alpha);
    const id = pane.tabs.activeTabId()!;
    const edited = `${disk}\nLocal text`;
    pane.setEditorContent(edited);
    flush();
    await open(beta);

    if (changed === "file") app.writeDisk("Replacement main file");
    else app.writeInclude("Replacement section");
    await finishWatcher(loader.handleWatcherChange([changed === "file" ? path : `${workspace}/${include}`], "recursive"));
    const diskChange = pane.tabs.getTab(id)?.diskChange;
    expect(diskChange).toBeDefined();
    const readsBeforeMove = reads();

    actions.moveTab(id, 0);
    await run();
    const target = paneManager.activePane();
    const targetId = target.tabs.activeTabId()!;
    expect(target).not.toBe(pane);
    expect(target.editorContent()).toBe(edited);
    expect(reads()).toBe(readsBeforeMove);
    expect(target.tabs.getTab(targetId)?.diskChange).toBe(diskChange);

    target.setEditorContent(disk);
    flush();
    await run(actions.activateTab(target, targetId));
    expect(reads()).toBe(readsBeforeMove + 1);
    expect(target.html()).toBe(expectedHtml);
    expect(target.tabs.getTab(targetId)?.diskChange).toBeUndefined();
  });

  it.each(["unchanged", "file", "include"])("reopens through openFile after a %s disk event", async (change) => {
    const { loader, paneManager, actions, folder } = fixture(true);
    const include = "includes/section.md";
    let disk = `Alpha\n<!-- include: ${include} -->`;
    let section = "Original include";
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return [alpha, beta];
      if (command === "read_file") return args.path === `${workspace}/alpha.md` ? disk : "Beta";
      if (command === "read_files_relative") return { [include]: section };
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    const open = async (entry: FSEntry) => {
      const opening = actions.openFile(entry, workspace, true);
      await vi.advanceTimersByTimeAsync(10);
      await opening;
    };
    await open(alpha);
    const tabId = pane.tabs.activeTabId()!;
    expect(pane.tabs.getTab(tabId)?.includePaths).toEqual([include]);
    await open(beta);
    if (change === "file") disk = `Edited alpha\n<!-- include: ${include} -->`;
    if (change === "include") section = "Edited include";
    if (change !== "unchanged") {
      loader.markDiskChanges([`${workspace}/${change === "file" ? alpha.path : include}`]);
      flush();
      expect(pane.tabs.getTab(tabId)?.diskChange).toBeDefined();
      expect(pane.tabs.getActiveTab()?.diskChange).toBeUndefined();
    }

    await open(alpha);
    expect(pane.tabs.activeTabId()).toBe(tabId);
    expect(pane.html()).toBe(`<p>${section}</p>`);
    expect(pane.editorContent()).toBe(disk);
    expect(pane.tabs.getActiveTab()?.diskChange).toBeUndefined();
    const fileReads = calls("read_file").filter((args) => args.path === `${workspace}/alpha.md`);
    expect(fileReads).toHaveLength(change === "unchanged" ? 1 : 2);
    expect(calls("read_files_relative")).toHaveLength(change === "unchanged" ? 1 : 2);
  });

  it("retries a selected tab when an include changes during its disk read", async () => {
    const { loader, paneManager, actions, folder } = fixture(true);
    const include = "includes/section.md";
    const firstRead = Promise.withResolvers<Record<string, string>>();
    let section = "Original";
    let paused = false;
    let blocked = false;
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return [alpha, beta];
      if (command === "read_file") return args.path === `${workspace}/alpha.md`
        ? `Alpha\n<!-- include: ${include} -->`
        : "Beta";
      if (command === "read_files_relative") {
        if (paused && !blocked) {
          blocked = true;
          return firstRead.promise;
        }
        return { [include]: section };
      }
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    const advance = async (opening: Promise<void>) => {
      await vi.advanceTimersByTimeAsync(20);
      await opening;
    };
    await advance(actions.openFile(alpha, workspace, true));
    const id = pane.tabs.activeTabId()!;
    await advance(actions.openFile(beta, workspace, true));
    loader.markDiskChanges([`${workspace}/${include}`]);
    flush();
    paused = true;
    const opening = actions.activateTab(pane, id);
    try {
      await vi.advanceTimersByTimeAsync(5);
      expect(blocked).toBe(true);
      expect(pane.html()).toBe("");
      section = "Latest";
      loader.markDiskChanges([`${workspace}/${include}`]);
      flush();
      firstRead.resolve({ [include]: "Intermediate" });

      await vi.advanceTimersByTimeAsync(2);
      expect(pane.html()).not.toContain("Intermediate");
      await advance(Promise.resolve(opening));
      expect(pane.html()).toBe("<p>Latest</p>");
      expect(pane.tabs.getActiveTab()?.diskChange).toBeUndefined();
      expect(calls("read_files_relative")).toHaveLength(3);
    } finally {
      firstRead.resolve({ [include]: "Intermediate" });
      await advance(Promise.resolve(opening));
    }

  });
});

describe("activation of an unloaded tab", () => {
  it.each(["before", "after"])("watches Alpha and its includes when focus returns %s the first read", async (when) => {
    const { paneManager, actions, folder } = fixture();
    const readAlpha = Promise.withResolvers<string>();
    const include = "includes/alpha.md";
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return [alpha, beta];
      if (command === "read_file") return args.path === `${workspace}/alpha.md` ? readAlpha.promise : "Beta";
      if (command === "read_files_relative") return { [include]: "Included text" };
      if (command === "plugin:event|listen") return 1;
    });
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const left = paneManager.activePane();
    const right = paneManager.splitFromActive();
    flush();
    const openingBeta = actions.openFile(beta, workspace);
    await vi.advanceTimersByTimeAsync(10);
    await openingBeta;
    expect(paneManager.activePane()).toBe(right);

    paneManager.setActivePane(0);
    flush();
    const openingAlpha = actions.openFile(alpha, workspace);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(calls("read_file")).toEqual([{ path: `${workspace}/beta.md` }, { path: `${workspace}/alpha.md` }]);
      expect(left.loading()).toBe(true);
      paneManager.setActivePane(1);
      flush();
      await vi.advanceTimersByTimeAsync(0);
      const betaWatch = { paths: [`${workspace}/beta.md`] };
      expect(calls("watch_paths").at(-1)).toEqual(betaWatch);

      if (when === "before") {
        paneManager.setActivePane(0);
        flush();
        await vi.advanceTimersByTimeAsync(0);
        expect(calls("watch_paths").at(-1)).toEqual(betaWatch);
      }

      readAlpha.resolve(`Alpha\n<!-- include: ${include} -->`);
      await vi.advanceTimersByTimeAsync(10);
      await openingAlpha;
      expect(left.loading()).toBe(false);
      expect(left.tabs.getActiveTab()?.includePaths).toEqual([include]);
      if (when === "after") {
        expect(calls("watch_paths").at(-1)).toEqual(betaWatch);
        paneManager.setActivePane(0);
        flush();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(paneManager.activePane()).toBe(left);
      expect(calls("watch_paths").at(-1)).toEqual({
        paths: [`${workspace}/alpha.md`, `${workspace}/${include}`],
      });
    } finally {
      readAlpha.resolve("Alpha");
      await vi.advanceTimersByTimeAsync(10);
      await openingAlpha;
    }
  });

  it("loads the renamed path and keeps editing and Save blocked until the replacement read finishes", async () => {
    const { state, paneManager, actions, folder } = fixture();
    const oldRead = Promise.withResolvers<string>();
    const newRead = Promise.withResolvers<string>();
    const renamed = { ...alpha, path: "renamed.md", name: "renamed.md" };
    let entries = [alpha, beta];
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return entries;
      if (command === "read_file") return args.path === `${workspace}/alpha.md` ? oldRead.promise : newRead.promise;
      if (command === "rename_file") entries = [renamed, beta];
      if (command === "plugin:event|listen") return 1;
    });
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    const opening = actions.openFile(alpha, workspace);
    try {
      pane.setEditorMode("edit");
      flush();
      const { container } = render(() => createComponent(PaneView, { pane, state, paneIndex: 0, isActive: true }));
      await vi.advanceTimersByTimeAsync(1);
      const oldId = pane.tabs.activeTabId();
      expect(oldId).toBe(`${workspace}::alpha.md`);
      expect(calls("read_file")).toEqual([{ path: `${workspace}/alpha.md` }]);
      expect(container.querySelector(".cm-content")).toBeNull();

      await folder.handleRename(alpha, workspace, renamed.name);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls("rename_file")).toEqual([{ root: workspace, oldRelative: alpha.path, newRelative: renamed.path }]);
      expect(calls("read_file")).toEqual([{ path: `${workspace}/alpha.md` }, { path: `${workspace}/renamed.md` }]);
      expect(pane.tabs.activeTabId()).toBe(`${workspace}::renamed.md`);
      expect(pane.tabs.getTab(oldId!)).toBeUndefined();
      expect(pane.selectedFile()).toEqual(renamed);

      oldRead.resolve("Stale result under the old name");
      await vi.advanceTimersByTimeAsync(10);
      await opening;
      expect(pane.loading()).toBe(true);
      expect(pane.tabs.getActiveTab()?.needsLoad).toBe(true);
      expect(pane.editorContent()).toBe("");
      expect(container.querySelector(".cm-content")).toBeNull();
      pane.setEditorContent("Write must be blocked");
      flush();
      await folder.handleEditorSave();
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls("write_file")).toEqual([]);

      const diskContent = "Original content from renamed.md";
      newRead.resolve(diskContent);
      await vi.advanceTimersByTimeAsync(10);
      expect(pane.loading()).toBe(false);
      expect(pane.tabs.getActiveTab()).toMatchObject({
        filePath: renamed.path, needsLoad: false, editorContent: diskContent, savedContent: diskContent,
      });
      const editor = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!);
      expect(editor?.state.doc.toString()).toBe(diskContent);
      editor!.dispatch({ changes: { from: diskContent.length, insert: " + edit" } });
      flush();
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls("write_file")).toEqual([{ path: `${workspace}/renamed.md`, content: `${diskContent} + edit` }]);
    } finally {
      oldRead.resolve("");
      newRead.resolve("");
      await vi.advanceTimersByTimeAsync(10);
      await opening;
    }
  });

  it("restarts the active first read after an ancestor folder rename and repoints background tabs without reloading", async () => {
    const { paneManager, actions, folder } = fixture();
    const oldRead = Promise.withResolvers<string>();
    const newRead = Promise.withResolvers<string>();
    const original = { ...alpha, path: "dir/nested/alpha.md" };
    const background = { ...beta, path: "dir/nested/beta.md" };
    const renamed = { ...alpha, path: "renamed/nested/alpha.md" };
    const dir: FSEntry = {
      kind: "directory", path: "dir", name: "dir",
      children: [{ kind: "directory", path: "dir/nested", name: "nested", children: [original, background] }],
    };
    const newDir: FSEntry = {
      kind: "directory", path: "renamed", name: "renamed",
      children: [{
        kind: "directory", path: "renamed/nested", name: "nested",
        children: [renamed, { ...background, path: "renamed/nested/beta.md" }],
      }],
    };
    let entries = [dir];
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return entries;
      if (command === "read_file") return args.path === `${workspace}/${original.path}` ? oldRead.promise : newRead.promise;
      if (command === "rename_file") entries = [newDir];
      if (command === "plugin:event|listen") return 1;
    });
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    const backgroundId = pane.tabs.openTab(background, workspace, { background: true });
    pane.tabs.markTabNeedsLoad(backgroundId);
    flush();

    const opening = actions.openFile(original, workspace);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(calls("read_file")).toEqual([{ path: `${workspace}/${original.path}` }]);

      await folder.handleRename(dir, workspace, newDir.name);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls("rename_file")).toEqual([{ root: workspace, oldRelative: dir.path, newRelative: newDir.path }]);
      expect(calls("read_file")).toEqual([
        { path: `${workspace}/${original.path}` }, { path: `${workspace}/${renamed.path}` },
      ]);
      expect(pane.tabs.activeTabId()).toBe(`${workspace}::${renamed.path}`);
      expect(pane.selectedFile()).toEqual(renamed);

      oldRead.resolve("Obsolete read");
      await vi.advanceTimersByTimeAsync(10);
      await opening;
      expect(pane.loading()).toBe(true);
      expect(pane.tabs.getActiveTab()?.needsLoad).toBe(true);
      expect(pane.editorContent()).toBe("");
      await folder.handleEditorSave();
      expect(calls("write_file")).toEqual([]);

      newRead.resolve("Content under the new folder name");
      await vi.advanceTimersByTimeAsync(10);
      expect(pane.loading()).toBe(false);
      expect(pane.editorContent()).toBe("Content under the new folder name");
      expect(pane.tabs.getActiveTab()).toMatchObject({ filePath: renamed.path, needsLoad: false });
      // The background tab follows the folder to its new path without a read:
      // its pending first read loads the new path only when it is activated.
      expect(pane.tabs.getTab(backgroundId)).toBeUndefined();
      expect(pane.tabs.findTabByFile("renamed/nested/beta.md", workspace)).toMatchObject({
        filePath: "renamed/nested/beta.md", needsLoad: true,
      });
      expect(calls("read_file")).toEqual([
        { path: `${workspace}/${original.path}` }, { path: `${workspace}/${renamed.path}` },
      ]);
    } finally {
      oldRead.resolve("");
      newRead.resolve("");
      await vi.advanceTimersByTimeAsync(10);
      await opening;
    }
  });

  it.each(["close", "close others", "close right", "move", "reopen", "activate", "first open"])(
    "reads and protects the original document via %s",
    async (route) => {
      const { state, paneManager, actions, folder } = fixture();
      const read = Promise.withResolvers<string>();
      const diskContent = "Original file text";
      invoke.mockImplementation(async (command) => {
        if (command === "read_dir") return [alpha, beta];
        if (command === "read_file") return read.promise;
        if (command === "plugin:event|listen") return 1;
      });
      expect(await folder.openFolderPath(workspace)).toBe(true);
      const source = paneManager.activePane();
      const alphaId = route === "first open" ? null : source.tabs.openTab(alpha, workspace, { background: true });
      if (alphaId) source.tabs.markTabNeedsLoad(alphaId);
      flush();
      const betaId = openDocument(source, beta, "Beta buffer");

      if (route === "close") actions.closeTabs(source, [betaId]);
      if (alphaId) {
        if (route === "close others") source.tabs.closeOtherTabs(alphaId);
        if (route === "close right") source.tabs.closeTabsToRight(alphaId);
        if (route === "move") actions.moveTab(alphaId, 0);
        if (route === "reopen") {
          actions.closeTabs(source, [alphaId]);
          flush();
          expect(source.tabs.reopenClosedTab()?.id).toBe(alphaId);
        }
        if (route === "activate") void actions.activateTab(source, alphaId);
      } else {
        void actions.openFile(alpha, workspace);
      }
      flush();
      const pane = paneManager.activePane();
      pane.setEditorMode("edit");
      flush();
      const { container } = render(() => createComponent(PaneView, { pane, state, paneIndex: 0, isActive: true }));
      await vi.advanceTimersByTimeAsync(1);

      expect(calls("read_file")).toEqual([{ path: `${workspace}/alpha.md` }]);
      expect(pane.tabs.getActiveTab()?.needsLoad).toBe(true);
      expect(container.querySelector(".cm-content")).toBeNull();
      // Even an imperative write attempt while loading must be refused.
      pane.setEditorContent("Only newly entered text");
      flush();
      await folder.handleEditorSave();
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls("write_file")).toEqual([]);

      read.resolve(diskContent);
      await vi.advanceTimersByTimeAsync(10);
      flush();
      expect(pane.tabs.getActiveTab()?.needsLoad).toBe(false);
      const editor = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!);
      expect(editor?.state.doc.toString()).toBe(diskContent);
      editor!.dispatch({ changes: { from: diskContent.length, insert: " plus an edit" } });
      flush();
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls("write_file")).toEqual([{
        path: `${workspace}/alpha.md`, content: "Original file text plus an edit",
      }]);
    },
  );

  it("keeps the editor and writes blocked if the read fails", async () => {
    const { state, paneManager, actions, folder } = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockImplementation(async (command) => {
      if (command === "read_dir") return [alpha, beta];
      if (command === "read_file") throw new Error("Reading failed");
    });
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    const id = pane.tabs.openTab(alpha, workspace, { background: true });
    pane.tabs.markTabNeedsLoad(id);
    flush();
    void actions.activateTab(pane, id);
    pane.setEditorMode("edit");
    flush();
    const { container } = render(() => createComponent(PaneView, { pane, state, paneIndex: 0, isActive: true }));
    await vi.advanceTimersByTimeAsync(10);
    expect(pane.loading()).toBe(false);
    expect(pane.html()).toContain("Error converting file: Error: Reading failed");
    expect(pane.tabs.getActiveTab()?.needsLoad).toBe(true);
    expect(container.querySelector(".cm-content")).toBeNull();
    pane.setEditorContent("Should not reach disk");
    flush();
    await folder.handleEditorSave();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls("write_file")).toEqual([]);
  });

  it("stops the watcher when a scratch tab replaces the loaded file without a loader call", async () => {
    const { folder, paneManager, state } = fixture();
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    openDocument(pane, alpha, "Alpha buffer");
    paneManager.splitFromActive();
    flush();
    paneManager.setActivePane(0);
    flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls("watch_paths").at(-1)).toEqual({ paths: [`${workspace}/alpha.md`] });

    const scratch: FSEntry = { kind: "file", path: "scratch.md", name: "scratch.md" };
    pane.tabs.openTab(scratch, "scratch");
    state.setSelectedFile(scratch);
    state.setSelectedRootId("scratch");
    flush();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls("stop_watching").at(-1)).toEqual({});
  });

  it("does not emit STRICT_READ_UNTRACKED when the watcher follows the active tab", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { folder, paneManager } = fixture();
    expect(await folder.openFolderPath(workspace)).toBe(true);
    openDocument(paneManager.activePane(), alpha, "Alpha buffer");
    const right = paneManager.splitFromActive()!;
    openDocument(right, beta, "Beta buffer");
    paneManager.setActivePane(0);
    flush();
    paneManager.setActivePane(1);
    flush();
    await vi.advanceTimersByTimeAsync(0);
    const strict = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("STRICT_READ_UNTRACKED"));
    expect(strict).toEqual([]);
  });

  it("ignores an unloaded tab's late result after switching to another tab", async () => {
    const { paneManager, actions, folder } = fixture();
    const read = Promise.withResolvers<string>();
    invoke.mockImplementation(async (command) => {
      if (command === "read_dir") return [alpha, beta];
      if (command === "read_file") return read.promise;
      if (command === "plugin:event|listen") return 1;
    });
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    const alphaId = pane.tabs.openTab(alpha, workspace, { background: true });
    pane.tabs.markTabNeedsLoad(alphaId);
    flush();
    const betaId = openDocument(pane, beta, "Beta buffer");
    void actions.activateTab(pane, alphaId);
    flush();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls("read_file")).toEqual([{ path: `${workspace}/alpha.md` }]);
    void actions.activateTab(pane, betaId);
    flush();
    read.resolve("Late Alpha");
    await vi.advanceTimersByTimeAsync(10);
    expect(pane.selectedFile()).toEqual(beta);
    expect(pane.editorContent()).toBe("Beta buffer");
    expect(pane.tabs.getTab(alphaId)?.needsLoad).toBe(true);
    expect(pane.loading()).toBe(false);
  });
});

describe("rename and move re-aim the shared watcher", () => {
  it.each([
    ["selection", "rename"],
    ["selection", "move within root"],
    ["selection", "move across roots"],
    ["watcher", "rename"],
    ["watcher", "move within root"],
    ["watcher", "move across roots"],
  ] as const)(
    "finishes a pending disk reload from %s after a %s",
    async (source, route) => {
      const { loader, paneManager, actions, folder } = fixture();
      const other = "/other";
      const destinationRoot = route === "move across roots" ? other : workspace;
      const entry: FSEntry = route === "rename"
        ? { kind: "file", path: "renamed.md", name: "renamed.md" }
        : { ...alpha, path: "sub/alpha.md" };
      const sub: FSEntry = { kind: "directory", path: "sub", name: "sub", children: [entry] };
      const held = Promise.withResolvers<string>();
      const started = vi.fn();
      let pause = false;
      let moved = false;
      invoke.mockImplementation(async (command, args) => {
        if (command === "read_dir") {
          if (args.path === other) return [{ ...sub, children: moved ? [entry] : [] }];
          if (!moved) return [alpha, beta];
          if (route === "move across roots") return [beta];
          return [route === "rename" ? entry : sub, beta];
        }
        if (command === "rename_file" || command === "move_path") moved = true;
        if (command === "read_file") {
          if (args.path === `${workspace}/alpha.md`) {
            if (!pause) return "Original Alpha";
            started();
            return held.promise;
          }
          return args.path === `${destinationRoot}/${entry.path}` ? "Updated Alpha" : "Beta";
        }
        if (command === "plugin:event|listen") return 1;
      });
      if (destinationRoot === other) await folder.openFolderPath(other);
      await folder.openFolderPath(workspace);
      const pane = paneManager.activePane();
      const run = async (action: void | Promise<unknown>) => {
        await vi.advanceTimersByTimeAsync(20);
        await action;
        flush();
      };
      await run(actions.openFile(alpha, workspace, true));
      const id = pane.tabs.activeTabId()!;
      const paths = [`${workspace}/alpha.md`];
      if (source === "selection") {
        await run(actions.openFile(beta, workspace, true));
        await loader.markDiskChanges(paths);
        flush();
      }
      pause = true;
      const loading = source === "selection"
        ? actions.activateTab(pane, id)
        : loader.handleWatcherChange(paths, "recursive");
      try {
        await vi.advanceTimersByTimeAsync(5);
        expect(started).toHaveBeenCalledOnce();
        expect(pane.html()).toBe(source === "selection" ? "" : "<p>Original Alpha</p>");
        if (route === "rename") await folder.handleRename(alpha, workspace, entry.name);
        else await folder.handleMove(alpha, "sub", workspace, destinationRoot);
        flush();
        expect(pane.selectedFile()?.path).toBe(entry.path);
        expect(pane.selectedRootId()).toBe(destinationRoot);
        await vi.advanceTimersByTimeAsync(20);
        expect(pane.html()).toBe("<p>Updated Alpha</p>");
        held.resolve("Late old response");
        await run(loading);
        expect(pane.html()).toBe("<p>Updated Alpha</p>");
        expect(pane.editorContent()).toBe("Updated Alpha");
        expect(pane.tabs.getActiveTab()?.diskChange).toBeUndefined();
        expect(pane.loading()).toBe(false);
        expect(calls("read_file").filter((args) => args.path === `${destinationRoot}/${entry.path}`)).toHaveLength(1);
      } finally {
        held.resolve("");
        await run(loading);
      }
    },
  );

  it("points the watcher at a renamed file's new path", async () => {
    const { folder, paneManager, watcher } = fixture();
    const renamed = { ...alpha, path: "renamed.md", name: "renamed.md" };
    let entries = [alpha, beta];
    invoke.mockImplementation(async (command) => {
      if (command === "read_dir") return entries;
      if (command === "rename_file") entries = [renamed, beta];
      if (command === "plugin:event|listen") return 1;
    });
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    openDocument(pane, alpha, "Alpha buffer");
    watcher.setTarget({ filePath: `${workspace}/alpha.md`, includePaths: [], rootPath: workspace });
    await watcher.start();
    flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls("watch_paths").at(-1)).toEqual({ paths: [`${workspace}/alpha.md`] });

    await folder.handleRename(alpha, workspace, renamed.name);
    await vi.advanceTimersByTimeAsync(0);

    expect(pane.tabs.activeTabId()).toBe(`${workspace}::renamed.md`);
    expect(pane.selectedFile()).toEqual(renamed);
    expect(calls("watch_paths").at(-1)).toEqual({ paths: [`${workspace}/renamed.md`] });
  });

  it("points the watcher at a moved file's new path", async () => {
    const { folder, paneManager, watcher } = fixture();
    const moved = { ...alpha, path: "sub/alpha.md" };
    const sub: FSEntry = { kind: "directory", path: "sub", name: "sub", children: [moved] };
    let entries = [alpha, beta];
    invoke.mockImplementation(async (command) => {
      if (command === "read_dir") return entries;
      if (command === "rename_file") entries = [sub, beta];
      if (command === "plugin:event|listen") return 1;
    });
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    openDocument(pane, alpha, "Alpha buffer");
    watcher.setTarget({ filePath: `${workspace}/alpha.md`, includePaths: [], rootPath: workspace });
    await watcher.start();
    flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls("watch_paths").at(-1)).toEqual({ paths: [`${workspace}/alpha.md`] });

    await folder.handleMove(alpha, "sub", workspace);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls("rename_file")).toEqual([
      { root: workspace, oldRelative: "alpha.md", newRelative: "sub/alpha.md" },
    ]);
    expect(pane.selectedFile()).toEqual(moved);
    expect(pane.tabs.getActiveTab()).toMatchObject({ filePath: "sub/alpha.md" });
    // The live buffer follows the tab; no reload happens on a rename.
    expect(pane.editorContent()).toBe("Alpha buffer");
    expect(calls("watch_paths").at(-1)).toEqual({ paths: [`${workspace}/sub/alpha.md`] });
  });

  it("reopens the tab and re-aims the watcher when the file moves to another workspace", async () => {
    const { folder, paneManager, watcher } = fixture();
    const other = "/other";
    const moved = { ...alpha, path: "sub/alpha.md" };
    const sub: FSEntry = { kind: "directory", path: "sub", name: "sub", children: [moved] };
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return args.path === other ? [sub] : [alpha, beta];
      if (command === "move_path") return undefined;
      if (command === "plugin:event|listen") return 1;
    });
    expect(await folder.openFolderPath(other)).toBe(true);
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    openDocument(pane, alpha, "Alpha buffer");
    watcher.setTarget({ filePath: `${workspace}/alpha.md`, includePaths: [], rootPath: workspace });
    await watcher.start();
    flush();
    await vi.advanceTimersByTimeAsync(0);

    await folder.handleMove(alpha, "sub", workspace, other);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls("move_path")).toEqual([{
      srcRoot: workspace, srcRelative: "alpha.md", dstRoot: other, dstRelative: "sub/alpha.md",
    }]);
    expect(pane.selectedRootId()).toBe(other);
    expect(pane.tabs.getActiveTab()).toMatchObject({
      filePath: "sub/alpha.md", rootId: other, needsLoad: false,
    });
    expect(pane.editorContent()).toBe("Alpha buffer");
    expect(calls("watch_paths").at(-1)).toEqual({ paths: [`${other}/sub/alpha.md`] });
  });

  it("a pending preview edit follows a file moved to another workspace", async () => {
    const { state, folder, paneManager } = fixture();
    const other = "/other";
    const moved = { ...alpha, path: "sub/alpha.md" };
    const sub: FSEntry = { kind: "directory", path: "sub", name: "sub", children: [moved] };
    let didMove = false;
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return args.path === other ? [sub] : didMove ? [beta] : [alpha, beta];
      if (command === "move_path") { didMove = true; return; }
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(other);
    await folder.openFolderPath(workspace);
    const pane = paneManager.activePane();
    openDocument(pane, alpha, "Alpha saved");
    state.debouncedConvert("Alpha typed before the move", "alpha.md", async () => null);
    flush();
    await folder.handleMove(alpha, "sub", workspace, other);
    flush();
    expect(pane.tabs.getActiveTab()).toMatchObject({ filePath: "sub/alpha.md", rootId: other });
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(0);
    expect(pane.html()).toBe("<p>Alpha typed before the move</p>");
  });

  it("repoints every descendant tab of a renamed folder in every pane and keeps the open file watched", async () => {
    const { folder, paneManager, watcher } = fixture();
    const guide: FSEntry = { kind: "file", name: "guide.md", path: "docs/guide.md" };
    const other: FSEntry = { kind: "file", name: "other.md", path: "docs/other.md" };
    const dir: FSEntry = { kind: "directory", path: "docs", name: "docs", children: [guide, other] };
    const newDir: FSEntry = {
      kind: "directory", path: "manual", name: "manual",
      children: [
        { ...guide, path: "manual/guide.md" },
        { ...other, path: "manual/other.md" },
      ],
    };
    let entries = [dir];
    invoke.mockImplementation(async (command) => {
      if (command === "read_dir") return entries;
      if (command === "rename_file") entries = [newDir];
      if (command === "plugin:event|listen") return 1;
    });
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const left = paneManager.activePane();
    openDocument(left, guide, "Guide buffer");
    const backgroundId = left.tabs.openTab(other, workspace, { background: true });
    flush();
    const right = paneManager.splitFromActive()!;
    flush();
    const rightGuideId = right.tabs.openTab(guide, workspace, { background: true });
    right.tabs.markTabNeedsLoad(rightGuideId);
    flush();
    paneManager.setActivePane(0);
    watcher.setTarget({ filePath: `${workspace}/docs/guide.md`, includePaths: [], rootPath: workspace });
    await watcher.start();
    flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls("watch_paths").at(-1)).toEqual({ paths: [`${workspace}/docs/guide.md`] });

    await folder.handleRename(dir, workspace, "manual");
    await vi.advanceTimersByTimeAsync(0);

    // The open file keeps its content; only its path (and the watcher) moves.
    expect(calls("read_file")).toEqual([]);
    expect(left.tabs.getActiveTab()).toMatchObject({ filePath: "manual/guide.md", needsLoad: false });
    expect(left.editorContent()).toBe("Guide buffer");
    expect(left.selectedFile()).toMatchObject({ path: "manual/guide.md" });
    expect(calls("watch_paths").at(-1)).toEqual({ paths: [`${workspace}/manual/guide.md`] });
    // Background tabs in both panes follow the folder, without a reload.
    expect(left.tabs.getTab(backgroundId)).toBeUndefined();
    expect(left.tabs.findTabByFile("manual/other.md", workspace)).toMatchObject({
      filePath: "manual/other.md", needsLoad: false,
    });
    expect(right.tabs.getTab(rightGuideId)).toBeUndefined();
    expect(right.tabs.findTabByFile("manual/guide.md", workspace)).toMatchObject({
      filePath: "manual/guide.md", needsLoad: true,
    });
  });
});

describe("identity of the saved active tab and of tabs with a suffixed id", () => {
  const key = "markdraw-tab-session-pane-0";
  const saved = (rootId: string, filePath: string, id = `${rootId}::${filePath}`) =>
    ({ id, rootId, filePath, fileName: filePath.split("/").at(-1)!, isPinned: true, editorMode: "split" as const });
  const delayedRoot = "/delayed";

  // The saved batch has a duplicate whose saved suffix (`#12`) differs from the
  // one the restore allocates; the second root is still reading.
  async function restoreDuplicateWithPendingRoot() {
    const { folder, state, paneManager, rootPaths } = fixture();
    const delayed = Promise.withResolvers<FSEntry[]>();
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return args.path === delayedRoot ? delayed.promise : [alpha, beta];
      if (command === "plugin:event|listen") return 1;
    });
    const a = saved(workspace, alpha.path);
    const oldDuplicate = saved(workspace, alpha.path, a.id + "#12");
    setTabSession({ tabs: [a, oldDuplicate], activeTabId: oldDuplicate.id }, key);
    setOpenRoots([workspace, delayedRoot].map((path) => ({ id: path, path })));
    const pane = paneManager.activePane();
    const restore = createSessionRestore(pane, (filePath, rootId) => state.findEntryByPath(filePath, rootId));
    const restoring = folder.restoreOpenRoots();
    await vi.advanceTimersByTimeAsync(0);
    restore.rootsChanged(rootPaths().keys());
    flush();
    const [, duplicate] = pane.tabs.tabs();
    expect(duplicate!.id).not.toBe(oldDuplicate.id);
    const finish = async () => {
      delayed.resolve([]);
      await restoring;
    };
    return { folder, pane, restore, duplicate: duplicate!, oldDuplicate, finish };
  }

  it("writes the id the restore allocated for the saved active tab while a later root is pending", async () => {
    const { folder, restore, duplicate, finish } = await restoreDuplicateWithPendingRoot();
    try {
      await vi.advanceTimersByTimeAsync(501);
      const persisted = JSON.parse(localStorage.getItem(key)!);
      await finish();
      expect(persisted.activeTabId).toBe(duplicate.id);
      expect(restore.settle(folder.savedRootIds())).toBe(duplicate.id);
    } finally {
      await finish();
    }
  });

  it("keeps the saved active tab on disk through a move made while a later root is pending", async () => {
    const { pane, duplicate, finish } = await restoreDuplicateWithPendingRoot();
    try {
      const moved = pane.tabs.updateTabFile(duplicate.id, "moved.md", "moved.md");
      flush();
      await vi.advanceTimersByTimeAsync(501);
      const persisted = JSON.parse(localStorage.getItem(key)!);
      expect(persisted.activeTabId).toBe(moved!.id);
    } finally {
      await finish();
    }
  });

  it("control: a saved active tab without a suffix change is written as saved", async () => {
    const { folder, state, paneManager, rootPaths } = fixture();
    const delayed = Promise.withResolvers<FSEntry[]>();
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") return args.path === delayedRoot ? delayed.promise : [alpha, beta];
      if (command === "plugin:event|listen") return 1;
    });
    const a = saved(workspace, alpha.path);
    setTabSession({ tabs: [a, saved(workspace, beta.path)], activeTabId: a.id }, key);
    setOpenRoots([workspace, delayedRoot].map((path) => ({ id: path, path })));
    const pane = paneManager.activePane();
    const restore = createSessionRestore(pane, (filePath, rootId) => state.findEntryByPath(filePath, rootId));
    const restoring = folder.restoreOpenRoots();
    try {
      await vi.advanceTimersByTimeAsync(0);
      restore.rootsChanged(rootPaths().keys());
      flush();
      await vi.advanceTimersByTimeAsync(501);
      expect(JSON.parse(localStorage.getItem(key)!).activeTabId).toBe(a.id);
    } finally {
      delayed.resolve([]);
      await restoring;
    }
  });

  const other = "/other";
  const html: FSEntry = { kind: "file", path: "page.html", name: "page.html" };
  const moved = { ...html, path: "sub/page.html" };
  const sub: FSEntry = { kind: "directory", path: "sub", name: "sub", children: [] };

  async function setupNavigation(movedOnDisk = false) {
    const { folder, state, paneManager, actions, rootPaths } = fixture();
    const savedOnDisk = "<h1 id='anchor'>on disk</h1>";
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_dir") {
        return args.path === other
          ? [{ ...sub, children: movedOnDisk ? [moved] : [] }]
          : movedOnDisk ? [beta] : [html, beta];
      }
      if (command === "move_path") movedOnDisk = true;
      if (command === "read_file") return savedOnDisk;
      if (command === "plugin:event|listen") return 1;
    });
    await folder.openFolderPath(other);
    await folder.openFolderPath(workspace);
    const navigation = createNavigation({
      state, rootPaths,
      loadFileContent: async () => {},
      tabStore: () => paneManager.activePane().tabs,
      onActivateTab: (tabId) => { void actions.activateTab(paneManager.activePane(), tabId); },
      onOpenHistoryTab: (entry, rootId) => { void actions.openFile(entry, rootId, true, false); },
      onOpenFile: actions.openFile,
    });
    const settle = async (promise: Promise<unknown> | void) => {
      await vi.advanceTimersByTimeAsync(5);
      await promise;
      flush();
      await vi.advanceTimersByTimeAsync(5);
    };
    const navigate = async (path: string, fragment: string) => settle(navigation.handleNavigate(path, fragment));
    return { folder, state, paneManager, navigation, navigate, settle, savedOnDisk };
  }

  // A background tab with edits moved onto a path whose stale tab is then
  // closed: the moved tab is the only tab of that file and its id has a suffix.
  async function onlySuffixedTabAtTarget() {
    const setup = await setupNavigation();
    const { folder, state, paneManager, savedOnDisk } = setup;
    const pane = paneManager.activePane();
    const stale = pane.tabs.openTab(moved, other, { background: true });
    const incoming = pane.tabs.openTab(html, workspace, { background: true });
    pane.tabs.updateTabContent(incoming, {
      editorContent: "<h1 id='anchor'>unsaved edit</h1>",
      savedContent: savedOnDisk,
    });
    pane.tabs.openTab(beta, workspace);
    pane.setSelectedFile(beta);
    pane.setSelectedRootId(workspace);
    flush();
    await folder.handleMove(html, "sub", workspace, other);
    flush();
    const movedTab = pane.tabs.tabs().find((tab) => tab.filePath === moved.path && tab.id !== stale)!;
    expect(movedTab.id).toMatch(/#\d+$/);
    pane.tabs.closeTab(stale);
    flush();
    expect(pane.tabs.tabs().filter((tab) => tab.filePath === moved.path)).toHaveLength(1);
    return { ...setup, pane, movedTab, state };
  }

  const tabsAtTarget = (pane: PaneStore) =>
    pane.tabs.tabs().filter((tab) => tab.filePath === moved.path).map((tab) => tab.id);

  it("follows an HTML link into the only open tab of the path when its id has a suffix", async () => {
    const { state, pane, movedTab, navigate } = await onlySuffixedTabAtTarget();

    await navigate(moved.path, "anchor");

    expect(state.pendingHtmlNavigation()[pane.paneId]?.fragment).toBe("anchor");
    expect({ active: pane.tabs.activeTabId(), tabs: tabsAtTarget(pane), editor: pane.editorContent() })
      .toEqual({ active: movedTab.id, tabs: [movedTab.id], editor: movedTab.editorContent });
  });

  it("goes back and forward to the only open tab of the path when its id has a suffix", async () => {
    const { pane, movedTab, navigation, navigate, settle } = await onlySuffixedTabAtTarget();
    await navigate(moved.path, "anchor");
    await navigate("beta.md", "");
    expect(pane.tabs.getActiveTab()?.filePath).toBe("beta.md");

    navigation.handleGoBack();
    await settle();

    expect({ active: pane.tabs.activeTabId(), tabs: tabsAtTarget(pane), editor: pane.editorContent() })
      .toEqual({ active: movedTab.id, tabs: [movedTab.id], editor: movedTab.editorContent });
    navigation.handleGoForward();
    await settle();
    expect(pane.tabs.getActiveTab()?.filePath).toBe("beta.md");
    navigation.handleGoBack();
    await settle();
    expect({ active: pane.tabs.activeTabId(), tabs: tabsAtTarget(pane) })
      .toEqual({ active: movedTab.id, tabs: [movedTab.id] });
  });

  it("control: a link to a path whose tab has the canonical id still reuses that tab", async () => {
    const { paneManager, navigate, savedOnDisk } = await setupNavigation(true);
    const pane = paneManager.activePane();
    const target = pane.tabs.openTab(moved, other, { background: true });
    pane.tabs.updateTabContent(target, { editorContent: "edit", savedContent: savedOnDisk });
    pane.tabs.openTab(beta, workspace);
    flush();
    await navigate(moved.path, "anchor");
    expect({ active: pane.tabs.activeTabId(), tabs: tabsAtTarget(pane), editor: pane.editorContent() })
      .toEqual({ active: target, tabs: [target], editor: "edit" });
  });
});
