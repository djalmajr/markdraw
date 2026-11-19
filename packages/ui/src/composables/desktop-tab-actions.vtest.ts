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

function fixture(
  confirmDirtyTab = vi.fn<Parameters<typeof createTabActions>[0]["confirmDirtyTab"]>(async () => "cancel"),
  notifyCloseConflict = vi.fn<(name: string) => void>(),
) {
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
      state, rootPaths, watcher, loadTabContent: loader.loadTabContent,
      loadFileContent: loader.loadFileContent, confirmDirtyTab, notifyCloseConflict,
    });
    const folder: ReturnType<typeof createFolder> = createFolder({
      state, rootPaths, setRootPaths, watcher,
      beforeRootClose: actions.prepareRootClose,
      onRootClosed: actions.closeRootTabs,
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
    const { folder, paneManager, rootPaths, watcher } = fixture();
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    openDocument(pane, alpha, "Alpha buffer");
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
    expect(pane.tabs.tabs()).toEqual([]);
    expect(pane.selectedFile()).toBeNull();
  });
});

describe("activation of an unloaded tab", () => {
  it.each(["close", "close others", "close right", "move", "reopen", "activate"])(
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
      const alphaId = source.tabs.openTab(alpha, workspace, { background: true });
      source.tabs.markTabNeedsLoad(alphaId);
      flush();
      const betaId = openDocument(source, beta, "Beta buffer");

      if (route === "close") actions.closeTabs(source, [betaId]);
      if (route === "close others") source.tabs.closeOtherTabs(alphaId);
      if (route === "close right") source.tabs.closeTabsToRight(alphaId);
      if (route === "move") actions.moveTab(alphaId, 0);
      if (route === "reopen") {
        actions.closeTabs(source, [alphaId]);
        flush();
        expect(source.tabs.reopenClosedTab()?.id).toBe(alphaId);
      }
      if (route === "activate") void actions.activateTab(source, alphaId);
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

describe("closing a root with an inactive dirty pane", () => {
  it.each([
    { decision: "confirm", failSave: false, closes: true },
    { decision: "deny", failSave: false, closes: true },
    { decision: "cancel", failSave: false, closes: false },
    { decision: "confirm", failSave: true, closes: false },
  ] as const)("handles $decision with failSave=$failSave", async ({ decision, failSave, closes }) => {
    const answer = Promise.withResolvers<"confirm" | "deny" | "cancel">();
    const confirmDirtyTab = vi.fn(() => answer.promise);
    const { folder, paneManager, rootPaths } = fixture(confirmDirtyTab);
    if (failSave) {
      vi.spyOn(console, "error").mockImplementation(() => {});
      invoke.mockImplementation(async (command) => {
        if (command === "read_dir") return [alpha, beta];
        if (command === "write_file") throw new Error("Disk write failed");
      });
    }
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const left = paneManager.activePane();
    const id = openDocument(left, alpha, "Disk version");
    // An inactive pane can have a live edit newer than the tab's snapshot.
    left.setEditorContent("Unsaved edit");
    flush();
    const right = paneManager.splitFromActive()!;
    flush();
    const rightId = openDocument(right, beta, "Beta buffer");

    const close = folder.handleCloseRoot(workspace);
    await vi.advanceTimersByTimeAsync(1000);
    expect(confirmDirtyTab).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id }));
    expect(calls("write_file")).toEqual([]);
    const registered = [{ roots: [] }, { roots: [{ path: workspace, name: "workspace" }] }];
    expect(calls("mcp_set_roots")).toEqual(registered);
    expect(rootPaths().has(workspace)).toBe(true);
    answer.resolve(decision);
    await close;
    flush();

    expect(calls("write_file")).toEqual(decision === "confirm"
      ? [{ path: `${workspace}/alpha.md`, content: "Unsaved edit" }]
      : []);
    expect(calls("mcp_set_roots")).toEqual(closes ? [...registered, { roots: [] }] : registered);
    expect(rootPaths().has(workspace)).toBe(!closes);
    if (closes) {
      expect(left.tabs.tabs()).toEqual([]);
      expect(right.tabs.tabs()).toEqual([]);
      if (decision === "confirm") {
        const commands = invoke.mock.calls.map(([name]) => name);
        expect(commands.indexOf("write_file")).toBeLessThan(commands.lastIndexOf("mcp_set_roots"));
      }
    } else {
      expect(left.tabs.activeTabId()).toBe(id);
      expect(left.editorContent()).toBe("Unsaved edit");
      expect(left.savedContent()).toBe("Disk version");
      expect(right.tabs.activeTabId()).toBe(rightId);
    }
  });
});

