import type { Accessor } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import { getIncludePaths } from "@asciimark/core/asciidoc.ts";
import { getMarkdownIncludePaths } from "@asciimark/core/markdown.ts";
import { isMdFile } from "@asciimark/core/utils.ts";
import type { AppState } from "@asciimark/ui/composables/create-app-state.ts";
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
    const targetRootId = rootId ?? state.selectedRootId();
    const root = targetRootId ? rootPaths().get(targetRootId) : null;
    if (!root || entry.kind !== "file") return;
    const isSameFile = state.selectedFile()?.path === entry.path && state.selectedRootId() === targetRootId;
    if (!force && isSameFile) return;

    state.setSelectedRootId(targetRootId);
    state.setSelectedFile(entry);
    if (!isSameFile) {
      state.setHtml("");
    }
    state.setLoading(true);

    if (pushHistory) {
      state.pushNavHistory({
        entry,
        rootId: targetRootId!,
      });
    }

    // Yield to let the UI render loading state before heavy conversion
    await new Promise((r) => setTimeout(r, 0));

    try {
      const absolutePath = `${root}/${entry.path}`;
      const content = await readFileContent(absolutePath);

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

      const readFile = includeFileCache
        ? (relPath: string) => Promise.resolve(includeFileCache!.get(relPath) ?? null)
        : (relPath: string) => readFileByPath(root, relPath);

      state._readFile = readFile;

      const result = await state.convert(entry.path, content, readFile);

      // Yield again before DOM update to prevent long frame
      await new Promise((r) => setTimeout(r, 0));

      state.setHtml(result.html);
      state.setFrontmatter(result.frontmatter);
      state.setEditorContent(content);
      state.setSavedContent(content);

      const baseDirPath = entry.path.includes("/")
        ? entry.path.substring(0, entry.path.lastIndexOf("/"))
        : "";
      const includePaths = isMdFile(entry.path)
        ? getMarkdownIncludePaths(content, baseDirPath)
        : getIncludePaths(content, baseDirPath);

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
      state.setHtml(`<div class="error">Error converting file: ${e}</div>`);
    } finally {
      state.setLoading(false);
    }
  }

  return { loadFileContent };
}
