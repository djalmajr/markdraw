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
  /** The file changed elsewhere and the buffer has no unsaved edits, or the
   *  disk already holds exactly the buffer: adopt it (clears the dirty mark). */
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
  if (state.current === state.saved || state.disk === state.current) return "reload";
  return "keep-local";
}

// ── Echo of our own write ───────────────────────────────────────────────────
//
// Every autosave also fires a watcher event, and the refresh it triggers used
// to convert the whole document again (see file-loader.ts). The autosave
// remembers what it wrote — path plus a hash of the content — and a refresh
// skips the conversion only when the event names nothing but that path and the
// disk still holds exactly the written text. An include path in the event, a
// different disk text, or an event without paths all convert as before.

/** SHA-256 of the text, hex-encoded. */
export async function hashContent(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface OwnWrites {
  /** Remember `content` as the text just written to `path` (absolute). The
   *  hash is stored as a promise, so a watcher event that arrives before the
   *  digest settles still waits for it instead of missing the mark. */
  mark(path: string, content: string): void;
  /** True when the last mark for `path` has this content hash. */
  matches(path: string, contentHash: string): Promise<boolean>;
  /** Forget `path` (the file was deleted, renamed or moved). */
  forget(path: string): void;
  /** Counts every `mark`, so a reader can tell that a save began after it
   *  started reading: the disk text it holds may predate that save. */
  revision(): number;
}

export function createOwnWrites(limit = 64): OwnWrites {
  const marks = new Map<string, Promise<string>>();
  let revision = 0;
  return {
    mark(path, content) {
      revision++;
      marks.delete(path); // re-insert so the oldest entry is the first key
      marks.set(path, hashContent(content));
      while (marks.size > limit) marks.delete(marks.keys().next().value!);
    },
    async matches(path, contentHash) {
      const mark = marks.get(path);
      if (!mark) return false;
      try {
        return (await mark) === contentHash;
      } catch {
        marks.delete(path);
        return false;
      }
    },
    forget(path) {
      marks.delete(path);
    },
    revision() {
      return revision;
    },
  };
}

/** True when a watcher event is only the echo of our own write to `filePath`:
 *  it names that path and nothing else. An event without paths (or a payload
 *  the bridge could not read) is never an echo. */
export function eventIsOnly(filePath: string, eventPaths: readonly string[] | undefined): boolean {
  return !!eventPaths && eventPaths.length > 0 && eventPaths.every((p) => p === filePath);
}
