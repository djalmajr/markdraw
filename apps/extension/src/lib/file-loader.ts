import type { Accessor } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import { getIncludePaths } from "@asciimark/core/asciidoc.ts";
import { getMarkdownIncludePaths } from "@asciimark/core/markdown.ts";
import { isMdFile } from "@asciimark/core/utils.ts";
import type { AppState } from "@asciimark/ui/composables/create-app-state.ts";
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
  state: AppState;
  watcher: FileWatcher;
}

export function createFileLoader(deps: FileLoaderDeps) {
  const { fallbackFileMap, rootHandle, state, watcher } = deps;

  async function loadFileContent(entry: FSEntry, pushHistory = true, force = false) {
    const root = rootHandle();
    const fileMap = fallbackFileMap();
    const isFallback = !root && !!fileMap;
    const hasDirectHandle = !root && !fileMap && (entry.handle || entry.file);

    if (!root && !fileMap && !hasDirectHandle) return;
    if (entry.kind !== "file") return;
    if (!force && state.selectedFile()?.path === entry.path) return;

    state.setSelectedFile(entry);
    state.setLoading(true);
    state.setHtml("");
    state.clearToc();

    if (pushHistory) {
      setHashFromPath(entry.path);
      state.pushNavHistory({
        entry,
      });
    }

    try {
      const content = entry.file
        ? await readFileContent(entry.file as File)
        : await readFileContent(entry.handle as FileSystemFileHandle);

      // Build readFile function for include:: resolution
      const readFile = isFallback
        ? (path: string) => readFileByPathFallback(fileMap!, path)
        : root
          ? (path: string) => readFileByPath(root, path)
          : () => Promise.resolve(null);

      // Store readFile on state so AppShell editor onChange can use it
      state._readFile = readFile;

      const result = await state.convert(entry.path, content, readFile);

      state.setHtml(result);
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
