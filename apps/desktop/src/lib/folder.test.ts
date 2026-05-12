// DJA-41 — pin per-doc target before await across folder handlers.
//
// Round 4 Lesson 6 (wiki/testing/strategies.md) established that
// any handler doing `await something(); state.setX(...)` for
// per-document fields is racey: the AppState proxy resolves
// `paneManager.activePane()` at write time, so if the user flips
// panes between the await and the set, the write lands on the wrong
// pane. Lesson 5 fixed `file-loader.ts`; this suite audits +
// regression-locks the same fix on `folder.ts` handlers.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { installLocalStorageMock } from "@asciimark/core/test-utils.ts";
import { createPaneManager } from "@asciimark/ui/composables/create-pane-manager.ts";
import type { AppState } from "@asciimark/ui/composables/create-app-state.ts";

installLocalStorageMock();

// `folder.ts` imports `./fs.ts` (which talks to Tauri commands) and
// the Tauri clipboard plugin — neither is available in bun. We stub
// them with controllable promises so the tests can park the await
// and flip panes between request and response.
let resolveWrite: (() => void) | undefined;
let resolveRename: (() => void) | undefined;
let resolveTrash: (() => void) | undefined;
let resolveReadTree: ((entries: unknown[]) => void) | undefined;
let writeFileCalls: Array<{ path: string; content: string }> = [];
let renameFileCalls: Array<{ root: string; from: string; to: string }> = [];
let trashCalls: Array<{ root: string; rel: string }> = [];

mock.module("./fs.ts", () => ({
  writeFile: (path: string, content: string) => {
    writeFileCalls.push({ path, content });
    return new Promise<void>((resolve) => {
      resolveWrite = () => resolve();
    });
  },
  renameFile: (root: string, from: string, to: string) => {
    renameFileCalls.push({ root, from, to });
    return new Promise<void>((resolve) => {
      resolveRename = () => resolve();
    });
  },
  trashPath: (root: string, rel: string) => {
    trashCalls.push({ root, rel });
    return new Promise<void>((resolve) => {
      resolveTrash = () => resolve();
    });
  },
  readTree: () =>
    new Promise<unknown[]>((resolve) => {
      resolveReadTree = (entries) => resolve(entries);
    }),
  openDirectory: async () => null,
}));

