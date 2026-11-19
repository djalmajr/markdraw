import { createEffect, onCleanup } from "solid-js";
import { effectivePaneEditorMode, type AppState } from "@markdraw/ui/composables/create-app-state.ts";
import type { OwnWrites } from "./external-reload.ts";

export function createFileAutosave(
  state: Pick<AppState, "paneManager">,
  save: () => Promise<void>,
  reindex: () => void,
  /** Records what each save writes (absolute path + content hash), so the
   *  watcher event that echoes it does not convert the document again. */
  echo?: { writes: OwnWrites; rootPath: (rootId: string | null) => string | undefined },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => clearTimeout(timer);

  createEffect(
    () => {
      const pane = state.paneManager.activePane();
      return {
        pane,
        content: pane.editorContent(),
        // The mode the editor shows: plain text without a preview edits even
        // while the pane's stored mode is still "preview".
        mode: effectivePaneEditorMode(pane),
        file: pane.selectedFile(),
        rootId: pane.selectedRootId(),
        tab: pane.tabs.getActiveTab(),
      };
    },
    ({ pane, mode, file, rootId, tab }) => {
      cancel();
      if (tab?.needsLoad || mode === "preview" || !file) return;
      timer = setTimeout(() => {
        if (state.paneManager.activePane() !== pane || pane.tabs.getActiveTab()?.needsLoad) return;
        if (pane.tabs.activeTabId() !== (tab?.id ?? null)) return;
        if (pane.selectedFile() !== file || pane.selectedRootId() !== rootId) return;
        // Watcher reloads and undo can leave the working buffer equal to the
        // last save. Rewriting it could overwrite a newer external change.
        if (pane.editorContent() === pane.savedContent()) return;
        // What this save writes: `save` reads the buffer synchronously, in this
        // same tick, so the content captured here is the one that reaches disk.
        const rootPath = echo?.rootPath(rootId);
        if (echo && rootPath) echo.writes.mark(`${rootPath}/${file.path}`, pane.editorContent());
        void save().then(reindex);
      }, 1000);
    },
  );

  onCleanup(cancel);
  return cancel;
}
