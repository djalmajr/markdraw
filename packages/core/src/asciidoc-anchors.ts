/**
 * Explicit AsciiDoc anchors and a workspace index for `<<id>>` links that
 * point into another file. Pure parsing: the host feeds `(path, content)`
 * pairs in and gets back locations it can navigate to.
 *
 * Only explicit anchors count — auto-generated section ids are deliberately
 * left out, since the rendered `href="#id"` alone cannot tell which document
 * defined them.
 */

// Double brackets and anchor macros use a stricter ID grammar than attributes.
const ID = "[\\p{L}\\p{N}_:][\\p{L}\\p{N}\\p{M}_:.\\-]*";
const DOUBLE_BRACKET = new RegExp(`\\[\\[\\s*(${ID})\\s*(?:,[^\\]]*)?\\]\\]`, "gu");
const ANCHOR_MACRO = new RegExp(`(?<!\\\\)anchor:(${ID})\\[`, "gu");
const SHORT_SPAN = /\[#([^\]]+)\](?=#)/g;
const SHORTHAND_ID = /#([^.%#]+)/g;
const ATTRIBUTE_LIST = /^\[(?![\s[\]])(.*)\]$/;
const ATTRIBUTE = /\s*(?:([\w-]+)\s*=\s*)?(?:"([^"]*)"[^,]*|'([^']*)'[^,]*|([^,]*))(?:,|$)/gy;

const COMMENT_DELIMITER = /^\/{4,}$/;
const BLOCK_DELIMITER = /^([-.+])\1{3,}$/;
const OTHER_BLOCK_DELIMITER = /^(?:([=*_~])\1{3,}|--|[|!,:]={3,})$/;
const ASCIIDOC_FILE = /\.(?:adoc|asciidoc|asc)$/i;

function shorthandId(style: string): string | undefined {
  if (!style.startsWith("#") || style.includes(" ")) return undefined;
  let id: string | undefined;
  for (const match of style.matchAll(SHORTHAND_ID)) id = match[1];
  return id;
}

function attributeId(attributes: string): string | undefined {
  let namedId: string | undefined;
  let shortId: string | undefined;
  ATTRIBUTE.lastIndex = 0;
  while (ATTRIBUTE.lastIndex < attributes.length) {
    const first = ATTRIBUTE.lastIndex === 0;
    const match = ATTRIBUTE.exec(attributes);
    if (!match) break;
    const value = match[2] ?? match[3] ?? match[4]?.trim();
    if (!match[1] && first && value) shortId = shorthandId(value);
    if (match[1] === "id") namedId = value;
  }
  return shortId ?? namedId;
}

/** Keep literal masks across the lines of a paragraph, preserving its newlines. */
function maskInlineLiterals(paragraph: string): string {
  const openers = /\\\[|(?<!\\)(``\+|`\+|\+\+\+|pass:\[)/g;
  const macroEnd = /(?<!\\)\]/g;
  let masked = "";
  let offset = 0;
  let match: RegExpExecArray | null;
  while ((match = openers.exec(paragraph)) !== null) {
    const opener = match[1];
    const start = openers.lastIndex;
    let end = start;
    if (opener === "pass:[") {
      macroEnd.lastIndex = start;
      end = macroEnd.exec(paragraph) ? macroEnd.lastIndex : paragraph.length;
    } else if (opener) {
      const closer = opener === "+++" ? opener : "+" + opener.slice(0, -1);
      const at = paragraph.indexOf(closer, start);
      // Without its closer in the paragraph the marker is plain text for the
      // converter, so it must not hide the anchors that follow it.
      if (at === -1) continue;
      end = at + closer.length;
    }
    masked += paragraph.slice(offset, match.index)
      + paragraph.slice(match.index, end).replace(/[^\n]/g, "\0");
    offset = end;
    openers.lastIndex = end;
  }
  return masked + paragraph.slice(offset);
}

function collectParagraphIds(paragraph: string[], ids: Set<string>) {
  if (paragraph.length === 0) return;
  const masked = maskInlineLiterals(paragraph.join("\n"));
  paragraph.length = 0;
  for (const line of masked.split("\n")) {
    for (const match of line.matchAll(DOUBLE_BRACKET)) ids.add(match[1]!);
    for (const match of line.matchAll(ANCHOR_MACRO)) ids.add(match[1]!);
    for (const match of line.matchAll(SHORT_SPAN)) {
      const id = match[1]!.split(/[.,]/, 1)[0]!.trim();
      if (id && !id.includes("\0")) ids.add(id);
    }
  }
}

/** Extract explicit anchor ids from AsciiDoc source, in first-seen order. */
export function extractAsciidocAnchorIds(content: string): string[] {
  const ids = new Set<string>();
  const paragraph: string[] = [];
  let openDelimiter: string | null = null;

  for (const line of content.split(/\r?\n/)) {
    const delimiter = line.trimEnd();
    if (openDelimiter !== null) {
      if (delimiter === openDelimiter) openDelimiter = null;
      continue;
    }
    if (COMMENT_DELIMITER.test(delimiter) || BLOCK_DELIMITER.test(delimiter)) {
      collectParagraphIds(paragraph, ids);
      openDelimiter = delimiter;
    } else if (!delimiter || OTHER_BLOCK_DELIMITER.test(delimiter)) {
      collectParagraphIds(paragraph, ids);
    } else {
      const attributes = delimiter.match(ATTRIBUTE_LIST)?.[1];
      if (attributes !== undefined) {
        collectParagraphIds(paragraph, ids);
        const id = attributeId(attributes);
        if (id) ids.add(id);
      } else if (!line.trimStart().startsWith("//")) {
        paragraph.push(line);
      }
    }
  }
  collectParagraphIds(paragraph, ids);
  return Array.from(ids);
}

export interface AnchorFileSource {
  rootId: string;
  rootName: string;
  path: string;
  content: string;
}

export interface AnchorLocation {
  rootId: string;
  path: string;
}

/** id → locations, in source order. */
export type AnchorIndex = Map<string, AnchorLocation[]>;

export function buildAnchorIndex(files: readonly AnchorFileSource[]): AnchorIndex {
  const index: AnchorIndex = new Map();
  for (const file of files) {
    if (!ASCIIDOC_FILE.test(file.path)) continue;
    for (const id of extractAsciidocAnchorIds(file.content)) {
      const location = { rootId: file.rootId, path: file.path };
      const existing = index.get(id);
      if (!existing) {
        index.set(id, [location]);
      } else if (!existing.some((other) =>
        other.rootId === location.rootId && other.path === location.path
      )) {
        existing.push(location);
      }
    }
  }
  return index;
}

function directory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

function segments(path: string): string[] {
  return directory(path).split("/").filter((part) => part !== "" && part !== ".");
}

function pathDistance(from: string, candidate: string): number {
  const a = segments(from);
  const b = segments(candidate);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return a.length + b.length - 2 * common;
}

/** Pick the file defining `id` nearest to `from`, within the same root. */
export function resolveAnchor(
  index: AnchorIndex,
  id: string,
  from: { rootId: string; path: string },
): AnchorLocation | undefined {
  const candidates = (index.get(id) ?? []).filter((location) =>
    location.rootId === from.rootId && location.path !== from.path
  );
  if (candidates.length === 0) return undefined;
  return candidates.slice().sort((a, b) =>
    pathDistance(from.path, a.path) - pathDistance(from.path, b.path)
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  )[0];
}
