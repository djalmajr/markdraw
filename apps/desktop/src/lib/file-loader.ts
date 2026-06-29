import type { Accessor } from "solid-js";
import type { FSEntry } from "@markdraw/core/types.ts";
import { getIncludePaths } from "@markdraw/core/asciidoc.ts";
import { getMarkdownIncludePaths } from "@markdraw/core/markdown.ts";
import { fileKind, isMdFile, isSupportedFile, UNSUPPORTED_CONTENT } from "@markdraw/core/utils.ts";
import type { AppState } from "@markdraw/ui/composables/create-app-state.ts";
import {
  readFileByPath,
  readFileContent,
  readFilesRelative,
} from "./fs.ts";
import type { FileWatcher } from "./watcher.ts";

interface FileLoaderDeps {
  rootPaths: Accessor<Map<string, string>>;
  state: AppState;
  watcher: FileWatcher;
}

export function createFileLoader(deps: FileLoaderDeps) {
  const { rootPaths, state, watcher } = deps;

  async function loadFileContent(entry: FSEntry, pushHistory = true, force = false, rootId?: string) {
    // Pin the target pane at call time. AppState's per-doc setters
    // (setHtml, setEditorContent, …) are proxies that route to
    // `paneManager.activePane()` on each call — without pinning, a
    // pane switch between this function's await points would route
    // the convert result to the wrong pane (the original symptom:
    // "intro.adoc shows blank preview" when the user clicked another
    // pane mid-conversion). Writing directly to the captured pane
    // keeps the load atomic from the user's perspective: the file
    // they asked for lands where they asked for it.
    const targetPane = state.paneManager.activePane();
    const targetRootId = rootId ?? targetPane.selectedRootId();
    const root = targetRootId ? rootPaths().get(targetRootId) : null;
    if (!root || entry.kind !== "file") return;
    const isSameFile =
      targetPane.selectedFile()?.path === entry.path
      && targetPane.selectedRootId() === targetRootId;
    if (!force && isSameFile) return;

    targetPane.setSelectedRootId(targetRootId);
    targetPane.setSelectedFile(entry);
    if (!isSameFile) {
      targetPane.setHtml("");
    }
    targetPane.setLoading(true);

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
      void watcher.stop();
      targetPane.setLoading(false);
      return;
    }

    // Yield to let the UI render loading state before heavy conversion
    await new Promise((r) => setTimeout(r, 0));

    try {
      const absolutePath = `${root}/${entry.path}`;
      let content: string;
      try {
        content = await readFileContent(absolutePath);
      } catch (readErr) {
        // read_file (read_to_string) throws on non-UTF8 input. A binary
        // that isn't an image/PDF (handled above) can be neither rendered
        // nor edited as text → mark it unsupported so PaneView shows the
        // notice. A *document* that fails to read is a real error — rethrow
        // to the outer catch.
        if (isSupportedFile(entry.path)) throw readErr;
        targetPane.setHtml(UNSUPPORTED_CONTENT);
        targetPane.setFrontmatter(null);
        targetPane.setEditorContent("");
        targetPane.setSavedContent("");
        void watcher.stop();
        return;
      }

      // Non-previewable text (json, txt, yaml, …) skips conversion entirely
      // and opens straight in the editor. The createEffect in app state
      // forces "edit" mode because canPreview() is false for these.
      if (!isSupportedFile(entry.path)) {
        targetPane.setHtml("");
        targetPane.setFrontmatter(null);
        targetPane.setEditorContent(content);
        targetPane.setSavedContent(content);
        watcher.setTarget({ filePath: absolutePath, includePaths: [], rootPath: root });
        if (state.autoRefresh()) watcher.start();
        return;
      }

      // Pre-scan include paths and batch-read them in a single IPC call
      const baseDirForIncludes = entry.path.includes("/")
        ? entry.path.substring(0, entry.path.lastIndexOf("/"))
        : "";
      const scanPaths = isMdFile(entry.path)
        ? getMarkdownIncludePaths(content, baseDirForIncludes)
        : getIncludePaths(content, baseDirForIncludes);

      let includeFileCache: Map<string, string> | null = null;
      if (scanPaths.length > 0) {
        includeFileCache = await readFilesRelative(root, scanPaths);
      }

      const readFile = async (relPath: string) => {
        const cached = includeFileCache?.get(relPath);
        if (cached !== undefined) return cached;

        const fileContent = await readFileByPath(root, relPath);
        if (fileContent !== null) {
          includeFileCache?.set(relPath, fileContent);
        }
        return fileContent;
      };

      state._readFile = readFile;

      const result = await state.convert(entry.path, content, readFile);

      // Yield again before DOM update to prevent long frame
      await new Promise((r) => setTimeout(r, 0));

      targetPane.setHtml(result.html);
      targetPane.setFrontmatter(result.frontmatter);
      targetPane.setEditorContent(content);
      targetPane.setSavedContent(content);

      const includePaths = includeFileCache
        ? Array.from(new Set([...scanPaths, ...includeFileCache.keys()]))
        : scanPaths;

      watcher.setTarget({
        filePath: absolutePath,
        includePaths,
        rootPath: root,
      });

      if (state.autoRefresh()) {
        watcher.start();
      }
    } catch (e) {
      console.error("Failed to convert file:", e);
      targetPane.setHtml(`<div class="error">Error converting file: ${e}</div>`);
    } finally {
      targetPane.setLoading(false);
    }
  }

  return { loadFileContent };
}
