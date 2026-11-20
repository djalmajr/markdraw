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
import { installLocalStorageMock } from "@markdraw/core/test-utils.ts";
import { createPaneManager } from "@markdraw/ui/composables/create-pane-manager.ts";
import type { AppState } from "@markdraw/ui/composables/create-app-state.ts";

installLocalStorageMock();

// Mock the modules that file-loader imports. fs.ts is the IPC client
// (Tauri), so it would fail outright in bun. We replace its functions
// with deterministic stubs.
const FAKE_FILE_CONTENT = "= intro.adoc\n\nbody\n";
let resolveRead: ((value: string) => void) | undefined;
let rejectRead: ((err: Error) => void) | undefined;
// Every pending read, in call order (overlapping refreshes need their own).
let readResolvers: Array<(value: string) => void> = [];
let readRejecters: Array<(err: Error) => void> = [];
let readFileByPathMock: (
  rootPath: string,
  relativePath: string,
) => Promise<string | null> = async () => null;
let readFilesRelativeMock: (
  rootPath: string,
  paths: string[],
) => Promise<Map<string, string>> = async () => new Map<string, string>();

mock.module("./fs.ts", () => ({
  readFileContent: () =>
    new Promise<string>((resolve, reject) => {
      resolveRead = resolve;
      rejectRead = reject;
      readResolvers.push(resolve);
      readRejecters.push(reject);
    }),
  readFileByPath: (rootPath: string, relativePath: string) =>
    readFileByPathMock(rootPath, relativePath),
  readFilesRelative: (rootPath: string, paths: string[]) =>
    readFilesRelativeMock(rootPath, paths),
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
  // bun shares module mocks across test files: keep every export that
  // `@tauri-apps/api/window` imports (the tray suite loads it).
  once: async () => () => {},
  emit: async () => {},
  emitTo: async () => {},
  TauriEvent: {},
}));
mock.module("@tauri-apps/api/core", () => ({
  // bun shares module mocks across test files: keep every export a module
  // under test may import, or a later file fails to link.
  convertFileSrc: (path: string) => path,
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
    rejectRead = undefined;
    readFileByPathMock = async () => null;
    readFilesRelativeMock = async () => new Map<string, string>();
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
    let registered: { pane: unknown; rootId: unknown; path: unknown; reader: unknown } | null = null;

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
      registerReader: (pane: unknown, rootId: unknown, path: unknown, reader: unknown) => { registered = { pane, rootId, path, reader }; },
      previewReflects: async () => true,
      notePreviewed: () => {},
      notePreviewFailed: () => {},
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
    // The load hands its reader to the app state keyed by pane, root and file,
    // instead of overwriting one global reader.
    expect(registered).not.toBeNull();
    const reg = registered!;
    expect(reg.pane).toBe(pane0);
    expect(reg.rootId).toBe("root-0");
    expect(reg.path).toBe("intro.adoc");
    expect((reg.reader as { readFile: unknown }).readFile).toBeTypeOf("function");
    expect((reg.reader as { readFiles: unknown }).readFiles).toBeTypeOf("function");
  });

  it("falls back to direct reads for nested includes missing from the initial batch cache", async () => {
    // Mutation captured: returning null on include-cache miss prevents
    // README.adoc -> business/_index.adoc -> 01-visao-geral.adoc from
    // rendering the nested sibling include.
    const paneManager = createPaneManager();
    paneManager.setActivePane(0);
    const pane0 = paneManager.panes()[0]!;

    let batchedPaths: string[] = [];
    const fallbackPaths: string[] = [];
    let watchedIncludePaths: string[] = [];

    readFilesRelativeMock = async (_rootPath, paths) => {
      batchedPaths = paths;
      return new Map<string, string>([
        ["business/_index.adoc", "include::01-visao-geral.adoc[]"],
      ]);
    };
    readFileByPathMock = async (_rootPath, relativePath) => {
      fallbackPaths.push(relativePath);
      return relativePath === "business/01-visao-geral.adoc"
        ? "Nested section content"
        : null;
    };

    const state = {
      paneManager,
      pushNavHistory: () => {},
      autoRefresh: () => false,
      convert: async (
        _filePath: string,
        _content: string,
        readFile: (path: string) => Promise<string | null>,
        readFiles?: (paths: string[]) => Promise<Map<string, string | null>>,
      ) => {
        // The converter reads the first layer in one batch (AsciiDoc: no
        // pre-scan batch of the loader), then asks for the nested file.
        const topLevel = (await readFiles!(["business/_index.adoc"])).get("business/_index.adoc");
        const nested = await readFile("business/01-visao-geral.adoc");
        return {
          html: `${topLevel ?? "missing top"}\n${nested ?? "missing nested"}`,
          frontmatter: null,
          toc: null,
          meta: {},
        };
      },
      registerReader: () => {},
      previewReflects: async () => true,
      notePreviewed: () => {},
      notePreviewFailed: () => {},
    } as unknown as AppState;

    const watcher = {
      setTarget: (target: { includePaths: string[] }) => {
        watchedIncludePaths = target.includePaths;
      },
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
      { kind: "file", name: "README.adoc", path: "README.adoc" },
      false,
      false,
      "root-0",
    );
    await new Promise((r) => setTimeout(r, 0));
    resolveRead!("= README\n\ninclude::business/_index.adoc[]");
    await loadPromise;

    expect(batchedPaths).toEqual(["business/_index.adoc"]);
    expect(fallbackPaths).toEqual(["business/01-visao-geral.adoc"]);
    expect(pane0.html()).toContain("Nested section content");
    expect(watchedIncludePaths).toEqual([
      "business/_index.adoc",
      "business/01-visao-geral.adoc",
    ]);
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
      registerReader: () => {},
      previewReflects: async () => true,
      notePreviewed: () => {},
      notePreviewFailed: () => {},
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

describe("createFileLoader / loadFileContent — watcher survives a conversion error", () => {
  beforeEach(() => {
    resolveRead = undefined;
    rejectRead = undefined;
    readFileByPathMock = async () => null;
    readFilesRelativeMock = async () => new Map<string, string>();
    localStorage.clear();
  });

  it("aims the watcher at the document that failed so its next save on disk reaches the preview", async () => {
    // Mutation captured: leaving the conversion-error catch without calling
    // `watch(...)` keeps the watcher on the file opened before it (or on
    // nothing), so the next save of the failing document never triggers
    // `refreshFromDisk` — the preview stays on the error until a reopen.
    const paneManager = createPaneManager();
    const targets: Array<{ filePath: string; includePaths: string[]; rootPath: string }> = [];
    const started: number[] = [];
    const state = {
      paneManager,
      pushNavHistory: () => {},
      autoRefresh: () => true,
      convert: async () => {
        throw new Error("boom");
      },
      registerReader: () => {},
      previewReflects: async () => true,
      notePreviewed: () => {},
      notePreviewFailed: () => {},
    } as unknown as AppState;
    const watcher = {
      setTarget: (params: { filePath: string; includePaths: string[]; rootPath: string }) => {
        targets.push(params);
      },
      start: () => {
        started.push(1);
      },
      stop: async () => {},
      destroy: async () => {},
    } as unknown as Parameters<
      typeof import("./file-loader.ts").createFileLoader
    >[0]["watcher"];
    readFilesRelativeMock = async (_root, paths) => new Map(paths.map((path) => [path, "Included text"]));

    const rootPaths = () => new Map<string, string>([["root-0", "/ws"]]);
    const { createFileLoader } = await import("./file-loader.ts");
    const loader = createFileLoader({ rootPaths, state, watcher });

    const loadPromise = loader.loadFileContent(
      { kind: "file", name: "intro.adoc", path: "intro.adoc" },
      false,
      false,
      "root-0",
    );
    await new Promise((r) => setTimeout(r, 0));
    resolveRead!("= intro.adoc\n\ninclude::chapter.adoc[]\n");
    await loadPromise;

    expect(paneManager.activePane().html()).toContain("Error converting file");
    expect(targets).toEqual([
      { filePath: "/ws/intro.adoc", includePaths: ["chapter.adoc"], rootPath: "/ws" },
    ]);
    expect(started).toHaveLength(1);
  });
});

describe("createFileLoader / loadFileContent — image & PDF skip the text pipeline", () => {
  beforeEach(() => {
    resolveRead = undefined;
    rejectRead = undefined;
    readFileByPathMock = async () => null;
    readFilesRelativeMock = async () => new Map<string, string>();
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
        registerReader: () => {},
        previewReflects: async () => true,
        notePreviewed: () => {},
      notePreviewFailed: () => {},
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
    readFileByPathMock = async () => null;
    readFilesRelativeMock = async () => new Map<string, string>();
    localStorage.clear();
  });

  it("a non-image/pdf file whose read fails (binary) gets UNSUPPORTED_CONTENT, not a convert", async () => {
    // Mutation captured: removing the read-failure branch lets the error
    // propagate to the generic catch ("Error converting file: …") instead
    // of the unsupported sentinel — flipping html away from
    // UNSUPPORTED_CONTENT and failing this assertion. read_to_string throws
    // on non-UTF8, which is exactly how the app detects binary junk.
    const { UNSUPPORTED_CONTENT } = await import("@markdraw/core/utils.ts");
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
      registerReader: () => {},
      previewReflects: async () => true,
      notePreviewed: () => {},
      notePreviewFailed: () => {},
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

describe("createFileLoader / refreshFromDisk — autosave vs. watcher race", () => {
  // The watcher fires for the app's own autosave writes too. Before the fix
  // the refresh force-reloaded the file, so text typed between the save and
  // the event (~500ms) dropped out of the editor state and autosave wrote the
  // old text back.
  beforeEach(() => {
    resolveRead = undefined;
    rejectRead = undefined;
    readFileByPathMock = async () => null;
    readFilesRelativeMock = async () => new Map<string, string>();
    localStorage.clear();
  });

  async function setup(saved: string, current: string, path = "README.md") {
    readResolvers = [];
    readRejecters = [];
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    const entry = { kind: "file" as const, name: path, path };
    pane.setSelectedRootId("root-0");
    pane.setSelectedFile(entry);
    pane.setSavedContent(saved);
    pane.setEditorContent(current);

    const convertReleases: Array<() => void> = [];
    let holdConvert = false;
    const state = {
      paneManager,
      pushNavHistory: () => {},
      autoRefresh: () => false,
      convert: async (_path: string, content: string) => {
        if (holdConvert) await new Promise<void>((r) => { convertReleases.push(r); });
        return { html: `<p>${content}</p>`, frontmatter: null, toc: null, meta: {} };
      },
      registerReader: () => {},
      previewReflects: async () => true,
      notePreviewed: () => {},
      notePreviewFailed: () => {},
    } as unknown as AppState;
    const watcher = {
      setTarget: () => {},
      start: () => {},
      stop: () => {},
      destroy: () => {},
    } as unknown as Parameters<typeof import("./file-loader.ts").createFileLoader>[0]["watcher"];
    const rootPaths = () => new Map<string, string>([["root-0", "/tmp/ws"]]);
    const { createFileLoader } = await import("./file-loader.ts");
    const loader = createFileLoader({ rootPaths, state, watcher });
    return {
      pane,
      paneManager,
      loader,
      refresh: () => loader.refreshFromDisk(entry, "root-0"),
      holdConvert: () => { holdConvert = true; },
      /** Let the n-th held conversion (call order) finish. */
      releaseConvert: (n = 0) => convertReleases[n]?.(),
    };
  }

  it("keeps text typed after our own autosave when its watcher event arrives", async () => {
    // Mutation captured: adopting the disk text on every refresh (the old
    // force reload) sets the buffer back to "saved" and loses " typed later".
    const { pane, refresh } = await setup("saved", "saved typed later");
    const done = refresh();
    await new Promise((r) => setTimeout(r, 0));
    resolveRead!("saved"); // disk == last save: this is our own write
    // Not an outside edit: the caller must not re-index (autosave already did).
    // Mutation captured: reporting every refresh as a change re-embeds the
    // whole document after each autosave.
    expect(await done).toBe(false);

    expect(pane.editorContent()).toBe("saved typed later");
    expect(pane.savedContent()).toBe("saved");
    expect(pane.html()).toBe("<p>saved typed later</p>");
    expect(pane.loading()).toBe(false);
  });

  it("never applies a refresh over text typed while it was converting", async () => {
    // Mutation captured: dropping the "buffer moved" check lets the disk text
    // overwrite the keystrokes that landed during the conversion.
    const { pane, refresh, holdConvert, releaseConvert } = await setup("a", "a");
    holdConvert();
    const done = refresh();
    await new Promise((r) => setTimeout(r, 0));
    resolveRead!("changed elsewhere"); // clean buffer + external change → reload
    await new Promise((r) => setTimeout(r, 0));
    expect(pane.loading()).toBe(false); // background work: no loading flash
    pane.setEditorContent("a typed meanwhile"); // the user types mid-conversion
    releaseConvert();
    await done;

    expect(pane.editorContent()).toBe("a typed meanwhile");
    expect(pane.savedContent()).toBe("a");
  });

  it("adopts an external change when the buffer has no unsaved edits", async () => {
    const { pane, refresh } = await setup("a", "a");
    const done = refresh();
    await new Promise((r) => setTimeout(r, 0));
    resolveRead!("changed elsewhere");
    // Mutation captured: never reporting a change leaves the AI index stale
    // after outside edits.
    expect(await done).toBe(true);

    expect(pane.editorContent()).toBe("changed elsewhere");
    expect(pane.savedContent()).toBe("changed elsewhere");
    expect(pane.html()).toBe("<p>changed elsewhere</p>");
  });

  it("keeps unsaved edits when the file changes elsewhere", async () => {
    // Mutation captured: falling through to adopt the disk on "keep-local"
    // replaces what the user is typing with the other program's version.
    const { pane, refresh } = await setup("a", "a typed");
    const done = refresh();
    await new Promise((r) => setTimeout(r, 0));
    resolveRead!("changed elsewhere");
    expect(await done).toBe(false);

    expect(pane.editorContent()).toBe("a typed");
    expect(pane.savedContent()).toBe("a");
  });

  it("clears the dirty mark when the disk already holds the buffer", async () => {
    const { pane, refresh } = await setup("a", "ab");
    const done = refresh();
    await new Promise((r) => setTimeout(r, 0));
    resolveRead!("ab");
    await done;

    expect(pane.editorContent()).toBe("ab");
    expect(pane.savedContent()).toBe("ab");
  });

  it("lets the newest of two overlapping refreshes win", async () => {
    // Refresh 1 reads v1 and converts slowly; meanwhile the file changes again
    // and refresh 2 reads v2. Mutation captured: without the refresh counter,
    // refresh 1 applies v1 and refresh 2 then drops v2 (the buffer "moved").
    const { pane, refresh, holdConvert, releaseConvert } = await setup("a", "a");
    holdConvert();
    const first = refresh();
    await new Promise((r) => setTimeout(r, 0));
    readResolvers[0]!("v1");
    await new Promise((r) => setTimeout(r, 0));
    const second = refresh();
    await new Promise((r) => setTimeout(r, 0));
    readResolvers[1]!("v2");
    await new Promise((r) => setTimeout(r, 0));
    releaseConvert(0);
    await first;
    releaseConvert(1);
    await second;

    expect(pane.editorContent()).toBe("v2");
    expect(pane.savedContent()).toBe("v2");
    expect(pane.html()).toBe("<p>v2</p>");
  });

  it("drops an older event whose disk read finishes after a newer event already converted", async () => {
    // Event 1 reads the disk, event 2 arrives later and its read returns first.
    // Mutation captured: without the claim order, event 1 claims after event 2
    // and its older text (v1) replaces v2 on screen.
    const { pane, refresh, holdConvert, releaseConvert } = await setup("a", "a");
    holdConvert();
    const first = refresh();
    await new Promise((r) => setTimeout(r, 0));
    const second = refresh();
    await new Promise((r) => setTimeout(r, 0));
    readResolvers[1]!("v2");
    await new Promise((r) => setTimeout(r, 0));
    readResolvers[0]!("v1");
    await new Promise((r) => setTimeout(r, 0));
    releaseConvert(0);
    await second;
    releaseConvert(1);
    await first;

    expect(pane.editorContent()).toBe("v2");
    expect(pane.html()).toBe("<p>v2</p>");
  });

  it("drops the failure of an older event whose read rejects after a newer event converted", async () => {
    // Event 1 is still reading when event 2 reads, converts and publishes v2.
    // Mutation captured: without the claim order in `superseded`, the late
    // rejection of event 1 replaces the preview of v2 with an error.
    const { pane, refresh } = await setup("a", "a");
    const first = refresh();
    await new Promise((r) => setTimeout(r, 0));
    const second = refresh();
    await new Promise((r) => setTimeout(r, 0));
    readResolvers[1]!("v2");
    await second;
    expect(pane.html()).toBe("<p>v2</p>");
    readRejecters[0]!(new Error("old read failed"));
    await first;

    expect(pane.html()).toBe("<p>v2</p>");
    expect(pane.editorContent()).toBe("v2");
  });

  it("still reports the failure of a read that no newer event outdated", async () => {
    const { pane, refresh } = await setup("a", "a");
    const first = refresh();
    await new Promise((r) => setTimeout(r, 0));
    readRejecters[0]!(new Error("only read failed"));
    await first;

    expect(pane.html()).toContain("only read failed");
  });

  it("never puts the file's text into another tab opened during the disk read", async () => {
    // Mutation captured: without the selected-file check, the refresh compares
    // against the new tab's (clean) buffer and adopts README.md's disk text
    // into it — autosave would then write it into the other file.
    const { pane, refresh } = await setup("readme", "readme");
    const done = refresh();
    await new Promise((r) => setTimeout(r, 0));
    pane.setSelectedFile({ kind: "file", name: "other.md", path: "other.md" });
    pane.setSavedContent("other");
    pane.setEditorContent("other");
    resolveRead!("readme changed elsewhere");
    await done;

    expect(pane.selectedFile()?.path).toBe("other.md");
    expect(pane.editorContent()).toBe("other");
    expect(pane.savedContent()).toBe("other");
  });

  it("drops a plain-text file's refresh when another tab opened during the read", async () => {
    // Plain text (txt/json/yaml) applies right after the decision, so the
    // check after the disk read is its only guard. Mutation captured: removing
    // that check adopts notes.txt's disk text into the other tab.
    const { pane, refresh } = await setup("notes", "notes", "notes.txt");
    const done = refresh();
    await new Promise((r) => setTimeout(r, 0));
    pane.setSelectedFile({ kind: "file", name: "other.txt", path: "other.txt" });
    pane.setSavedContent("other");
    pane.setEditorContent("other");
    resolveRead!("notes changed elsewhere");
    await done;

    expect(pane.editorContent()).toBe("other");
    expect(pane.savedContent()).toBe("other");
  });

  it("a refresh of another pane's file doesn't cancel this pane's refresh", async () => {
    // Pane 0's refresh is converting when the user clicks pane 1 and a second
    // watcher event refreshes pane 1's file. Mutation captured: one counter
    // shared by all panes drops pane 0's refresh, leaving it on stale text.
    const { pane: pane0, paneManager, loader, holdConvert, releaseConvert, refresh } =
      await setup("a", "a");
    paneManager.splitFromActive();
    paneManager.setActivePane(0);
    holdConvert();
    const first = refresh(); // pane 0, README.md
    await new Promise((r) => setTimeout(r, 0));
    readResolvers[0]!("a changed elsewhere");
    await new Promise((r) => setTimeout(r, 0));

    paneManager.setActivePane(1);
    const pane1 = paneManager.activePane();
    const other = { kind: "file" as const, name: "other.md", path: "other.md" };
    pane1.setSelectedRootId("root-0");
    pane1.setSelectedFile(other);
    pane1.setSavedContent("b");
    pane1.setEditorContent("b");
    const second = loader.refreshFromDisk(other, "root-0");
    await new Promise((r) => setTimeout(r, 0));
    readResolvers[1]!("b");
    await new Promise((r) => setTimeout(r, 0));

    releaseConvert(0);
    await first;
    releaseConvert(1);
    await second;

    expect(pane0.editorContent()).toBe("a changed elsewhere");
    expect(pane0.savedContent()).toBe("a changed elsewhere");
    expect(pane1.editorContent()).toBe("b");
  });
});

describe("createFileLoader / refreshFromDisk — echo of our own autosave", () => {
  // Each autosave fires a watcher event whose refresh converted the whole
  // document again. The autosave now records path + content hash of what it
  // wrote; an event that names only that path, with the disk still holding
  // that text, is skipped. Anything else keeps converting.
  const ROOT = "/tmp/ws";
  const FILE = "/tmp/ws/doc.adoc";

  beforeEach(() => {
    resolveRead = undefined;
    rejectRead = undefined;
    readFileByPathMock = async () => null;
    readFilesRelativeMock = async () => new Map<string, string>();
    localStorage.clear();
  });

  async function setup(saved: string, current: string, name = "doc.adoc") {
    readResolvers = [];
    readRejecters = [];
    const { createOwnWrites } = await import("./external-reload.ts");
    const ownWrites = createOwnWrites();
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    const entry = { kind: "file" as const, name, path: name };
    pane.setSelectedRootId("root-0");
    pane.setSelectedFile(entry);
    pane.setSavedContent(saved);
    pane.setEditorContent(current);
    pane.setHtml("<p>already rendered</p>");
    let conversions = 0;
    const reflects = { value: true };
    // The check of the preview can be held open to let another event publish.
    const gate = { wait: Promise.resolve() as Promise<void> };
    const asked: string[] = [];
    const noted: string[] = [];
    const failed: Array<{ path: string; tabId: unknown }> = [];
    const state = {
      paneManager,
      pushNavHistory: () => {},
      autoRefresh: () => false,
      convert: async (_path: string, content: string) => {
        conversions++;
        return { html: `<p>${content}</p>`, frontmatter: null, toc: null, meta: {} };
      },
      registerReader: () => {},
      previewReflects: async (_pane: unknown, _root: unknown, _path: string, content: string) => {
        asked.push(content);
        await gate.wait;
        return reflects.value;
      },
      notePreviewed: (_pane: unknown, _root: unknown, _path: string, content: string) => { noted.push(content); },
      notePreviewFailed: (_pane: unknown, _root: unknown, path: string, tabId?: unknown) => { failed.push({ path, tabId }); },
    } as unknown as AppState;
    const watcher = {
      setTarget: () => {},
      start: () => {},
      stop: () => {},
      destroy: () => {},
    } as unknown as Parameters<typeof import("./file-loader.ts").createFileLoader>[0]["watcher"];
    const rootPaths = () => new Map<string, string>([["root-0", ROOT]]);
    const { createFileLoader } = await import("./file-loader.ts");
    const loader = createFileLoader({ rootPaths, state, watcher, ownWrites });
    return {
      pane,
      entry,
      loader,
      ownWrites,
      reflects,
      gate,
      asked,
      noted,
      failed,
      conversions: () => conversions,
      refresh: async (disk: string, eventPaths?: string[]) => {
        const done = loader.refreshFromDisk(entry, "root-0", eventPaths);
        await new Promise((r) => setTimeout(r, 0));
        resolveRead!(disk);
        return await done;
      },
    };
  }

  it("skips the conversion when the event is only our own write and the disk holds it", async () => {
    // Mutation captured: removing the ownWrites branch in load() converts here.
    const { pane, ownWrites, conversions, refresh } = await setup("saved text", "saved text");
    ownWrites.mark(FILE, "saved text");
    expect(await refresh("saved text", [FILE])).toBe(false);
    expect(conversions()).toBe(0);
    expect(pane.html()).toBe("<p>already rendered</p>");
  });

  it("converts the echo when the preview of that text is not on screen (the edit conversion failed)", async () => {
    // Mutation captured: skipping on the hash alone leaves the preview on older text.
    const { pane, ownWrites, reflects, asked, noted, conversions, refresh } = await setup("saved text", "saved text");
    ownWrites.mark(FILE, "saved text");
    reflects.value = false;
    expect(await refresh("saved text", [FILE])).toBe(false);
    expect(asked).toEqual(["saved text"]);
    expect(conversions()).toBe(1);
    expect(pane.html()).toBe("<p>saved text</p>");
    expect(noted).toEqual(["saved text"]);
  });

  it("drops the failure of an older event once the echo confirmed the saved text", async () => {
    // An include event is still reading when the echo of our own save confirms
    // the preview of the saved text. Mutation captured: without
    // `latestConfirmed` in `failureStale`, the late rejection replaces the
    // preview with an error.
    const { pane, entry, loader, ownWrites, conversions, refresh } = await setup("saved text", "saved text");
    ownWrites.mark(FILE, "saved text");
    const older = loader.refreshFromDisk(entry, "root-0", [`${ROOT}/partials/inc.adoc`]);
    await new Promise((r) => setTimeout(r, 0));
    expect(await refresh("saved text", [FILE])).toBe(false);
    expect(conversions()).toBe(0);
    readRejecters[0]!(new Error("old include read failed"));
    await older;
    expect(pane.html()).toBe("<p>already rendered</p>");
  });

  it("drops the failure of an older read of a plain-text file once the echo confirmed its text", async () => {
    // Same rule at the unsupported-file branch of the read error: that branch
    // would blank the pane and show the notice over the confirmed text.
    const { pane, entry, loader, ownWrites, refresh } = await setup("saved text", "saved text", "doc.bin");
    ownWrites.mark(`${ROOT}/doc.bin`, "saved text");
    const older = loader.refreshFromDisk(entry, "root-0", [`${ROOT}/partials/inc.adoc`]);
    await new Promise((r) => setTimeout(r, 0));
    expect(await refresh("saved text", [`${ROOT}/doc.bin`])).toBe(false);
    readRejecters[0]!(new Error("old read failed"));
    await older;
    expect(pane.html()).toBe("<p>already rendered</p>");
    expect(pane.editorContent()).toBe("saved text");
  });

  it("still reports the failure of an event that started after the confirmed echo", async () => {
    // Control: the confirmation outdates only work that began before it.
    const { pane, entry, loader, ownWrites, refresh } = await setup("saved text", "saved text");
    ownWrites.mark(FILE, "saved text");
    expect(await refresh("saved text", [FILE])).toBe(false);
    const newer = loader.refreshFromDisk(entry, "root-0", [`${ROOT}/partials/inc.adoc`]);
    await new Promise((r) => setTimeout(r, 0));
    readRejecters[1]!(new Error("newer include read failed"));
    await newer;
    expect(pane.html()).toContain("newer include read failed");
  });

  it("an echo that did not confirm the preview (edit conversion failed) does not mute an older failure", async () => {
    // Control: the echo converted again instead of confirming; the older
    // event's failure is dropped by the claim of that conversion, not by the
    // confirmation, so the confirmation must stay unset here.
    const { pane, entry, loader, ownWrites, reflects, refresh } = await setup("saved text", "saved text");
    ownWrites.mark(FILE, "saved text");
    reflects.value = false;
    const older = loader.refreshFromDisk(entry, "root-0", [`${ROOT}/partials/inc.adoc`]);
    await new Promise((r) => setTimeout(r, 0));
    await refresh("saved text", [FILE]);
    expect(pane.html()).toBe("<p>saved text</p>");
    readRejecters[0]!(new Error("old include read failed"));
    await older;
    expect(pane.html()).toBe("<p>saved text</p>");
  });

  it("records the error it publishes, so the next echo of that text converts again", async () => {
    // The state skips an echo only for a preview of the saved text on screen:
    // an error published by the loader must say so. Mutation captured: a
    // publication that does not call `notePreviewFailed`.
    const { pane, entry, loader, failed } = await setup("saved text", "saved text");
    const older = loader.refreshFromDisk(entry, "root-0", [`${ROOT}/partials/inc.adoc`]);
    await new Promise((r) => setTimeout(r, 0));
    readRejecters[0]!(new Error("include read failed"));
    await older;
    expect(pane.html()).toContain("include read failed");
    expect(failed).toEqual([{ path: "doc.adoc", tabId: undefined }]);
  });

  it("records that the screen was cleared, under the tab's own id, when a tab loads another file", async () => {
    // The tab just opened is not the active one yet: the record names it.
    // Mutation captured: a load that blanks the preview without telling the
    // state leaves the record of the previous HTML for that document.
    const { pane, loader, failed } = await setup("saved text", "saved text");
    const other = { kind: "file" as const, name: "other.adoc", path: "other.adoc" };
    const load = loader.loadTabContent(pane, other, { id: "tab-x", rootId: "root-0" });
    await new Promise((r) => setTimeout(r, 0));
    expect(pane.html()).toBe("");
    expect(failed).toEqual([{ path: "other.adoc", tabId: "tab-x" }]);
    await load; // the tab is not the active one: the load drops itself before reading
  });

  it("records the unsupported notice it publishes for a file that cannot be read as text", async () => {
    const { pane, entry, loader, failed } = await setup("saved text", "saved text", "doc.bin");
    const refresh = loader.refreshFromDisk(entry, "root-0", [`${ROOT}/doc.bin`]);
    await new Promise((r) => setTimeout(r, 0));
    readRejecters[0]!(new Error("stream did not contain valid UTF-8"));
    await refresh;
    expect(pane.html()).not.toBe("<p>already rendered</p>");
    expect(failed).toEqual([{ path: "doc.bin", tabId: undefined }]);
  });

  it("does not confirm an echo when an error was published while its preview was being checked", async () => {
    // The older event fails inside the window between the echo's check of the
    // preview and its confirmation: the error is on screen, so the echo
    // converts again. Mutation captured: confirming without the comparison of
    // `errorsPublished` leaves the error on screen.
    const { pane, entry, loader, ownWrites, gate, asked, conversions } = await setup("saved text", "saved text");
    ownWrites.mark(FILE, "saved text");
    let release!: () => void;
    gate.wait = new Promise<void>((resolve) => { release = resolve; });
    const older = loader.refreshFromDisk(entry, "root-0", [`${ROOT}/partials/inc.adoc`]);
    await new Promise((r) => setTimeout(r, 0));
    const echo = loader.refreshFromDisk(entry, "root-0", [FILE]);
    await new Promise((r) => setTimeout(r, 0));
    readResolvers[1]!("saved text");
    while (asked.length === 0) await new Promise((r) => setTimeout(r, 0)); // the check is open
    readRejecters[0]!(new Error("old include read failed"));
    await older;
    expect(pane.html()).toContain("old include read failed");
    release();
    await echo;
    expect(conversions()).toBe(1);
    expect(pane.html()).toBe("<p>saved text</p>");
  });

  it("asks about the text the preview was rendered from, not a text typed after the save", async () => {
    const { ownWrites, asked, conversions, refresh } = await setup("saved text", "saved text and more");
    ownWrites.mark(FILE, "saved text");
    await refresh("saved text", [FILE]);
    expect(asked).toEqual(["saved text and more"]);
    expect(conversions()).toBe(0);
  });

  it("still skips when the user typed after the save (the edit has its own conversion)", async () => {
    const { pane, ownWrites, conversions, refresh } = await setup("saved text", "saved text and more");
    ownWrites.mark(FILE, "saved text");
    expect(await refresh("saved text", [FILE])).toBe(false);
    expect(conversions()).toBe(0);
    expect(pane.editorContent()).toBe("saved text and more");
  });

  it("converts when the event also names an include", async () => {
    // Mutation captured: checking only that the main path is present (some
    // instead of every) skips a refresh that an include change needs.
    const { ownWrites, conversions, refresh } = await setup("saved text", "saved text");
    ownWrites.mark(FILE, "saved text");
    await refresh("saved text", [FILE, `${ROOT}/partials/inc.adoc`]);
    expect(conversions()).toBe(1);
  });

  it("converts when the event names only an include", async () => {
    const { ownWrites, conversions, refresh } = await setup("saved text", "saved text");
    ownWrites.mark(FILE, "saved text");
    await refresh("saved text", [`${ROOT}/partials/inc.adoc`]);
    expect(conversions()).toBe(1);
  });

  it.each([
    ["no paths in the event", undefined],
    ["an empty path list", [] as string[]],
  ])("converts with %s", async (_label, paths) => {
    const { ownWrites, conversions, refresh } = await setup("saved text", "saved text");
    ownWrites.mark(FILE, "saved text");
    await refresh("saved text", paths);
    expect(conversions()).toBe(1);
  });

  it("converts when the disk text is not the one we wrote", async () => {
    // Mutation captured: comparing paths only (no content hash) skips a
    // rewrite by another program that happens to land on the same path.
    const { ownWrites, conversions, refresh } = await setup("saved text", "saved text");
    ownWrites.mark(FILE, "text we wrote earlier");
    await refresh("saved text", [FILE]);
    expect(conversions()).toBe(1);
  });

  it("converts when nothing was recorded for the path (autosave off, manual edit elsewhere)", async () => {
    const { conversions, refresh } = await setup("saved text", "saved text");
    await refresh("saved text", [FILE]);
    expect(conversions()).toBe(1);
  });

  it("converts when the mark is for another file", async () => {
    const { ownWrites, conversions, refresh } = await setup("saved text", "saved text");
    ownWrites.mark("/tmp/ws/other.adoc", "saved text");
    await refresh("saved text", [FILE]);
    expect(conversions()).toBe(1);
  });

  it("an external change is adopted and converted even when the event names only this path", async () => {
    const { pane, ownWrites, conversions, refresh } = await setup("saved text", "saved text");
    ownWrites.mark(FILE, "saved text");
    expect(await refresh("changed elsewhere", [FILE])).toBe(true);
    expect(conversions()).toBe(1);
    expect(pane.editorContent()).toBe("changed elsewhere");
  });

  it("a loader without ownWrites (autosave not wired) keeps converting every event", async () => {
    // Control for the mark: same event, same disk, no store.
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    const entry = { kind: "file" as const, name: "doc.adoc", path: "doc.adoc" };
    pane.setSelectedRootId("root-0");
    pane.setSelectedFile(entry);
    pane.setSavedContent("same");
    pane.setEditorContent("same");
    let conversions = 0;
    const state = {
      paneManager, pushNavHistory: () => {}, autoRefresh: () => false,
      convert: async () => { conversions++; return { html: "", frontmatter: null, toc: null, meta: {} }; },
      registerReader: () => {},
      previewReflects: async () => true,
      notePreviewed: () => {},
      notePreviewFailed: () => {},
    } as unknown as AppState;
    const watcher = { setTarget: () => {}, start: () => {}, stop: () => {}, destroy: () => {} } as unknown as Parameters<typeof import("./file-loader.ts").createFileLoader>[0]["watcher"];
    const { createFileLoader } = await import("./file-loader.ts");
    const loader = createFileLoader({ rootPaths: () => new Map([["root-0", ROOT]]), state, watcher });
    readResolvers = [];
    readRejecters = [];
    const done = loader.refreshFromDisk(entry, "root-0", [FILE]);
    await new Promise((r) => setTimeout(r, 0));
    resolveRead!("same");
    await done;
    expect(conversions).toBe(1);
  });
});

describe("createFileLoader / nested include reads", () => {
  beforeEach(() => {
    resolveRead = undefined;
    rejectRead = undefined;
    readFileByPathMock = async () => null;
    readFilesRelativeMock = async () => new Map<string, string>();
    localStorage.clear();
  });

  // main -> p0..p3 (direct), each p<i> -> n<i> (nested), n2 is missing on disk.
  const disk: Record<string, string> = {};
  for (let i = 0; i < 4; i++) {
    disk[`p${i}.adoc`] = `include::n${i}.adoc[]`;
    if (i !== 2) disk[`n${i}.adoc`] = `leaf ${i}`;
  }
  const MAIN = "include::p0.adoc[]\ninclude::p1.adoc[]\ninclude::p2.adoc[]\ninclude::p3.adoc[]\n";

  async function load(opts: { failBatchAfter?: number } = {}) {
    readResolvers = [];
    readRejecters = [];
    const { collectIncludes } = await import("@markdraw/core/asciidoc.ts");
    const batches: string[][] = [];
    const singles: string[] = [];
    let batchCalls = 0;
    readFilesRelativeMock = async (_root, paths) => {
      batchCalls++;
      if (opts.failBatchAfter !== undefined && batchCalls > opts.failBatchAfter) throw new Error("ipc down");
      batches.push([...paths]);
      return new Map(paths.filter((p) => p in disk).map((p) => [p, disk[p]!]));
    };
    readFileByPathMock = async (_root, rel) => {
      singles.push(rel);
      return disk[rel] ?? null;
    };
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    let included: string[] = [];
    const registered: Array<{ readFile: (p: string) => Promise<string | null>; readFiles: (p: string[]) => Promise<ReadonlyMap<string, string | null>> }> = [];
    const state = {
      paneManager,
      pushNavHistory: () => {},
      autoRefresh: () => false,
      convert: async (_path: string, content: string, readFile: (p: string) => Promise<string | null>, readFiles?: never) => {
        included = [...(await collectIncludes(content, "", readFile, new Set(), readFiles)).keys()];
        return { html: "<p>ok</p>", frontmatter: null, toc: null, meta: {} };
      },
      registerReader: (_pane: unknown, _root: unknown, _path: unknown, reader: never) => { registered.push(reader); },
      previewReflects: async () => true,
      notePreviewed: () => {},
      notePreviewFailed: () => {},
    } as unknown as AppState;
    const targets: Array<{ includePaths: string[] }> = [];
    const watcher = {
      setTarget: (t: { includePaths: string[] }) => { targets.push(t); },
      start: () => {}, stop: () => {}, destroy: () => {},
    } as unknown as Parameters<typeof import("./file-loader.ts").createFileLoader>[0]["watcher"];
    const { createFileLoader } = await import("./file-loader.ts");
    const loader = createFileLoader({ rootPaths: () => new Map([["root-0", "/ws"]]), state, watcher });
    const done = loader.loadFileContent({ kind: "file", name: "main.adoc", path: "main.adoc" }, false, false, "root-0");
    await new Promise((r) => setTimeout(r, 0));
    resolveRead!(MAIN);
    await done;
    return { batches, singles, included: () => included, targets, pane, registered };
  }

  it("reads the nested layer in one batch, never file by file", async () => {
    // Mutation captured: a readFiles that loops readFile (or no readFiles
    // handed to convert) turns the second layer back into 3 single reads.
    const { batches, singles, included, targets } = await load();
    expect(batches).toEqual([
      ["p0.adoc", "p1.adoc", "p2.adoc", "p3.adoc"], // the loader's pre-scan
      ["n0.adoc", "n1.adoc", "n2.adoc", "n3.adoc"], // layer 1, one IPC
    ]);
    expect(singles).toEqual([]);
    // n2 is gone: p2 stays included, its missing child does not
    expect(included().sort()).toEqual(["n0.adoc", "n1.adoc", "n3.adoc", "p0.adoc", "p1.adoc", "p2.adoc", "p3.adoc"]);
    // the nested files the batch found are watched too
    expect(targets.at(-1)!.includePaths).toContain("n3.adoc");
    expect(targets.at(-1)!.includePaths).not.toContain("n2.adoc");
  });

  it("falls back to reading one by one when the batch IPC fails, and says why", async () => {
    const warn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...a: unknown[]) => { warnings.push(a); };
    try {
      const { singles, included } = await load({ failBatchAfter: 1 });
      expect(singles.sort()).toEqual(["n0.adoc", "n1.adoc", "n2.adoc", "n3.adoc"]);
      expect(included().sort()).toEqual(["n0.adoc", "n1.adoc", "n3.adoc", "p0.adoc", "p1.adoc", "p2.adoc", "p3.adoc"]);
      expect(String(warnings[0]?.[0])).toContain("Batch include read failed");
    } finally {
      console.warn = warn;
    }
  });

  it("serves cached files from the registered reader without another IPC", async () => {
    const { batches, singles, registered } = await load();
    const reader = registered.at(-1)!;
    const again = await reader.readFiles(["p0.adoc", "n1.adoc"]);
    expect([...again.entries()]).toEqual([["p0.adoc", "include::n0.adoc[]"], ["n1.adoc", "leaf 1"]]);
    expect(await reader.readFile("n3.adoc")).toBe("leaf 3");
    expect(batches).toHaveLength(2);
    expect(singles).toEqual([]);
  });
});
