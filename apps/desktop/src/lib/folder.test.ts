// DJA-41 — pin per-doc target before await across folder handlers.
//
// Round 4 Lesson 6 (wiki/testing/strategies.md) established that
// any handler doing `await something(); state.setX(...)` for
// per-document fields is racey: the AppState proxy resolves
// `paneManager.activePane()` at write time, so if the user flips
// panes between the await and the set, the write lands on the wrong
// pane. Lesson 5 fixed `file-loader.ts`; this suite audits +
// regression-locks the same fix on `folder.ts` handlers.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { installLocalStorageMock } from "@markdraw/core/test-utils.ts";
import { createPaneManager } from "@markdraw/ui/composables/create-pane-manager.ts";
import type { AppState } from "@markdraw/ui/composables/create-app-state.ts";

installLocalStorageMock();

// `folder.ts` imports `./fs.ts` (which talks to Tauri commands) and
// the Tauri clipboard plugin — neither is available in bun. We stub
// them with controllable promises so the tests can park the await
// and flip panes between request and response.
let restoreMcpInvoke: (() => void) | undefined;
let mcpRootsCalls: Array<Array<{ path: string; name: string }>> = [];

let resolveWrite: (() => void) | undefined;
let resolveRename: (() => void) | undefined;
let resolveTrash: (() => void) | undefined;
let resolveReadTree: ((entries: unknown[]) => void) | undefined;
let rejectReadTree: ((error: unknown) => void) | undefined;
// Per-path override of the parked `readTree`: lets a test hold, fail or answer
// each root separately (restore reads several roots, some twice).
let readTreeFor: ((path: string) => Promise<unknown[]> | undefined) | undefined;
// What a read of the root path itself answers (`readFileContent(root)`): a
// directory that exists fails with "is a directory", one that is gone with
// not-found. Only the second confirms an absence.
let goneRoots = new Set<string>();
let rootQueries: string[] = [];
let writeFileCalls: Array<{ path: string; content: string }> = [];
let renameFileCalls: Array<{ root: string; from: string; to: string }> = [];
let trashCalls: Array<{ root: string; rel: string }> = [];
let copyCalls: Array<{ srcRoot: string; from: string; dstRoot: string; to: string }> = [];
let moveAcrossCalls: Array<{ srcRoot: string; srcRel: string; dstRoot: string; dstRel: string }> = [];

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
  readTree: (path: string) =>
    readTreeFor?.(path) ?? new Promise<unknown[]>((resolve, reject) => {
      resolveReadTree = (entries) => resolve(entries);
      rejectReadTree = (error) => reject(error);
    }),
  readFileContent: async (path: string) => {
    rootQueries.push(path);
    throw goneRoots.has(path) ? "No such file or directory (os error 2)" : "Is a directory (os error 21)";
  },
  openDirectory: async () => null,
  createFile: async () => {},
  createDir: async () => {},
  copyPath: async (srcRoot: string, from: string, dstRoot: string, to: string) => {
    copyCalls.push({ srcRoot, from, dstRoot, to });
  },
  movePath: async (srcRoot: string, srcRel: string, dstRoot: string, dstRel: string) => {
    moveAcrossCalls.push({ srcRoot, srcRel, dstRoot, dstRel });
  },
}));

mock.module("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: async () => {},
}));
let revealCalls: string[] = [];
mock.module("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: async (path: string) => {
    revealCalls.push(path);
  },
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
import * as tauriIpc from "./chaos-invoke.ts";

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
    respectGitignore: () => true,
    pushRecentFolder: () => {},
    addRoot: () => {},
    removeRoot: () => {},
    updateRootEntries: () => {},
    findEntryByPath: () => null,
  } as unknown as AppState;
}

const watcher = {
  setTarget: () => {},
  start: async () => {},
  stop: async () => {},
  destroy: async () => {},
} as never;

function setupTwoPanes() {
  const paneManager = createPaneManager();
  paneManager.splitFromActive();
  paneManager.setActivePane(0);
  return paneManager;
}

beforeEach(() => {
  mcpRootsCalls = [];
  resolveWrite = undefined;
  resolveRename = undefined;
  resolveTrash = undefined;
  resolveReadTree = undefined;
  rejectReadTree = undefined;
  readTreeFor = undefined;
  goneRoots = new Set();
  rootQueries = [];
  writeFileCalls = [];
  renameFileCalls = [];
  trashCalls = [];
  copyCalls = [];
  moveAcrossCalls = [];
  localStorage.clear();
});

