/**
 * Backlink extraction & index — pure parsing, no I/O. The host walks
 * `flattenWorkspace`, reads each file, and feeds `(path, content)`
 * pairs into `buildBacklinkIndex`. The resulting Map answers "which
 * files link to X?" in O(1).
 *
 * Recognized link shapes:
 *   - markdown links: `[label](target.md)` or `[label](target.md#fragment)`
 *   - asciidoc xref:  `xref:target.adoc[...]`
 *   - asciidoc include: `include::target.adoc[]`
 *
 * Targets are normalized to the workspace path system (`/`-separated,
 * relative to the workspace root). Web URLs and protocol-prefixed
 * schemes (mailto:, tel:, javascript:, …) are dropped — they can't
 * be indexed.
 */

const MARKDOWN_LINK = /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const ASCIIDOC_XREF = /xref:([^[\s]+)\[/g;
const ASCIIDOC_INCLUDE = /^include::([^[\s]+)\[/gm;

/** Strip a `#fragment` suffix and reject obvious non-document targets. */
function normalizeTarget(raw: string, sourceFilePath: string): string | null {
  // Drop a fragment if present — backlinks key on file path only.
  const hashIdx = raw.indexOf("#");
  let target = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  if (!target) return null;

  // Reject anything that looks like a URL or protocol-prefixed link.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return null;
  // mailto:, tel:, ftp: — short protocol prefixes too.
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.includes("/")) return null;

  // Resolve relative segments (`..`, `.`) against the source file's
  // directory. Without this the index would store raw strings that
  // never match the canonical workspace paths.
  const sourceDir = sourceFilePath.includes("/")
    ? sourceFilePath.slice(0, sourceFilePath.lastIndexOf("/"))
    : "";
  if (target.startsWith("/")) {
    return target.replace(/^\/+/, "");
  }
  const dirParts = sourceDir ? sourceDir.split("/") : [];
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      dirParts.pop();
      continue;
    }
    dirParts.push(part);
  }
  target = dirParts.join("/");
  return target || null;
}

/** Parse `content` for outbound document links. Returns an array of
 *  workspace-relative paths (no fragments, no URLs, deduped). */
export function extractLinks(content: string, sourceFilePath: string): string[] {
  const targets = new Set<string>();
  for (const re of [MARKDOWN_LINK, ASCIIDOC_XREF, ASCIIDOC_INCLUDE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const normalized = normalizeTarget(match[1]!, sourceFilePath);
      if (normalized && normalized !== sourceFilePath) {
        targets.add(normalized);
      }
    }
  }
  return Array.from(targets);
}

/** target path → list of source file paths that link to it. */
export type BacklinkIndex = Map<string, string[]>;

export function buildBacklinkIndex(
  files: readonly { path: string; content: string }[],
): BacklinkIndex {
  const index: BacklinkIndex = new Map();
  for (const file of files) {
    const targets = extractLinks(file.content, file.path);
    for (const target of targets) {
      if (target === file.path) continue; // self-link guard
      const sources = index.get(target);
      if (sources) {
        if (!sources.includes(file.path)) sources.push(file.path);
      } else {
        index.set(target, [file.path]);
      }
    }
  }
  return index;
}

export function findBacklinks(
  targetPath: string,
  index: BacklinkIndex,
): string[] {
  return index.get(targetPath) ?? [];
}
