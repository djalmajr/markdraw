/**
 * Pure workspace-path helpers for create/move operations. No Tauri/IO deps so
 * they stay unit-testable in isolation.
 */

/** Join a workspace-relative parent dir and a child name (no leading slash;
 *  a trailing slash on the parent is collapsed). */
export function joinRelative(parentRel: string, name: string): string {
  const p = parentRel.replace(/\/+$/, "");
  return p ? `${p}/${name}` : name;
}

/** Default a name to `.md` when its basename carries no extension. Names like
 *  `data.json` or `sub/notes.md` are left as-is; `notas` → `notas.md`. */
export function withDefaultExtension(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  return base.includes(".") ? name : `${name}.md`;
}

/** Pick a collision-free name for a copy of `name` in a directory, given a
 *  predicate that reports whether a candidate name is already taken. Inserts
 *  ` (1)`, ` (2)`, … before the extension: `notes.md` → `notes (1).md`,
 *  `docs` → `docs (1)`. A directory's name is treated as having no extension
 *  (no dot split), so `my.dir` stays `my.dir (1)`. */
export function nextAvailableName(
  name: string,
  taken: (candidate: string) => boolean,
  isDirectory = false,
): string {
  if (!taken(name)) return name;
  const dot = isDirectory ? -1 : name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}