mock.module("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: async () => {},
}));
// Same defensive mocks the file-loader.test.ts ships — the
// plugin-clipboard-manager and other Tauri plugins pull in
// `@tauri-apps/api/core` which exports `Resource`. Stubbing core
// + event keeps the import graph happy in bun.
mock.module("@tauri-apps/api/core", () => ({
  invoke: async () => undefined,
  Resource: class {},
  // Channel — see updater-drain.test.ts: plugin-updater statically
  // imports it from this module and the mock must expose it for
  // cross-suite ordering to stay deterministic.
  Channel: class {},
}));
mock.module("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));
// `plugin-updater` extends Resource from `api/core`; the file-loader
// suite (which runs in the same test process) replaces `api/core`
// with a Resource-less stub. Provide a full stub for plugin-updater
// here so any transitive import resolves cleanly regardless of run
// order.
mock.module("@tauri-apps/plugin-updater", () => ({
  check: async () => null,
  Update: class {},
}));
mock.module("@tauri-apps/plugin-process", () => ({
  relaunch: async () => {},
}));
mock.module("@tauri-apps/plugin-dialog", () => ({
  message: async () => {},
}));

import { createFolder } from "./folder.ts";

function makeState(paneManager: ReturnType<typeof createPaneManager>): AppState {
  // The proxies read `paneManager.activePane()` on each access. Real
  // AppState builds the same shape; tests only need the slots
  // `folder.ts` actually touches.
  return {
    paneManager,
    get selectedRootId() { return paneManager.activePane().selectedRootId; },
    get setSelectedRootId() { return paneManager.activePane().setSelectedRootId; },
    get selectedFile() { return paneManager.activePane().selectedFile; },
    get setSelectedFile() { return paneManager.activePane().setSelectedFile; },
    get setHtml() { return paneManager.activePane().setHtml; },
    get setFrontmatter() { return paneManager.activePane().setFrontmatter; },
    get setEditorContent() { return paneManager.activePane().setEditorContent; },
    get savedContent() { return paneManager.activePane().savedContent; },
    get setSavedContent() { return paneManager.activePane().setSavedContent; },
    get editorContent() { return paneManager.activePane().editorContent; },
    get setLoading() { return paneManager.activePane().setLoading; },
    setSidebarVisible: () => {},
    setShowAllDirs: () => {},
    setShowAllFiles: () => {},
    showHiddenEntries: () => false,
    pushRecentFolder: () => {},
    addRoot: () => {},
    updateRootEntries: () => {},
    findEntryByPath: () => null,
  } as unknown as AppState;
}

const watcher = { setTarget: () => {}, start: async () => {}, stop: async () => {} } as never;

function setupTwoPanes() {
  const paneManager = createPaneManager();
  paneManager.splitFromActive();
  paneManager.setActivePane(0);
  return paneManager;
}

beforeEach(() => {
  resolveWrite = undefined;
  resolveRename = undefined;
  resolveTrash = undefined;
  resolveReadTree = undefined;
  writeFileCalls = [];
  renameFileCalls = [];
  trashCalls = [];
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("createFolder.handleEditorSave — pin per-doc target before await (DJA-41)", () => {
  it("writes savedContent to the pane that originated the save, NOT the pane active when writeFile resolves", async () => {
    // Mutation captured: reverting `targetPane.setSavedContent(content)`
    // back to `state.setSavedContent(content)` would surface here —
    // pane 1 would receive the dirty mark clear while pane 0 stays
    // dirty even after persisting.
    const paneManager = setupTwoPanes();
    const pane0 = paneManager.panes()[0]!;
    const pane1 = paneManager.panes()[1]!;
    pane0.setSelectedRootId("root1");
    pane0.setSelectedFile({ name: "a.md", path: "a.md", kind: "file" });
    pane0.setEditorContent("v2");
    pane0.setSavedContent("v1");
    pane1.setSelectedRootId("root1");
    pane1.setSelectedFile({ name: "b.md", path: "b.md", kind: "file" });
    pane1.setEditorContent("OTHER");
    pane1.setSavedContent("OTHER");

    const state = makeState(paneManager);
    const folder = createFolder({
      rootPaths: () => new Map([["root1", "/work/root1"]]),
      setRootPaths: () => {},
      state,
      watcher,
    });
    const savePromise = folder.handleEditorSave();
    // Flip to pane 1 BEFORE the write resolves.
    paneManager.setActivePane(1);
    resolveWrite!();
    await savePromise;

    expect(writeFileCalls).toEqual([{ path: "/work/root1/a.md", content: "v2" }]);
    expect(pane0.savedContent()).toBe("v2"); // dirty mark cleared on the right pane
    expect(pane1.savedContent()).toBe("OTHER"); // and NOT on the wrong pane
  });

  it("noop when no file is selected — does not call writeFile", async () => {
    const paneManager = createPaneManager();
    const state = makeState(paneManager);
    const folder = createFolder({
      rootPaths: () => new Map([["root1", "/work/root1"]]),
      setRootPaths: () => {},
      state,
      watcher,
    });
    await folder.handleEditorSave();
    expect(writeFileCalls).toEqual([]);
  });
});

describe("createFolder.refreshRoot — pin per-doc target before await (DJA-41)", () => {
  it("clears the originating pane's selection when the open file vanished, NOT the pane active when readTree resolves", async () => {
    // Mutation captured: replacing `targetPane.setSelectedFile(null)`
    // with `state.setSelectedFile(null)` would clear pane 1 here
    // (because the assertion below flips active to pane 1 mid-await)
    // while leaving the deleted file's pane still pointing at the
    // ghost entry.
    const paneManager = setupTwoPanes();
    const pane0 = paneManager.panes()[0]!;
    const pane1 = paneManager.panes()[1]!;
    pane0.setSelectedRootId("root1");
    pane0.setSelectedFile({ name: "gone.md", path: "gone.md", kind: "file" });
    pane1.setSelectedRootId("root1");
    pane1.setSelectedFile({ name: "kept.md", path: "kept.md", kind: "file" });

    const state = makeState(paneManager);
    // findEntryByPath returns null for the deleted entry only (acts
    // like the file is gone from the refreshed tree).
    (state as unknown as { findEntryByPath: (p: string) => unknown }).findEntryByPath = (path: string) =>
      path === "kept.md" ? { name: "kept.md", path: "kept.md", kind: "file" } : null;

    const folder = createFolder({
      rootPaths: () => new Map([["root1", "/work/root1"]]),
      setRootPaths: () => {},
      state,
      watcher,
    });
    const refreshPromise = folder.refreshRoot("root1");
    // Flip BEFORE readTree resolves.
    paneManager.setActivePane(1);
    resolveReadTree!([]);
    await refreshPromise;

    expect(pane0.selectedFile()).toBeNull(); // gone — cleared on origin pane
    expect(pane1.selectedFile()?.path).toBe("kept.md"); // intact
  });
});