afterEach(() => {
  restoreMcpInvoke?.();
  restoreMcpInvoke = undefined;
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

  it("saves to the active tab's own root even after the selected root moved to another folder", async () => {
    // Opening a folder selects it while the open tab stays where it was: the
    // save must follow the tab (root + path), never the selected root.
    // Mutation: building the path from `selectedRootId()` again writes the
    // tab's file inside `/work/second`.
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    const entry = { name: "a.md", path: "a.md", kind: "file" } as const;
    pane.tabs.openTab(entry, "first");
    pane.setSelectedFile(entry);
    pane.setSelectedRootId("second");
    pane.setEditorContent("edited");
    pane.setSavedContent("saved");
    const folder = createFolder({
      rootPaths: () => new Map([["first", "/work/first"], ["second", "/work/second"]]),
      setRootPaths: () => {},
      state: makeState(paneManager),
      watcher,
    });

    const saving = folder.handleEditorSave();
    resolveWrite!();
    await saving;

    expect(writeFileCalls).toEqual([{ path: "/work/first/a.md", content: "edited" }]);
    expect(pane.savedContent()).toBe("edited");
  });

  it("writes nothing when the pane's file is not the active tab's file", async () => {
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    pane.tabs.openTab({ name: "a.md", path: "a.md", kind: "file" }, "first");
    pane.setSelectedFile({ name: "renamed.md", path: "renamed.md", kind: "file" });
    pane.setSelectedRootId("first");
    pane.setEditorContent("edited");
    const folder = createFolder({
      rootPaths: () => new Map([["first", "/work/first"]]),
      setRootPaths: () => {},
      state: makeState(paneManager),
      watcher,
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    await folder.handleEditorSave();
    warnSpy.mockRestore();

    expect(writeFileCalls).toEqual([]);
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
    const folder = createFolder({
      rootPaths: () => new Map([["root1", "/work/root1"]]),
      setRootPaths: () => {},
      state,
      watcher,
    });
    const refreshPromise = folder.refreshRoot("root1");
    // Flip BEFORE readTree resolves.
    paneManager.setActivePane(1);
    resolveReadTree!([{ name: "kept.md", path: "kept.md", kind: "file" }]);
    await refreshPromise;

    expect(pane0.selectedFile()).toBeNull(); // gone — cleared on origin pane
    expect(pane1.selectedFile()?.path).toBe("kept.md"); // intact
  });
});

describe("createFolder.handleMove", () => {
  it("moves an entry by renaming it into the target directory, then refreshes", async () => {
    const paneManager = createPaneManager();
    const state = makeState(paneManager);
    const folder = createFolder({
      rootPaths: () => new Map([["root1", "/work/root1"]]),
      setRootPaths: () => {},
      state,
      watcher,
    });

    const movePromise = folder.handleMove(
      { name: "a.md", path: "a.md", kind: "file" },
      "sub",
      "root1",
    );
    resolveRename!();
    await Promise.resolve();
    resolveReadTree!([]);
    await movePromise;

    expect(renameFileCalls).toEqual([{ root: "/work/root1", from: "a.md", to: "sub/a.md" }]);
  });

  it("rewrites the open file's path when the moved file is the selection", async () => {
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    pane.setSelectedRootId("root1");
    pane.setSelectedFile({ name: "a.md", path: "a.md", kind: "file" });
    const state = makeState(paneManager);
    const folder = createFolder({
      rootPaths: () => new Map([["root1", "/work/root1"]]),
      setRootPaths: () => {},
      state,
      watcher,
    });

    const movePromise = folder.handleMove(
      { name: "a.md", path: "a.md", kind: "file" },
      "sub",
      "root1",
    );
    resolveRename!();
    await Promise.resolve();
    resolveReadTree!([{
      kind: "directory",
      name: "sub",
      path: "sub",
      children: [{ kind: "file", name: "a.md", path: "sub/a.md" }],
    }]);
    await movePromise;

    expect(pane.selectedFile()?.path).toBe("sub/a.md");
  });

  it("is a no-op when the target dir already holds the entry (no rename)", async () => {
    const paneManager = createPaneManager();
    const state = makeState(paneManager);
    const folder = createFolder({
      rootPaths: () => new Map([["root1", "/work/root1"]]),
      setRootPaths: () => {},
      state,
      watcher,
    });

    // a.md already lives at root → moving into "" yields the same path.
    await folder.handleMove({ name: "a.md", path: "a.md", kind: "file" }, "", "root1");
    expect(renameFileCalls).toEqual([]);
  });

  it("uses move_path (not rename) when moving across workspace roots", async () => {
    const paneManager = createPaneManager();
    const state = makeState(paneManager);
    const folder = createFolder({
      rootPaths: () => new Map([["root1", "/work/root1"], ["root2", "/work/root2"]]),
      setRootPaths: () => {},
      state,
      watcher,
    });

    const flush = async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    };
    const p = folder.handleMove({ name: "a.md", path: "a.md", kind: "file" }, "sub", "root1", "root2");
    await flush();
    resolveReadTree?.([]); // refreshRoot(root1)
    await flush();
    resolveReadTree?.([]); // refreshRoot(root2)
    await p;

    expect(moveAcrossCalls).toEqual([
      { srcRoot: "/work/root1", srcRel: "a.md", dstRoot: "/work/root2", dstRel: "sub/a.md" },
    ]);
    expect(renameFileCalls).toEqual([]); // not a within-root rename
  });

  it("refuses to move a folder into its own subtree", async () => {
    const paneManager = createPaneManager();
    const state = makeState(paneManager);
    const folder = createFolder({
      rootPaths: () => new Map([["root1", "/work/root1"]]),
      setRootPaths: () => {},
      state,
      watcher,
    });

    await expect(
      folder.handleMove({ name: "docs", path: "docs", kind: "directory" }, "docs/inner", "root1"),
    ).rejects.toThrow(/into itself/);
    expect(renameFileCalls).toEqual([]);
  });
});

describe("createFolder.handleCopy", () => {
  it("copies an entry into the target dir, keeping its name when free", async () => {
    const paneManager = createPaneManager();
    const state = makeState(paneManager); // findEntryByPath → null (no collisions)
    const folder = createFolder({
      rootPaths: () => new Map([["root1", "/work/root1"]]),
      setRootPaths: () => {},
      state,
      watcher,
    });

    const p = folder.handleCopy({ name: "a.md", path: "a.md", kind: "file" }, "sub", "root1");
    await Promise.resolve();
    await Promise.resolve();
    resolveReadTree!([]);
    const rel = await p;

    expect(copyCalls).toEqual([{ srcRoot: "/work/root1", from: "a.md", dstRoot: "/work/root1", to: "sub/a.md" }]);
    expect(rel).toBe("sub/a.md");
  });

  it("auto-numbers ' (1)' when copying into the entry's own parent (collision)", async () => {
    const paneManager = createPaneManager();
    const state = makeState(paneManager);
    // a.md already exists at the root; the bare name collides, "a (1).md" is free.
    (state as unknown as { findEntryByPath: (p: string) => unknown }).findEntryByPath = (path: string) =>
      path === "a.md" ? { name: "a.md", path: "a.md", kind: "file" } : null;
    const folder = createFolder({
      rootPaths: () => new Map([["root1", "/work/root1"]]),
      setRootPaths: () => {},
      state,
      watcher,
    });

    const p = folder.handleCopy({ name: "a.md", path: "a.md", kind: "file" }, "", "root1");
    await Promise.resolve();
    await Promise.resolve();
    resolveReadTree!([]);
    const rel = await p;

    expect(copyCalls).toEqual([{ srcRoot: "/work/root1", from: "a.md", dstRoot: "/work/root1", to: "a (1).md" }]);
    expect(rel).toBe("a (1).md");
  });

  it("refuses to copy a folder into its own subtree", async () => {
    const paneManager = createPaneManager();
    const state = makeState(paneManager);
    const folder = createFolder({
      rootPaths: () => new Map([["root1", "/work/root1"]]),
      setRootPaths: () => {},
      state,
      watcher,
    });

    await expect(
      folder.handleCopy({ name: "docs", path: "docs", kind: "directory" }, "docs/inner", "root1"),
    ).rejects.toThrow(/into itself/);
    expect(copyCalls).toEqual([]);
  });
});

describe("handleRevealInFileManager", () => {
  beforeEach(() => {
    revealCalls = [];
  });

  it("reveals the entry's absolute path (root joined with relative path)", async () => {
    // Mutation captured: building the path from `entry.path` alone (or
    // forgetting the root join) would reveal the wrong location — the
    // assertion pins the absolute path the OS file manager receives.
    const paneManager = createPaneManager();
    const state = makeState(paneManager);
    const folder = createFolder({
      rootPaths: () => new Map([["root1", "/work/root1"]]),
      setRootPaths: () => {},
      state,
      watcher,
    });

    await folder.handleRevealInFileManager(
      { name: "diagram.png", path: "assets/diagram.png", kind: "file" },
      "root1",
    );
    expect(revealCalls).toEqual(["/work/root1/assets/diagram.png"]);
  });

  it("reveals the root itself when the entry has an empty path", async () => {
    const paneManager = createPaneManager();
    const state = makeState(paneManager);
    const folder = createFolder({
      rootPaths: () => new Map([["root1", "/work/root1"]]),
      setRootPaths: () => {},
      state,
      watcher,
    });
    await folder.handleRevealInFileManager({ name: "root1", path: "", kind: "directory" }, "root1");
    expect(revealCalls).toEqual(["/work/root1"]);
  });

  it("is a no-op for an unknown root (no reveal call)", async () => {
    const paneManager = createPaneManager();
    const state = makeState(paneManager);
    const folder = createFolder({
      rootPaths: () => new Map([["root1", "/work/root1"]]),
      setRootPaths: () => {},
      state,
      watcher,
    });
    await folder.handleRevealInFileManager({ name: "x.md", path: "x.md", kind: "file" }, "ghost");
    expect(revealCalls).toEqual([]);
  });
});

describe("createFolder MCP workspace labels", () => {
  function setup() {
    const invokeSpy = spyOn(tauriIpc, "invoke").mockImplementation(async (command, args) => {
      if (command === "mcp_set_roots") {
        mcpRootsCalls.push((args as { roots: Array<{ path: string; name: string }> }).roots);
      }
      return undefined as never;
    });
    restoreMcpInvoke = () => invokeSpy.mockRestore();
    let roots = new Map<string, string>();
    const state = makeState(createPaneManager());
    const folder = createFolder({
      rootPaths: () => roots,
      setRootPaths: ((value: Map<string, string> | ((previous: Map<string, string>) => Map<string, string>)) => {
        roots = typeof value === "function" ? value(roots) : value;
        return roots;
      }),
      state,
      watcher,
    });
    return folder;
  }

  for (const path of ["/", "", "///", "\\\\", "/notes/\0"]) {
    it(`sends Root instead of an empty or separator-only label for ${JSON.stringify(path)}`, async () => {
      const folder = setup();
      const opening = folder.openFolderPath(path);
      resolveReadTree?.([]);
      expect(await opening).toBe(true);
      expect(mcpRootsCalls.at(-1)).toEqual([{ path: path.replace(/\\/g, "/"), name: "Root" }]);
    });
  }

  it("keeps duplicate Root labels as separate paths when opening / and a real Root folder", async () => {
    const folder = setup();
    const first = folder.openFolderPath("/");
    resolveReadTree?.([]);
    expect(await first).toBe(true);
    const second = folder.openFolderPath("/notes/Root");
    resolveReadTree?.([]);
    expect(await second).toBe(true);
    expect(mcpRootsCalls.at(-1)).toEqual([
      { path: "/", name: "Root" },
      { path: "/notes/Root", name: "Root" },
    ]);
  });

  it("preserves a normal folder label", async () => {
    const folder = setup();
    const opening = folder.openFolderPath("/notes/Plans");
    resolveReadTree?.([]);
    expect(await opening).toBe(true);
    expect(mcpRootsCalls.at(-1)).toEqual([{ path: "/notes/Plans", name: "Plans" }]);
  });
});

describe("open roots persistence and reload restore", () => {
  const OPEN_ROOTS_KEY = "markdraw-open-roots-v1";
  let restoreInvoke: (() => void) | undefined;
  let rejectMcpRoots = false;
  // Reject only the snapshots that contain this path (a registry refusing one root).
  let rejectMcpPath: string | undefined;

  // Pin the IPC the root snapshot goes through: bun module mocks are
  // process-wide, so another suite may have replaced `@tauri-apps/api/core`
  // with a stub that rejects. The root list is about storage, not IPC.
  beforeEach(() => {
    rejectMcpRoots = false;
    rejectMcpPath = undefined;
    const invokeSpy = spyOn(tauriIpc, "invoke").mockImplementation(async (command, args) => {
      if (command === "mcp_set_roots") {
        if (rejectMcpRoots) throw new Error("registry unavailable");
        if ((args as { roots: Array<{ path: string }> }).roots.some(({ path }) => path === rejectMcpPath)) {
          throw new Error("registry refused one root");
        }
        mcpRootsCalls.push((args as { roots: Array<{ path: string; name: string }> }).roots);
      }
      return undefined as never;
    });
    restoreInvoke = () => invokeSpy.mockRestore();
  });

  afterEach(() => {
    restoreInvoke?.();
    restoreInvoke = undefined;
  });

  function setup() {
    let roots = new Map<string, string>();
    const state = makeState(createPaneManager());
    const folder = createFolder({
      rootPaths: () => roots,
      setRootPaths: ((value: Map<string, string> | ((previous: Map<string, string>) => Map<string, string>)) => {
        roots = typeof value === "function" ? value(roots) : value;
        return roots;
      }),
      state,
      watcher,
    });
    return { folder, roots: () => roots };
  }

  async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  it("persists every open root as { id, path } under markdraw-open-roots-v1", async () => {
    const { folder } = setup();

    const first = folder.openFolderPath("/notes");
    resolveReadTree!([]);
    expect(await first).toBe(true);
    expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_KEY)!)).toEqual([
      { id: "/notes", path: "/notes" },
    ]);

    const second = folder.openFolderPath("/plans");
    resolveReadTree!([]);
    expect(await second).toBe(true);
    expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_KEY)!)).toEqual([
      { id: "/notes", path: "/notes" },
      { id: "/plans", path: "/plans" },
    ]);
  });

  it("drops a closed root from the persisted list", async () => {
    const { folder } = setup();
    const opening = folder.openFolderPath("/notes");
    resolveReadTree!([]);
    await opening;

    await folder.handleCloseRoot("/notes");
    // An empty inventory ("nothing open") is written, not removed: it is not a missing key.
    expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_KEY)!)).toEqual([]);
  });

  it("reopens the persisted roots in order", async () => {
    localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([
      { id: "/notes", path: "/notes" },
      { id: "/plans", path: "/plans" },
    ]));
    const { folder, roots } = setup();

    const restoring = folder.restoreOpenRoots();
    resolveReadTree!([{ kind: "file", name: "a.md", path: "a.md" }]);
    await settle();
    resolveReadTree!([{ kind: "file", name: "b.md", path: "b.md" }]);

    expect(await restoring).toEqual(["/notes", "/plans"]);
    expect(Array.from(roots().keys())).toEqual(["/notes", "/plans"]);
    expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_KEY)!)).toEqual([
      { id: "/notes", path: "/notes" },
      { id: "/plans", path: "/plans" },
    ]);
  });

  it("drops a root deleted between sessions and keeps the rest", async () => {
    localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([
      { id: "/notes", path: "/notes" },
      { id: "/gone", path: "/gone" },
      { id: "/plans", path: "/plans" },
    ]));
    const { folder, roots } = setup();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    goneRoots.add("/gone");
    const restoring = folder.restoreOpenRoots();
    resolveReadTree!([]); // /notes
    await settle();
    // The root's own path answering not-found is what confirms the absence.
    rejectReadTree!(new Error("ENOENT: no such directory")); // /gone
    await settle();
    resolveReadTree!([]); // /plans

    expect(await restoring).toEqual(["/notes", "/plans"]);
    expect(Array.from(roots().keys())).toEqual(["/notes", "/plans"]);
    expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_KEY)!)).toEqual([
      { id: "/notes", path: "/notes" },
      { id: "/plans", path: "/plans" },
    ]);
    expect(rootQueries).toEqual(["/gone"]);
    // A folder that vanished between sessions is expected, not an error to report.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("keeps a root the MCP registry refused so the next start retries it", async () => {
    localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([{ id: "/notes", path: "/notes" }]));
    rejectMcpRoots = true;
    const { folder, roots } = setup();

    const restoring = folder.restoreOpenRoots();
    resolveReadTree!([]);

    expect(await restoring).toEqual([]);
    expect(roots().size).toBe(0);
    expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_KEY)!)).toEqual([
      { id: "/notes", path: "/notes" },
    ]);
  });

  it("keeps a root after a permission or I/O error, and only a confirmed absence drops it", async () => {
    localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([
      { id: "/locked", path: "/locked" },
      { id: "/flaky", path: "/flaky" },
      { id: "/gone", path: "/gone" },
    ]));
    const { folder, roots } = setup();
    const reads: Record<string, number> = {};
    readTreeFor = async (path) => {
      reads[path] = (reads[path] ?? 0) + 1;
      if (path === "/locked") throw "Permission denied (os error 13)";
      // A subfolder vanishing mid-walk reads like the root vanishing once.
      if (path === "/flaky" && reads[path] === 1) throw "No such file or directory (os error 2)";
      if (path === "/gone") throw "No such file or directory (os error 2)";
      return [];
    };
    goneRoots.add("/gone");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    expect(await folder.restoreOpenRoots()).toEqual(["/flaky"]);
    warnSpy.mockRestore();

    // /gone is confirmed by asking the root itself, not by a second walk.
    expect(reads).toEqual({ "/locked": 1, "/flaky": 2, "/gone": 1 });
    expect(rootQueries).toEqual(["/flaky", "/gone"]);
    expect(Array.from(roots().keys())).toEqual(["/flaky"]);
    expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_KEY)!)).toEqual([
      { id: "/locked", path: "/locked" },
      { id: "/flaky", path: "/flaky" },
    ]);
  });

  it("keeps a root that is still opening in storage while another reload would read it", async () => {
    localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([
      { id: "/notes", path: "/notes" },
      { id: "/plans", path: "/plans" },
    ]));
    const { folder, roots } = setup();
    const held = Promise.withResolvers<unknown[]>();
    readTreeFor = (path) => (path === "/plans" ? held.promise : Promise.resolve([]));

    const restoring = folder.restoreOpenRoots();
    await settle();

    // /notes is open, /plans is pending: the persisted list still names both.
    expect(Array.from(roots().keys())).toEqual(["/notes"]);
    expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_KEY)!)).toEqual([
      { id: "/notes", path: "/notes" },
      { id: "/plans", path: "/plans" },
    ]);
    held.resolve([]);
    expect(await restoring).toEqual(["/notes", "/plans"]);
  });

  it("keeps a refused root in storage when another root reopens after it", async () => {
    localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([
      { id: "/notes", path: "/notes" },
      { id: "/plans", path: "/plans" },
    ]));
    rejectMcpPath = "/notes";
    readTreeFor = async () => [];
    const { folder } = setup();

    expect(await folder.restoreOpenRoots()).toEqual(["/plans"]);
    expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_KEY)!)).toEqual([
      { id: "/notes", path: "/notes" },
      { id: "/plans", path: "/plans" },
    ]);
  });

  it("never writes a root the user closed back while the restore is still pruning", async () => {
    localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([
      { id: "/notes", path: "/notes" },
      { id: "/plans", path: "/plans" },
      { id: "/gone", path: "/gone" },
    ]));
    const { folder, roots } = setup();
    const held = Promise.withResolvers<unknown[]>();
    readTreeFor = (path) => {
      if (path === "/gone") return Promise.reject("No such file or directory (os error 2)");
      return path === "/plans" ? held.promise : Promise.resolve([]);
    };
    goneRoots.add("/gone");

    const restoring = folder.restoreOpenRoots();
    await settle();
    expect(Array.from(roots().keys())).toEqual(["/notes"]);
    await folder.handleCloseRoot("/notes");
    // /plans is still reading and /gone is not read yet: both stay wanted.
    expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_KEY)!)).toEqual([
      { id: "/plans", path: "/plans" },
      { id: "/gone", path: "/gone" },
    ]);

    held.resolve([]);
    // /notes did reopen (before the user closed it); only /plans is still open.
    expect(await restoring).toEqual(["/notes", "/plans"]);
    expect(Array.from(roots().keys())).toEqual(["/plans"]);
    // The prune of /gone ran after the close (it is read last) and must not
    // resurrect /notes from the list the restore started with.
    expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_KEY)!)).toEqual([{ id: "/plans", path: "/plans" }]);
  });

  it("does not reopen a root the user closed before the restore reached it", async () => {
    localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([
      { id: "/notes", path: "/notes" },
      { id: "/plans", path: "/plans" },
    ]));
    const { folder, roots } = setup();
    const held = Promise.withResolvers<unknown[]>();
    readTreeFor = (path) => (path === "/notes" ? held.promise : Promise.resolve([]));

    // /notes is slow; meanwhile the user opens /plans by hand and closes it
    // again, before the restore's turn for /plans comes.
    const restoring = folder.restoreOpenRoots();
    await settle();
    expect(await folder.openFolderPath("/plans")).toBe(true);
    await folder.handleCloseRoot("/plans");
    held.resolve([]);

    expect(await restoring).toEqual(["/notes"]);
    expect(Array.from(roots().keys())).toEqual(["/notes"]);
    expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_KEY)!)).toEqual([{ id: "/notes", path: "/notes" }]);
  });

  it("restoring in the background does not move the selection of the open document", async () => {
    localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([{ id: "/plans", path: "/plans" }]));
    const paneManager = createPaneManager();
    let roots = new Map<string, string>();
    const folder = createFolder({
      rootPaths: () => roots,
      setRootPaths: ((value: Map<string, string>) => { roots = value; return roots; }) as never,
      state: makeState(paneManager),
      watcher,
    });
    readTreeFor = async () => [];
    const pane = paneManager.activePane();
    pane.setSelectedRootId("/notes");

    expect(await folder.restoreOpenRoots()).toEqual(["/plans"]);
    expect(pane.selectedRootId()).toBe("/notes");

    // With nothing selected the restored folder is selected, like any open.
    pane.setSelectedRootId(null);
    localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([{ id: "/other", path: "/other" }]));
    const second = createFolder({
      rootPaths: () => roots,
      setRootPaths: ((value: Map<string, string>) => { roots = value; return roots; }) as never,
      state: makeState(paneManager),
      watcher,
    });
    expect(await second.restoreOpenRoots()).toEqual(["/other"]);
    expect(pane.selectedRootId()).toBe("/other");
  });

  it("keeps a root when two walks fail with not-found but the root itself still answers", async () => {
    localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([{ id: "/notes", path: "/notes" }]));
    const { folder, roots } = setup();
    let reads = 0;
    // The walk reports the same unqualified error for the root and for any
    // descendant removed while it runs, so it cannot prove the root is gone.
    readTreeFor = async () => {
      reads++;
      throw "No such file or directory (os error 2)";
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    expect(await folder.restoreOpenRoots()).toEqual([]);
    warnSpy.mockRestore();

    expect(reads).toBe(2);
    expect(rootQueries).toEqual(["/notes", "/notes"]);
    expect(roots().size).toBe(0);
    expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_KEY)!)).toEqual([{ id: "/notes", path: "/notes" }]);
    expect(folder.savedRootIds()).toEqual(["/notes"]);
  });

  it("does not reopen a root the user opened and closed while its restore read was still pending", async () => {
    localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([{ id: "/notes", path: "/notes" }]));
    const { folder, roots } = setup();
    const held = Promise.withResolvers<unknown[]>();
    const reached = Promise.withResolvers<void>();
    let reads = 0;
    readTreeFor = (path) => {
      if (path === "/notes" && ++reads === 1) {
        reached.resolve();
        return held.promise;
      }
      return Promise.resolve([]);
    };

    const restoring = folder.restoreOpenRoots();
    await reached.promise;
    expect(await folder.openFolderPath("/notes")).toBe(true);
    await folder.handleCloseRoot("/notes");
    expect(roots().size).toBe(0);
    const snapshots = mcpRootsCalls.length;

    held.resolve([]);
    expect(await restoring).toEqual([]);

    // The late read neither reopened the root nor told the MCP registry about it.
    expect(roots().size).toBe(0);
    expect(mcpRootsCalls.slice(snapshots)).toEqual([]);
    expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_KEY)!)).toEqual([]);
    expect(folder.savedRootIds()).toEqual([]);
  });

  it("checks the close again inside the root queue, after the read already finished", async () => {
    localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([{ id: "/plans", path: "/plans" }]));
    const { folder, roots } = setup();
    const holdSnapshot = Promise.withResolvers<void>();
    const reachedSnapshot = Promise.withResolvers<void>();
    let hold = true;
    const invokeSpy = spyOn(tauriIpc, "invoke").mockImplementation(async (command, args) => {
      if (command === "mcp_set_roots") {
        if (hold) {
          hold = false;
          reachedSnapshot.resolve();
          await holdSnapshot.promise;
        }
        mcpRootsCalls.push((args as { roots: Array<{ path: string; name: string }> }).roots);
      }
      return undefined as never;
    });
    readTreeFor = async () => [];
    try {
      // A manual open parks the queue in its registry call; the restore of
      // /plans finishes its read and waits behind it.
      const manual = folder.openFolderPath("/notes");
      await reachedSnapshot.promise;
      const restoring = folder.restoreOpenRoots();
      await settle();
      // The user closes /plans while its open still waits for its turn.
      const closing = folder.handleCloseRoot("/plans");
      holdSnapshot.resolve();
      await manual;
      expect(await restoring).toEqual([]);
      await closing;

      expect(Array.from(roots().keys())).toEqual(["/notes"]);
      expect(mcpRootsCalls.flat().some(({ path }) => path === "/plans")).toBe(false);
    } finally {
      invokeSpy.mockRestore();
    }
  });

  it("does not publish a root twice when a manual open finished before the restore's turn", async () => {
    localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([{ id: "/notes", path: "/notes" }]));
    const { folder, roots } = setup();
    const held = Promise.withResolvers<unknown[]>();
    const reached = Promise.withResolvers<void>();
    let reads = 0;
    readTreeFor = (path) => {
      if (path === "/notes" && ++reads === 1) {
        reached.resolve();
        return held.promise;
      }
      return Promise.resolve([]);
    };
    const restoring = folder.restoreOpenRoots();
    await reached.promise;
    expect(await folder.openFolderPath("/notes")).toBe(true);
    const snapshots = mcpRootsCalls.length;

    held.resolve([]);
    expect(await restoring).toEqual(["/notes"]);

    expect(Array.from(roots().keys())).toEqual(["/notes"]);
    expect(mcpRootsCalls.slice(snapshots)).toEqual([]);
  });

  it("lists the saved roots, and none for a missing, corrupt or foreign list or one that says nothing is open", async () => {
    const absent = setup().folder;
    expect(await absent.restoreOpenRoots()).toEqual([]);
    expect(absent.savedRootIds()).toEqual([]);

    localStorage.setItem(OPEN_ROOTS_KEY, "{not json");
    expect(setup().folder.savedRootIds()).toEqual([]);
    localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([{ path: "/notes" }]));
    expect(setup().folder.savedRootIds()).toEqual([]);

    localStorage.setItem(OPEN_ROOTS_KEY, "[]");
    expect(setup().folder.savedRootIds()).toEqual([]);
    localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([{ id: "/notes", path: "/notes" }]));
    expect(setup().folder.savedRootIds()).toEqual(["/notes"]);
  });

  describe("tabs saved before the folder list existed", () => {
    const PENDING_KEY = "markdraw-pending-tab-roots-v1";
    const pendingOnDisk = () => JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null") as string[] | null;

    it("parks the roots of the saved tabs when there is no list, and keeps them after the first list is written", async () => {
      const { folder } = setup();
      folder.adoptSessionRoots(["/workspace-two", "/workspace-two", "/workspace-three"]);
      expect(pendingOnDisk()).toEqual(["/workspace-two", "/workspace-three"]);

      expect(await folder.restoreOpenRoots()).toEqual([]);
      readTreeFor = () => Promise.resolve([]);
      expect(await folder.openFolderPath("/notes")).toBe(true);

      // The list now holds only the folder opened since the update.
      expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_KEY)!)).toEqual([{ id: "/notes", path: "/notes" }]);
      expect(folder.savedRootIds()).toEqual(["/notes", "/workspace-two", "/workspace-three"]);
      expect(pendingOnDisk()).toEqual(["/workspace-two", "/workspace-three"]);
    });

    it("keeps them across a second start whose list is the partial one", async () => {
      // First start: the update, one unrelated folder opened.
      const first = setup().folder;
      first.adoptSessionRoots(["/workspace-two"]);
      await first.restoreOpenRoots();
      readTreeFor = () => Promise.resolve([]);
      await first.openFolderPath("/notes");

      // Second start: the list exists (and is partial), the root still answers.
      rootQueries = [];
      const second = setup();
      second.folder.adoptSessionRoots(["/workspace-two"]);
      expect(await second.folder.restoreOpenRoots()).toEqual(["/notes"]);
      expect(rootQueries).toEqual(["/workspace-two"]);
      expect(second.folder.savedRootIds()).toEqual(["/notes", "/workspace-two"]);
      expect(pendingOnDisk()).toEqual(["/workspace-two"]);
    });

    it("releases a pending root only when its directory is confirmed gone", async () => {
      localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([{ id: "/notes", path: "/notes" }]));
      localStorage.setItem(PENDING_KEY, JSON.stringify(["/gone", "/other"]));
      goneRoots.add("/gone");
      readTreeFor = () => Promise.resolve([]);
      const { folder } = setup();

      expect(await folder.restoreOpenRoots()).toEqual(["/notes"]);

      expect(rootQueries).toEqual(["/gone", "/other"]);
      expect(folder.savedRootIds()).toEqual(["/notes", "/other"]);
      expect(pendingOnDisk()).toEqual(["/other"]);
    });

    it("keeps a pending root whose absence the answer does not prove", async () => {
      localStorage.setItem(OPEN_ROOTS_KEY, "[]");
      localStorage.setItem(PENDING_KEY, JSON.stringify(["/denied"]));
      const failing = spyOn(await import("./fs.ts"), "readFileContent").mockRejectedValue("Permission denied (os error 13)");
      try {
        const { folder } = setup();
        await folder.restoreOpenRoots();
        expect(folder.savedRootIds()).toEqual(["/denied"]);
        expect(pendingOnDisk()).toEqual(["/denied"]);
      } finally {
        failing.mockRestore();
      }
    });

    it("hands a pending root to the list when its folder is opened", async () => {
      localStorage.setItem(OPEN_ROOTS_KEY, JSON.stringify([{ id: "/notes", path: "/notes" }]));
      localStorage.setItem(PENDING_KEY, JSON.stringify(["/workspace-two", "/workspace-three"]));
      readTreeFor = () => Promise.resolve([]);
      const { folder } = setup();
      await folder.restoreOpenRoots();

      expect(await folder.openFolderPath("/workspace-two")).toBe(true);

      expect(pendingOnDisk()).toEqual(["/workspace-three"]);
      expect(folder.savedRootIds()).toEqual(["/notes", "/workspace-two", "/workspace-three"]);
      expect(JSON.parse(localStorage.getItem(OPEN_ROOTS_KEY)!).map((root: { path: string }) => root.path))
        .toEqual(["/notes", "/workspace-two"]);
    });

    it("parks nothing when the list is known or no tab was saved", async () => {
      localStorage.setItem(OPEN_ROOTS_KEY, "[]");
      setup().folder.adoptSessionRoots(["/workspace-two"]);
      expect(pendingOnDisk()).toBeNull();

      localStorage.clear();
      setup().folder.adoptSessionRoots([]);
      expect(pendingOnDisk()).toBeNull();
    });

    it("decides from the list as the page found it, not as a folder opened earlier left it", async () => {
      const { folder } = setup();
      await folder.restoreOpenRoots();
      readTreeFor = () => Promise.resolve([]);
      await folder.openFolderPath("/notes");

      folder.adoptSessionRoots(["/workspace-two"]);

      expect(pendingOnDisk()).toEqual(["/workspace-two"]);
    });
  });

  it("starts clean when the key is absent", async () => {
    const { folder, roots } = setup();
    expect(await folder.restoreOpenRoots()).toEqual([]);
    expect(roots().size).toBe(0);
    expect(resolveReadTree).toBeUndefined();
  });

  it("starts clean when the key is corrupt", async () => {
    localStorage.setItem(OPEN_ROOTS_KEY, "{not json");
    const { folder, roots } = setup();
    expect(await folder.restoreOpenRoots()).toEqual([]);
    expect(roots().size).toBe(0);
    expect(resolveReadTree).toBeUndefined();
    expect(localStorage.getItem(OPEN_ROOTS_KEY)).toBe("{not json");
  });

  it("does not duplicate a root that is already open", async () => {
    const { folder, roots } = setup();
    const opening = folder.openFolderPath("/notes");
    resolveReadTree!([]);
    await opening;

    expect(await folder.restoreOpenRoots()).toEqual(["/notes"]);
    expect(Array.from(roots().keys())).toEqual(["/notes"]);
  });
});
