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
      ) => {
        const topLevel = await readFile("business/_index.adoc");
        const nested = await readFile("business/01-visao-geral.adoc");
        return {
          html: `${topLevel ?? "missing top"}\n${nested ?? "missing nested"}`,
          frontmatter: null,
          toc: null,
          meta: {},
        };
      },
      set _readFile(_v: unknown) {},
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
      set _readFile(_v: unknown) {},
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
