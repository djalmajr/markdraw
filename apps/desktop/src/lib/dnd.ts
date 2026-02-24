import type { Setter } from "solid-js";
import { onCleanup, onMount } from "solid-js";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { FSEntry } from "@asciimark/core/types.ts";
import { isSupportedFile } from "@asciimark/core/utils.ts";
import type { AppState } from "@asciimark/ui/composables/create-app-state.ts";
import { readTree } from "./fs.ts";

interface TauriDndDeps {
  loadFileContent: (entry: FSEntry, pushHistory?: boolean) => Promise<void>;
  setRootPath: Setter<string | null>;
  state: AppState;
}

export function setupTauriDnd(deps: TauriDndDeps) {
  const { loadFileContent, setRootPath, state } = deps;

  onMount(() => {
    const webview = getCurrentWebviewWindow();
    const unlisten = webview.onDragDropEvent(async (event) => {
      if (event.payload.type === "over") {
        state.setDragOver(true);
      } else if (event.payload.type === "leave") {
        state.setDragOver(false);
      } else if (event.payload.type === "drop") {
        state.setDragOver(false);
        const paths = event.payload.paths;
        if (!paths || paths.length === 0) return;

        const droppedPath = paths[0];
        try {
          // Try reading as directory first
          const entries = await readTree(droppedPath);
          if (entries.length > 0) {
            setRootPath(droppedPath);
            const parts = droppedPath.replace(/\\/g, "/").split("/");
            state.setRootName(parts[parts.length - 1] ?? droppedPath);
            state.setTree(entries);
            state.setSidebarVisible(true);
            state.setSelectedFile(null);
            state.setHtml("");
            state.setNavStack([]);
            state.setNavIndex(-1);
            state.pushRecentFolder(droppedPath);
            return;
          }
        } catch {
          // Not a directory or empty, try as file
        }

        // Handle as single file -- use its parent directory as root
        const normalized = droppedPath.replace(/\\/g, "/");
        const fileName = normalized.split("/").pop() ?? droppedPath;
        if (isSupportedFile(fileName)) {
          const parentDir = normalized.substring(0, normalized.lastIndexOf("/"));
          const entry: FSEntry = { name: fileName, kind: "file", path: fileName };
          setRootPath(parentDir);
          state.setRootName(parentDir.split("/").pop() ?? parentDir);
          state.setTree([entry]);
          state.setSidebarVisible(false);
          state.pushRecentFolder(parentDir);
          state.pushRecentFile({
            entry,
            rootName: state.rootName(),
            rootPath: parentDir,
          });
          loadFileContent(entry);
        }
      }
    });

    onCleanup(() => {
      unlisten.then((fn) => fn());
    });
  });
}
