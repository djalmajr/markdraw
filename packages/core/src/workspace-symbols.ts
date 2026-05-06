/**
 * Workspace-wide symbol search — pure flattening, no I/O. The host
 * reads each `.md`/`.adoc` from the file index, hands `(path,
 * content)` pairs in, and gets back a flat list of symbols ready
 * to feed the palette.
 */

import { extractHeadings, type Heading } from "./headings.ts";
import { isSupportedFile } from "./utils.ts";

export interface WorkspaceSymbol {
  /** rootId so the host can disambiguate files from different roots
   *  with the same relative path. */
  rootId: string;
  /** Display name for the root (used as a column hint in the row). */
  rootName: string;
  /** Workspace-relative path of the file the heading lives in. */
  path: string;
  /** Last segment of `path` for compact display. */
  fileName: string;
  /** The heading itself — text, level, line. */
  heading: Heading;
}

export interface WorkspaceSymbolSource {
  rootId: string;
  rootName: string;
  path: string;
  content: string;
}

export function buildWorkspaceSymbols(
  files: readonly WorkspaceSymbolSource[],
): WorkspaceSymbol[] {
  const out: WorkspaceSymbol[] = [];
  for (const file of files) {
    if (!isSupportedFile(file.path)) continue;
    const headings = extractHeadings(file.path, file.content);
    for (const heading of headings) {
      out.push({
        rootId: file.rootId,
        rootName: file.rootName,
        path: file.path,
        fileName: file.path.includes("/")
          ? file.path.slice(file.path.lastIndexOf("/") + 1)
          : file.path,
        heading,
      });
    }
  }
  return out;
}

export function filterWorkspaceSymbols(
  query: string,
  symbols: readonly WorkspaceSymbol[],
): readonly WorkspaceSymbol[] {
  if (query === "") return symbols;
  const q = query.toLowerCase();
  return symbols.filter((s) => {
    if (s.heading.text.toLowerCase().includes(q)) return true;
    // Fallback to path match — lets the user scope the palette to
    // a single file by typing its name. Filename-first lookup
    // matches VSCode's "Symbols in Workspace" semantics.
    if (s.path.toLowerCase().includes(q)) return true;
    return false;
  });
}
