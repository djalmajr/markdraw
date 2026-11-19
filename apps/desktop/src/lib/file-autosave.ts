import { createEffect, onCleanup } from "solid-js";
import type { AppState } from "@markdraw/ui/composables/create-app-state.ts";

export function createFileAutosave(
  state: Pick<AppState, "paneManager">,
  save: () => Promise<void>,
  reindex: () => void,
  isTabSwitching: () => boolean,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => clearTimeout(timer);

  createEffect(
    () => {
      const pane = state.paneManager.activePane();
      return {
        pane,
        content: pane.editorContent(),
        mode: pane.editorMode(),
        file: pane.selectedFile(),
        rootId: pane.selectedRootId(),
      };
    },
    ({ pane, mode, file, rootId }) => {
      cancel();
      if (isTabSwitching() || mode === "preview" || !file) return;
      timer = setTimeout(() => {
        if (isTabSwitching() || state.paneManager.activePane() !== pane) return;
        if (pane.selectedFile() !== file || pane.selectedRootId() !== rootId) return;
        // Watcher reloads and undo can leave the working buffer equal to the
        // last save. Rewriting it could overwrite a newer external change.
        if (pane.editorContent() === pane.savedContent()) return;
        void save().then(reindex);
      }, 1000);
    },
  );

  onCleanup(cancel);
  return cancel;
}
