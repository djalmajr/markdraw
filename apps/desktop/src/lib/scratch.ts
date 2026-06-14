// Ephemeral "scratch" documents: a blank doc you can edit immediately without
// choosing a location, that exists ONLY in memory until you explicitly save it.
//
// Design: a scratch is an in-memory buffer — NO file on disk and NO sidebar
// folder. It's a tab whose `rootId` is the SCRATCH_ROOT_ID sentinel (never added
// to the real rootPaths map) and whose file `path` uses the `scratch://` scheme.
// Because the sentinel root isn't a real workspace path, the loader, autosave,
// and file watcher all naturally no-op for scratch tabs, and the sidebar never
// shows it. Markdown/AsciiDoc content lives in the tab's editor buffer; an
// Excalidraw scene is held in host memory (see `scratchScenes` in app.tsx). Disk
// is touched only on an explicit Save (save-as).

import type { FSEntry } from "@asciimark/core/types.ts";

export type ScratchKind = "markdown" | "asciidoc" | "excalidraw";

/** Sentinel rootId for in-memory scratch tabs. Never enters the rootPaths map. */
export const SCRATCH_ROOT_ID = "__scratch__";

const EXT: Record<ScratchKind, string> = {
  markdown: "md",
  asciidoc: "adoc",
  excalidraw: "excalidraw",
};

/** Sentinel path for a scratch doc, e.g. `scratch://Untitled-1.md`. Keeps the
 *  extension so `fileKind()` still resolves the right editor/viewer. */
export function scratchPath(name: string): string {
  return `scratch://${name}`;
}

export function isScratchPath(path: string | undefined | null): boolean {
  return typeof path === "string" && path.startsWith("scratch://");
}

// Monotonic per-session counter so successive scratches get distinct names.
let counter = 0;

/** A fresh sentinel FSEntry for a new scratch of the given kind. */
export function makeScratchEntry(kind: ScratchKind): FSEntry {
  counter += 1;
  const name = `Untitled-${counter}.${EXT[kind]}`;
  return { name, kind: "file", path: scratchPath(name) };
}