describe("closing a root with dirty copies of one file", () => {
  it.each([
    { rightContent: "Original + right", conflict: true },
    { rightContent: "Original + left", conflict: false },
  ])("handles repeated destinations with conflict=$conflict", async ({ rightContent, conflict }) => {
    const confirmDirtyTab = vi.fn(async () => "confirm" as const);
    const notifyCloseConflict = vi.fn();
    const { folder, paneManager, rootPaths } = fixture(confirmDirtyTab, notifyCloseConflict);
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const left = paneManager.activePane();
    const leftId = openDocument(left, alpha, "Original");
    left.setEditorContent("Original + left");
    flush();
    const right = paneManager.splitFromActive()!;
    flush();
    const rightId = openDocument(right, alpha, "Original");
    right.setEditorContent(rightContent);
    flush();

    await folder.handleCloseRoot(workspace);
    flush();

    expect(calls("write_file")).toEqual(conflict
      ? []
      : [{ path: `${workspace}/alpha.md`, content: "Original + left" }]);
    const opened = [{ roots: [] }, { roots: [{ path: workspace, name: "workspace" }] }];
    expect(calls("mcp_set_roots")).toEqual(conflict ? opened : [...opened, { roots: [] }]);
    if (conflict) {
      expect(notifyCloseConflict).toHaveBeenCalledExactlyOnceWith("alpha.md");
      expect(confirmDirtyTab).not.toHaveBeenCalled();
      expect(rootPaths().has(workspace)).toBe(true);
      expect(left.tabs.activeTabId()).toBe(leftId);
      expect(right.tabs.activeTabId()).toBe(rightId);
      expect(left.editorContent()).toBe("Original + left");
      expect(right.editorContent()).toBe(rightContent);
    } else {
      expect(notifyCloseConflict).not.toHaveBeenCalled();
      expect(confirmDirtyTab).toHaveBeenCalledTimes(2);
      expect(rootPaths().has(workspace)).toBe(false);
      expect(left.tabs.tabs()).toEqual([]);
      expect(right.tabs.tabs()).toEqual([]);
    }
  });
});

function holdMcpClose(otherHandlers?: (command: string, args: Record<string, unknown>) => unknown) {
  const response = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  const defaultImplementation = invoke.getMockImplementation();
  let caught = false;
  invoke.mockImplementation(async (command, args) => {
    if (!caught && command === "mcp_set_roots" && Array.isArray(args.roots)
      && !args.roots.some((root) => root.path === workspace)) {
      caught = true;
      received.resolve();
      return response.promise;
    }
    if (otherHandlers) return otherHandlers(command, args);
    return defaultImplementation?.(command, args);
  });
  return { response, received };
}

function mountEditor(state: AppState, pane: PaneStore) {
  const { container } = render(() => createComponent(PaneView, { pane, state, paneIndex: 0, isActive: true }));
  const element = container.querySelector<HTMLElement>(".cm-editor");
  expect(element).not.toBeNull();
  return EditorView.findFromDOM(element!)!;
}

