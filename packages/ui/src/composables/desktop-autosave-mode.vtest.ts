import { createRoot, createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createFileAutosave } from "../../../../apps/desktop/src/lib/file-autosave.ts";
import { createFileLoader } from "../../../../apps/desktop/src/lib/file-loader.ts";
import { createFolder } from "../../../../apps/desktop/src/lib/folder.ts";
import { createTabActions } from "../../../../apps/desktop/src/lib/tab-actions.ts";
import { FileWatcher } from "../../../../apps/desktop/src/lib/watcher.ts";
import { createAppState } from "./create-app-state.ts";
import { createPaneManager } from "./create-pane-manager.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// A plain text file has no preview, so the editor shows it in "edit" while
// the pane's stored mode is still "preview". Autosave must follow the mode
// the editor shows, or edits to such files stay only in the buffer.
it("autosaves plain text while the pane's stored mode is preview", async () => {
  const root = "/autosave-workspace";
  const file = { kind: "file" as const, path: "notes.txt", name: "notes.txt" };
  const disk = new Map([[`${root}/notes.txt`, "on disk"]]);
  const writes: unknown[] = [];
  vi.stubGlobal("__TAURI_INTERNALS__", {
    transformCallback: () => 1,
    invoke: async (command: string, args: Record<string, string>) => {
      if (command === "read_dir") return [file];
      if (command === "read_file") return disk.get(args.path);
      if (command === "write_file") {
        writes.push(args);
        disk.set(args.path, args.content);
      }
      if (command === "plugin:event|listen") return 1;
      return undefined;
    },
  });
  vi.stubGlobal("__TAURI_EVENT_PLUGIN_INTERNALS__", { unregisterListener: vi.fn() });
  const watcher = new FileWatcher(() => {});
  const app = createRoot((dispose) => {
    const paneManager = createPaneManager({
      onTabSelected: (pane, tab) => { void actions.selectTab(pane, tab); },
    });
    const state = createAppState({
      paneManager,
      getStoredTheme: () => "system",
      applyTheme: () => {},
      convertAdoc: async ({ fileContent }) => ({ html: fileContent, frontmatter: null, toc: null, meta: {} }),
      convertMarkdown: async ({ fileContent }) => ({ html: fileContent, frontmatter: null, toc: null, meta: {} }),
    });
    const [rootPaths, setRootPaths] = createSignal(new Map<string, string>());
    const loader = createFileLoader({ state, rootPaths, watcher });
    const actions = createTabActions({
      state,
      rootPaths,
      syncWatcher: loader.syncWatcher,
      loadFileContent: loader.loadFileContent,
      loadTabContent: loader.loadTabContent,
    });
    const folder = createFolder({ state, rootPaths, setRootPaths, watcher, onRootClosed: actions.closeRootTabs });
    createFileAutosave(state, folder.handleEditorSave, () => {});
    return { actions, folder, paneManager, state, dispose };
  });
  try {
    expect(await app.folder.openFolderPath(root)).toBe(true);
    await app.actions.openFile(file, root, true);
    flush();
    const pane = app.paneManager.activePane();
    expect(pane.editorMode()).toBe("preview");
    expect(app.state.editorMode()).toBe("edit");

    vi.useFakeTimers();
    app.state.debouncedConvert("edited plain text", file.path, async () => null);
    flush();
    await vi.advanceTimersByTimeAsync(2000);

    expect(writes).toEqual([{ path: `${root}/notes.txt`, content: "edited plain text" }]);
    expect(disk.get(`${root}/notes.txt`)).toBe("edited plain text");
  } finally {
    app.dispose();
    await watcher.destroy();
  }
});
