import { onCleanup, onMount } from "solid-js";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { FSEntry } from "@markdraw/core/types.ts";
import { isSupportedFile } from "@markdraw/core/utils.ts";
import type { AppState } from "@markdraw/ui/composables/create-app-state.ts";
import { readTree } from "./fs.ts";

interface TauriDndDeps {
  addRoot: (path: string) => Promise<boolean>;
  loadFileContent: (entry: FSEntry, pushHistory?: boolean, force?: boolean, rootId?: string) => Promise<void>;
  state: AppState;
}

export function setupTauriDnd(deps: TauriDndDeps) {
  const { addRoot, loadFileContent, state } = deps;

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
          const entries = await readTree(droppedPath, state.showHiddenEntries());
          if (entries.length > 0) {
            await addRoot(droppedPath);
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
          const opened = await addRoot(parentDir);
          if (opened) {
            const entry: FSEntry = { name: fileName, kind: "file", path: fileName };
            state.pushRecentFile({
              entry,
              rootName: state.rootName(),
              rootPath: parentDir,
            });
            await loadFileContent(entry, true, false, parentDir);
          }
        }
      }
    });

    onCleanup(() => {
      unlisten.then((fn) => fn());
    });
  });
}
