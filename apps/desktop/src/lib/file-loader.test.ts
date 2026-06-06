// Domain test for `createFileLoader.loadFileContent`. The bug it
// pins down is a pane race: the original implementation used
// `state.setHtml` etc. which proxy through `paneManager.activePane()`.
// Between `await readFileContent` and `state.setHtml(result.html)`
// the user can switch panes, and the convert result lands on the
// wrong pane. Symptom: a file opened in pane 0 stays empty if the
// user clicked pane 1 mid-load.
//
// This test simulates that exact sequence with a real PaneManager
// (so the proxy mechanics match production) and mocked
// readFileContent / convert. The mocked convert resolves on a
// signal we trigger AFTER flipping the active pane — the assertion
// "pane 0 has the content, pane 1 doesn't" is the regression locker.

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { installLocalStorageMock } from "@asciimark/core/test-utils.ts";
import { createPaneManager } from "@asciimark/ui/composables/create-pane-manager.ts";
import type { AppState } from "@asciimark/ui/composables/create-app-state.ts";

installLocalStorageMock();

// Mock the modules that file-loader imports. fs.ts is the IPC client
// (Tauri), so it would fail outright in bun. We replace its functions
// with deterministic stubs.
const FAKE_FILE_CONTENT = "= intro.adoc\n\nbody\n";
let resolveRead: ((value: string) => void) | undefined;
let rejectRead: ((err: Error) => void) | undefined;

