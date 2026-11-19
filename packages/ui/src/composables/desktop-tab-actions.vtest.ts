import { createComponent, createRoot, createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { EditorView } from "@codemirror/view";
import type { FSEntry } from "@markdraw/core/types.ts";
import { createFileAutosave } from "../../../../apps/desktop/src/lib/file-autosave.ts";
import { createFolder } from "../../../../apps/desktop/src/lib/folder.ts";
import { createFileLoader } from "../../../../apps/desktop/src/lib/file-loader.ts";
import { createTabActions } from "../../../../apps/desktop/src/lib/tab-actions.ts";
import { FileWatcher } from "../../../../apps/desktop/src/lib/watcher.ts";
import { createAppState, type AppState } from "./create-app-state.ts";
import { createPaneManager } from "./create-pane-manager.ts";
import type { PaneStore } from "./create-pane-store.ts";
import { PaneView } from "../components/pane-view.tsx";

vi.mock("../lib/dnd/index.ts", () => ({
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

function fixture() {
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
      convertMarkdown: async ({ fileContent }) => ({ html: `<p>${fileContent}</p>`, frontmatter: null, toc: null, meta: {} }),
    });
    const [rootPaths, setRootPaths] = createSignal(new Map<string, string>());
    const loader = createFileLoader({ state, rootPaths, watcher });
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
    return { state, paneManager, rootPaths, actions, folder, watcher };
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
