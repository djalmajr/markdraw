import type { Accessor } from "solid-js";
import type { FSEntry } from "@markdraw/core/types.ts";
import { getIncludePaths } from "@markdraw/core/asciidoc.ts";
import { getMarkdownIncludePaths } from "@markdraw/core/markdown.ts";
import { isMdFile, isSupportedFile } from "@markdraw/core/utils.ts";
import type { AppState } from "@markdraw/ui/composables/create-app-state.ts";
import { setHashFromPath } from "./hash.ts";
import {
  readFileContent,
  readFileByPath,
  readFileByPathFallback,
} from "./fs.ts";
import type { FileWatcher } from "./watcher.ts";

interface FileLoaderDeps {
  fallbackFileMap: Accessor<Map<string, File> | null>;
  rootHandle: Accessor<FileSystemDirectoryHandle | null>;
  rootHandles: Accessor<Map<string, FileSystemDirectoryHandle>>;
  state: AppState;
  watcher: FileWatcher;
}

export function createFileLoader(deps: FileLoaderDeps) {
  const { fallbackFileMap, rootHandle, rootHandles, state, watcher } = deps;

  async function loadFileContent(entry: FSEntry, pushHistory = true, force = false, rootId?: string) {
    const targetRootId = rootId ?? state.selectedRootId();
    const root = targetRootId ? rootHandles().get(targetRootId) ?? rootHandle() : rootHandle();
    const fileMap = fallbackFileMap();
    const isFallback = !root && !!fileMap;
    const hasDirectHandle = !root && !fileMap && (entry.handle || entry.file);

    if (!root && !fileMap && !hasDirectHandle) return;
    if (entry.kind !== "file") return;
    const isSameFile = state.selectedFile()?.path === entry.path && state.selectedRootId() === targetRootId;
    if (!force && isSameFile) return;

    // Set selected root when loading a file
    if (targetRootId) {
      state.setSelectedRootId(targetRootId);
    }

    state.setSelectedFile(entry);
    state.setLoading(true);
    if (!isSameFile) {
      state.setHtml("");
      state.clearToc();
    }

    if (pushHistory) {
      setHashFromPath(entry.path);
      state.pushNavHistory({
        entry,
        rootId: targetRootId ?? "",
      });
    }

    try {
      const content = entry.file
        ? await readFileContent(entry.file as File)
        : await readFileContent(entry.handle as FileSystemFileHandle);

      // Non-previewable formats (json, txt, yaml, …) skip conversion entirely
      // and open straight in the editor.
      if (!isSupportedFile(entry.path)) {
        state.setHtml("");
        state.setFrontmatter(null);
        state.setEditorContent(content);
        state.setSavedContent(content);
        return;
      }

      // Build readFile function for include:: resolution
      const readFile = isFallback
        ? (path: string) => readFileByPathFallback(fileMap!, path)
        : root
          ? (path: string) => readFileByPath(root, path)
          : () => Promise.resolve(null);

      // Store readFile on state so AppShell editor onChange can use it
      state._readFile = readFile;

      const result = await state.convert(entry.path, content, readFile);

      state.setHtml(result.html);
      state.setFrontmatter(result.frontmatter);
      state.setEditorContent(content);
      state.setSavedContent(content);

      // Update watcher target (only in native mode)
      if (!isFallback && root) {
        const baseDirPath = entry.path.includes("/")
          ? entry.path.substring(0, entry.path.lastIndexOf("/"))
          : "";
        const includePaths = isMdFile(entry.path)
          ? getMarkdownIncludePaths(content, baseDirPath)
          : getIncludePaths(content, baseDirPath);
        watcher.setTarget({
          fileHandle: entry.handle as FileSystemFileHandle,
          includePaths,
          rootHandle: root,
        });

        if (state.autoRefresh()) {
          watcher.start();
        }
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
