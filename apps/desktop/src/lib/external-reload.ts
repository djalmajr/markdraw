// What a file-watcher refresh may do with the open buffer. Pure, so the rule
// is testable without a Tauri runtime or a real watcher.
//
// The watcher fires for every write to the open file, including the app's own
// autosave. Reloading blindly put the disk text back into the editor state:
// anything typed between the save and the reload (~500ms debounce) dropped out
// of the state, the preview went stale and the next autosave wrote the old
// text back.

export type ExternalReload =
  /** Disk matches the last save: our own write, or an included file changed.
   *  Keep the buffer; only re-render the preview from it. */
  | "rerender"
  /** The file changed elsewhere and the buffer has no unsaved edits: adopt it. */
  | "reload"
  /** The file changed elsewhere but there are unsaved edits: they win, and the
   *  next autosave writes them over the external change. */
  | "keep-local";

export function decideExternalReload(state: {
  disk: string;
  saved: string;
  current: string;
}): ExternalReload {
  if (state.disk === state.saved) return "rerender";
  if (state.current === state.saved) return "reload";
  return "keep-local";
}