mock.module("./fs.ts", () => ({
  readFileContent: () =>
    new Promise<string>((resolve, reject) => {
      resolveRead = resolve;
      rejectRead = reject;
    }),
  readFileByPath: async () => null,
  readFilesRelative: async () => new Map<string, string>(),
  // Other exports listed because bun.module mocks the whole module —
  // anything not listed becomes undefined for every suite that
  // imports `./fs.ts` (mock survives the test process). These stubs
  // are no-ops; the suites that actually exercise them ship their
  // own controllable mocks above this one.
  writeFile: async () => {},
  renameFile: async () => {},
  trashPath: async () => {},
  readTree: async () => [],
  openDirectory: async () => null,
  createFile: async () => {},
  createDir: async () => {},
  copyPath: async () => {},
  movePath: async () => {},
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));
mock.module("@tauri-apps/api/core", () => ({
  invoke: async () => undefined,
  // Resource is a base class used by other Tauri plugins (notably
  // plugin-updater's Update class). Other test suites in this folder
  // import that plugin transitively; bun mocks are process-wide and
  // first-to-load wins, so we have to ship Resource here for those
  // tests to resolve cleanly when this suite runs first.
  Resource: class {},
  // Channel ditto — plugin-updater does a static
  // `import { Channel } from "@tauri-apps/api/core"` and explodes
  // with "Export named 'Channel' not found" when this mock wins
  // first-to-load and another suite then imports plugin-updater.
  Channel: class {},
}));
mock.module("./chaos-invoke.ts", () => ({
  invoke: async () => undefined,
}));

describe("createFileLoader / loadFileContent — pane race regression", () => {
  beforeEach(() => {
    resolveRead = undefined;
    localStorage.clear();
  });

  it("writes the convert result to the pane that was active at call time, NOT the pane active when the result arrives", async () => {
    // Mutation captured: reverting `targetPane.setHtml(result.html)`
    // back to `state.setHtml(result.html)` (the proxy form) makes
    // this assertion fail — the proxy reads `activePane()` at write
    // time, which by then has flipped to pane 1.
    const paneManager = createPaneManager();
    paneManager.splitFromActive();
    paneManager.setActivePane(0);
    const pane0 = paneManager.panes()[0]!;
    const pane1 = paneManager.panes()[1]!;

    let pushedNav = false;
    let _readFile: unknown = null;

    const state = {
      paneManager,
      get selectedRootId() { return paneManager.activePane().selectedRootId; },
      get setSelectedRootId() { return paneManager.activePane().setSelectedRootId; },
      get selectedFile() { return paneManager.activePane().selectedFile; },
      get setSelectedFile() { return paneManager.activePane().setSelectedFile; },
      get setHtml() { return paneManager.activePane().setHtml; },
      get setFrontmatter() { return paneManager.activePane().setFrontmatter; },
      get setEditorContent() { return paneManager.activePane().setEditorContent; },
      get setSavedContent() { return paneManager.activePane().setSavedContent; },
      get setLoading() { return paneManager.activePane().setLoading; },
      pushNavHistory: () => { pushedNav = true; },
      autoRefresh: () => false,
      convert: async () => ({
        html: "<p>converted intro.adoc</p>",
        frontmatter: null,
        toc: null,
        meta: {},
      }),
      set _readFile(v: unknown) { _readFile = v; },
    } as unknown as AppState;

    const watcher = {
      setTarget: () => {},
      start: () => {},
      stop: () => {},
      destroy: () => {},
    } as unknown as Parameters<
      typeof import("./file-loader.ts").createFileLoader
    >[0]["watcher"];

    const rootPaths = () => new Map<string, string>([["root-0", "/tmp/ws"]]);

    // Import after the mocks are registered so the loader sees the
    // mocked fs.ts.
    const { createFileLoader } = await import("./file-loader.ts");
    const loader = createFileLoader({ rootPaths, state, watcher });

    // Kick off a load on pane 0 — the active pane at this moment.
    const loadPromise = loader.loadFileContent(
      { kind: "file", name: "intro.adoc", path: "intro.adoc" },
      false,
      false,
      "root-0",
    );

    // Wait a microtask so the loader has a chance to start its
    // pre-await work (capture the target pane, set selectedFile etc.).
    await new Promise((r) => setTimeout(r, 0));

    // SIMULATE THE BUG: flip the active pane to pane 1 while the
    // file read is still in-flight. The original implementation
    // wrote via the AppState proxy and would route the convert
    // result to whatever was active when `setHtml` ran. The fix
    // pins the target pane at call time.
    paneManager.setActivePane(1);

    // Resolve the file read so the loader proceeds to convert + write.
    resolveRead!(FAKE_FILE_CONTENT);
    await loadPromise;

    // The convert result MUST land on pane 0 (the original target),
    // not pane 1 (the now-active pane).
    expect(pane0.html()).toBe("<p>converted intro.adoc</p>");
    expect(pane1.html()).toBe("");
    expect(pane0.savedContent()).toBe(FAKE_FILE_CONTENT);
    expect(pane1.savedContent()).toBe("");
    expect(pane0.selectedFile()?.path).toBe("intro.adoc");
    expect(pane1.selectedFile()).toBeNull();

    expect(pushedNav).toBe(false); // pushHistory=false in this call
    expect(_readFile).toBeTypeOf("function");
  });

  it("error path also writes to the originally-targeted pane", async () => {
    // Even when convert throws, the error message html must land on
    // the pane the user opened the file in, not whatever's active
    // when the catch runs.
    const paneManager = createPaneManager();
    paneManager.splitFromActive();
    paneManager.setActivePane(0);
    const pane0 = paneManager.panes()[0]!;
    const pane1 = paneManager.panes()[1]!;

    const state = {
      paneManager,
      pushNavHistory: () => {},
      autoRefresh: () => false,
      convert: async () => {
        throw new Error("boom");
      },
      set _readFile(_v: unknown) {},
    } as unknown as AppState;

    const watcher = {
      setTarget: () => {},
      start: () => {},
      stop: () => {},
      destroy: () => {},
    } as unknown as Parameters<
      typeof import("./file-loader.ts").createFileLoader
    >[0]["watcher"];

    const rootPaths = () => new Map<string, string>([["root-0", "/tmp/ws"]]);

    const { createFileLoader } = await import("./file-loader.ts");
    const loader = createFileLoader({ rootPaths, state, watcher });

    const loadPromise = loader.loadFileContent(
      { kind: "file", name: "intro.adoc", path: "intro.adoc" },
      false,
      false,
      "root-0",
    );
    await new Promise((r) => setTimeout(r, 0));
    paneManager.setActivePane(1);
    resolveRead!(FAKE_FILE_CONTENT);
    await loadPromise;

    expect(pane0.html()).toContain("Error converting file");
    expect(pane1.html()).toBe("");
  });
});

describe("createFileLoader / loadFileContent — image & PDF skip the text pipeline", () => {
  beforeEach(() => {
    resolveRead = undefined;
    localStorage.clear();
  });

  it.each(["photo.png", "scan.pdf"])(
    "selects %s without reading content or converting",
    async (fileName) => {
      // Mutation captured: removing the image/pdf early-return makes the
      // loader fall through to readFileContent() (which never resolves in
      // this mock — the await would hang and the test times out) and to
      // state.convert (the spy below flips convertCalled and fails the
      // assertion). Either way the binary would be force-read as UTF-8.
      const paneManager = createPaneManager();
      paneManager.setActivePane(0);
      const pane0 = paneManager.panes()[0]!;

      let convertCalled = false;
      let stopCalled = false;

      const state = {
        paneManager,
        pushNavHistory: () => {},
        autoRefresh: () => false,
        convert: async () => {
          convertCalled = true;
          return { html: "", frontmatter: null, toc: null, meta: {} };
        },
        set _readFile(_v: unknown) {},
      } as unknown as AppState;

      const watcher = {
        setTarget: () => {},
        start: () => {},
        stop: () => { stopCalled = true; },
        destroy: () => {},
      } as unknown as Parameters<
        typeof import("./file-loader.ts").createFileLoader
      >[0]["watcher"];

      const rootPaths = () => new Map<string, string>([["root-0", "/tmp/ws"]]);

      const { createFileLoader } = await import("./file-loader.ts");
      const loader = createFileLoader({ rootPaths, state, watcher });

      // No resolveRead() call here: a correct binary branch resolves the
      // load on its own. If readFileContent were awaited this would hang.
      await loader.loadFileContent(
        { kind: "file", name: fileName, path: fileName },
        false,
        false,
        "root-0",
      );

      expect(pane0.selectedFile()?.path).toBe(fileName);
      expect(pane0.html()).toBe("");
      expect(pane0.editorContent()).toBe("");
      expect(pane0.savedContent()).toBe("");
      expect(pane0.loading()).toBe(false);
      expect(convertCalled).toBe(false);
      expect(stopCalled).toBe(true);
    },
  );
});

describe("createFileLoader / loadFileContent — binary non-text marks the pane unsupported", () => {
  beforeEach(() => {
    resolveRead = undefined;
    rejectRead = undefined;
    localStorage.clear();
  });

  it("a non-image/pdf file whose read fails (binary) gets UNSUPPORTED_CONTENT, not a convert", async () => {
    // Mutation captured: removing the read-failure branch lets the error
    // propagate to the generic catch ("Error converting file: …") instead
    // of the unsupported sentinel — flipping html away from
    // UNSUPPORTED_CONTENT and failing this assertion. read_to_string throws
    // on non-UTF8, which is exactly how the app detects binary junk.
    const { UNSUPPORTED_CONTENT } = await import("@asciimark/core/utils.ts");
    const paneManager = createPaneManager();
    paneManager.setActivePane(0);
    const pane0 = paneManager.panes()[0]!;

    let convertCalled = false;
    const state = {
      paneManager,
      pushNavHistory: () => {},
      autoRefresh: () => false,
      convert: async () => {
        convertCalled = true;
        return { html: "", frontmatter: null, toc: null, meta: {} };
      },
      set _readFile(_v: unknown) {},
    } as unknown as AppState;

    const watcher = {
      setTarget: () => {},
      start: () => {},
      stop: () => {},
      destroy: () => {},
    } as unknown as Parameters<
      typeof import("./file-loader.ts").createFileLoader
    >[0]["watcher"];

    const rootPaths = () => new Map<string, string>([["root-0", "/tmp/ws"]]);
    const { createFileLoader } = await import("./file-loader.ts");
    const loader = createFileLoader({ rootPaths, state, watcher });

    const loadPromise = loader.loadFileContent(
      { kind: "file", name: "archive.zip", path: "archive.zip" },
      false,
      false,
      "root-0",
    );
    await new Promise((r) => setTimeout(r, 0));
    // Simulate read_to_string failing on a binary file.
    rejectRead!(new Error("stream did not contain valid UTF-8"));
    await loadPromise;

    expect(pane0.selectedFile()?.path).toBe("archive.zip");
    expect(pane0.html()).toBe(UNSUPPORTED_CONTENT);
    expect(pane0.editorContent()).toBe("");
    expect(pane0.loading()).toBe(false);
    expect(convertCalled).toBe(false);
  });
});