describe("workspace close while MCP responds", () => {
  it("keeps a first read that completes before MCP rejects the close", async () => {
    const { folder, paneManager, rootPaths, state, actions } = fixture();
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const read = Promise.withResolvers<string>();
    const { response, received } = holdMcpClose((command) => {
      if (command === "read_file") return read.promise;
      if (command === "plugin:event|listen") return 1;
    });
    const opening = actions.openFile(alpha, workspace);
    const pane = paneManager.activePane();
    pane.setEditorMode("edit");
    flush();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls("read_file")).toEqual([{ path: `${workspace}/alpha.md` }]);
    expect(pane.tabs.getActiveTab()?.needsLoad).toBe(true);
    await folder.handleEditorSave();

    const close = folder.handleCloseRoot(workspace);
    try {
      await received.promise;
      read.resolve("Original file on disk");
      await vi.advanceTimersByTimeAsync(10);
      await opening;
      expect(pane.editorContent()).toBe("Original file on disk");
      expect(pane.tabs.getActiveTab()?.needsLoad).toBe(false);
      expect(calls("write_file")).toEqual([]);

      vi.spyOn(console, "warn").mockImplementation(() => {});
      response.reject(new Error("MCP rejected the workspace update"));
      await close;
      expect(rootPaths().has(workspace)).toBe(true);
      const editor = mountEditor(state, pane);
      expect(editor.state.doc.toString()).toBe("Original file on disk");
      editor.dispatch({ changes: { from: editor.state.doc.length, insert: " + later edit" } });
      flush();
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls("write_file")).toEqual([{
        path: `${workspace}/alpha.md`, content: "Original file on disk + later edit",
      }]);
    } finally {
      read.resolve("Original file on disk");
      response.resolve();
      await opening;
      await close;
    }
  });

  it("saves editing during the MCP wait before removing the tabs", async () => {
    const { folder, paneManager, state } = fixture();
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    const id = openDocument(pane, alpha, "Original");
    const editor = mountEditor(state, pane);
    const { response, received } = holdMcpClose();
    const close = folder.handleCloseRoot(workspace);
    try {
      await received.promise;
      editor.dispatch({ changes: { from: 8, insert: " + manual save" } });
      flush();
      await folder.handleEditorSave();
      expect(calls("write_file")).toEqual([{
        path: `${workspace}/alpha.md`, content: "Original + manual save",
      }]);

      editor.dispatch({ changes: { from: editor.state.doc.length, insert: " + during MCP" } });
      flush();
      expect(pane.tabs.activeTabId()).toBe(id);
      response.resolve();
      await close;
      flush();

      expect(calls("write_file")).toEqual([
        { path: `${workspace}/alpha.md`, content: "Original + manual save" },
        { path: `${workspace}/alpha.md`, content: "Original + manual save + during MCP" },
      ]);
      expect(pane.tabs.tabs()).toEqual([]);
    } finally {
      response.resolve();
      await close;
    }
  });

  it("keeps two conflicting edits and republishes the workspace after acknowledgement", async () => {
    const notifyCloseConflict = vi.fn();
    const { folder, paneManager, rootPaths } = fixture(undefined, notifyCloseConflict);
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const left = paneManager.activePane();
    const leftId = openDocument(left, alpha, "Original");
    const right = paneManager.splitFromActive()!;
    flush();
    const rightId = openDocument(right, alpha, "Original");

    const { response, received } = holdMcpClose();
    const close = folder.handleCloseRoot(workspace);
    try {
      await received.promise;
      left.setEditorContent("Original + left");
      right.setEditorContent("Original + right");
      flush();
      response.resolve();
      await close;
      flush();

      expect(calls("write_file")).toEqual([]);
      expect(notifyCloseConflict).toHaveBeenCalledExactlyOnceWith("alpha.md");
      const registered = { roots: [{ path: workspace, name: "workspace" }] };
      expect(calls("mcp_set_roots")).toEqual([{ roots: [] }, registered, { roots: [] }, registered]);
      expect(rootPaths().has(workspace)).toBe(true);
      expect(left.tabs.activeTabId()).toBe(leftId);
      expect(right.tabs.activeTabId()).toBe(rightId);
      expect(left.editorContent()).toBe("Original + left");
      expect(right.editorContent()).toBe("Original + right");
    } finally {
      response.resolve();
      await close;
    }
  });

  it.each([false, true])("saves changes made after Discard, with final write failure=%s", async (failWrite) => {
    const confirmDirtyTab = vi.fn(async () => "deny" as const);
    const { folder, paneManager, rootPaths } = fixture(confirmDirtyTab);
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    const id = openDocument(pane, alpha, "Original");
    pane.setEditorContent("Discarded version");
    flush();
    const { response, received } = holdMcpClose((command) => {
      if (command === "write_file" && failWrite) throw new Error("Disk write failed");
    });
    if (failWrite) vi.spyOn(console, "error").mockImplementation(() => {});
    const close = folder.handleCloseRoot(workspace);
    try {
      await received.promise;
      expect(confirmDirtyTab).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id }));
      expect(calls("write_file")).toEqual([]);
      pane.setEditorContent("Edit after Discard");
      flush();
      response.resolve();
      await close;
      flush();

      expect(calls("write_file")).toEqual([{
        path: `${workspace}/alpha.md`, content: "Edit after Discard",
      }]);
      expect(rootPaths().has(workspace)).toBe(failWrite);
      if (failWrite) {
        expect(pane.tabs.activeTabId()).toBe(id);
        expect(pane.editorContent()).toBe("Edit after Discard");
        expect(calls("mcp_set_roots").at(-1)).toEqual({ roots: [{ path: workspace, name: "workspace" }] });
      } else {
        expect(pane.tabs.tabs()).toEqual([]);
      }
    } finally {
      response.resolve();
      await close;
    }
  });

  it("never saves the current document to a different selected folder", async () => {
    const { folder, paneManager, state, rootPaths } = fixture();
    const other = "/other-workspace";
    expect(await folder.openFolderPath(other)).toBe(true);
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    const id = openDocument(pane, alpha, "Original");
    const editor = mountEditor(state, pane);
    const { response, received } = holdMcpClose();
    const close = folder.handleCloseRoot(workspace);
    try {
      await received.promise;
      expect(await folder.openFolderPath(other)).toBe(true);
      flush();
      expect(pane.selectedRootId()).toBe(other);
      expect(pane.tabs.activeTabId()).toBe(id);
      editor.dispatch({ changes: { from: 8, insert: " + belongs to Alpha" } });
      flush();
      await folder.handleEditorSave();
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls("write_file")).toEqual([]);
      response.resolve();
      await close;
      flush();

      expect(calls("write_file")).toEqual([{
        path: `${workspace}/alpha.md`, content: "Original + belongs to Alpha",
      }]);
      expect(rootPaths().has(other)).toBe(true);
      expect(pane.tabs.tabs()).toEqual([]);
    } finally {
      response.resolve();
      await close;
    }
  });

  it.each(["pending", "failed"])("closes a %s first read without writing an incomplete buffer", async (status) => {
    const { folder, actions, paneManager } = fixture();
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const read = Promise.withResolvers<string>();
    invoke.mockImplementation(async (command) => {
      if (command === "read_file") return read.promise;
      if (command === "plugin:event|listen") return 1;
    });
    const opening = actions.openFile(alpha, workspace);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(calls("read_file")).toEqual([{ path: `${workspace}/alpha.md` }]);
      if (status === "failed") {
        vi.spyOn(console, "error").mockImplementation(() => {});
        read.reject(new Error("Cannot read Alpha"));
        await opening;
      }
      const pane = paneManager.activePane();
      expect(pane.tabs.getActiveTab()?.needsLoad).toBe(true);
      await folder.handleCloseRoot(workspace);
      expect(pane.tabs.tabs()).toEqual([]);
      expect(calls("write_file")).toEqual([]);
    } finally {
      read.resolve("Original");
      await opening;
    }
  });

  it("serializes a manual save that races with a final sweep write", async () => {
    const { folder, paneManager } = fixture();
    expect(await folder.openFolderPath(workspace)).toBe(true);
    const pane = paneManager.activePane();
    openDocument(pane, alpha, "Original");

    const writeStarted = Promise.withResolvers<void>();
    const firstWrite = Promise.withResolvers<void>();
    const { response, received } = holdMcpClose((command, args) => {
      if (command === "write_file" && args.content === "First late version") {
        writeStarted.resolve();
        return firstWrite.promise;
      }
    });
    const close = folder.handleCloseRoot(workspace);
    let manualSave: Promise<void> | undefined;
    try {
      await received.promise;
      pane.setEditorContent("First late version");
      flush();
      response.resolve();
      await writeStarted.promise;

      pane.setEditorContent("Newer version");
      flush();
      manualSave = folder.handleEditorSave();
      expect(calls("write_file")).toEqual([{
        path: `${workspace}/alpha.md`, content: "First late version",
      }]);
      expect(pane.tabs.tabs()).toHaveLength(1);
      firstWrite.resolve();
      await manualSave;
      await close;

      expect(calls("write_file").at(-1)).toEqual({
        path: `${workspace}/alpha.md`, content: "Newer version",
      });
      expect(pane.tabs.tabs()).toEqual([]);
    } finally {
      response.resolve();
      firstWrite.resolve();
      await manualSave;
      await close;
    }
  });
});
