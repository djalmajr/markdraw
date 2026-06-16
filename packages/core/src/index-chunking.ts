// Heading-aware chunking for the "Full" workspace index. A document is split
// into sections delimited by its headings (reusing the same `extractHeadings`
// parser the Go-to-Symbol palette uses), so each chunk is a coherent topic that
// embeds well and can be cited by its heading. Oversized sections are sub-split
// at line boundaries so a single chunk never blows past the embedder's window.
//
// Pure (no DOM, no Tauri) → unit-testable. The desktop indexer feeds each
// chunk's `text` to the provider's embed() and ships {ord, heading, startLine,
// text} to the Rust store; `headingPath` gives the embedder ancestor context.

import { extractHeadings, type Heading } from "./headings.ts";

export interface Chunk {
  /** 0-based ordinal within the document (becomes the store's `ord`). */
  index: number;
  /** Nearest enclosing heading text ("" for the preamble before any heading). */
  heading: string;
  /** Heading level 1-6, or 0 for the preamble. */
  headingLevel: number;
  /** Ancestor headings joined with " > ", including this section's own heading.
   *  Empty for the preamble. Useful as an embedding-context prefix. */
  headingPath: string;
  /** 0-based line where this chunk starts in the source. */
  startLine: number;
  /** 0-based inclusive line where this chunk ends. */
  endLine: number;
  /** The chunk's raw text (heading line + body for a section), trimmed. */
  text: string;
}

export interface ChunkOptions {
  /** Soft maximum characters per chunk. A section longer than this is split at
   *  line boundaries into pieces that each stay under the cap (a single line
   *  longer than the cap is kept whole). Default ~1500 (≈ a few hundred tokens). */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 1500;

interface Section {
  heading: string;
  headingLevel: number;
  headingPath: string;
  start: number; // 0-based, inclusive
  end: number; // 0-based, inclusive
}

/** Split a document into heading-aware, size-capped chunks in document order. */
export function chunkDocument(filename: string, content: string, opts: ChunkOptions = {}): Chunk[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const lines = content.split("\n");
  const headings = extractHeadings(filename, content);

  const sections = buildSections(lines.length, headings);

  const chunks: Chunk[] = [];
  let index = 0;
  for (const sec of sections) {
    const secLines = lines.slice(sec.start, sec.end + 1);
    if (secLines.join("\n").trim().length === 0) continue; // drop blank sections
    for (const piece of splitToSize(secLines, sec.start, maxChars)) {
      const text = piece.lines.join("\n").trim();
      if (text.length === 0) continue;
      chunks.push({
        index: index++,
        heading: sec.heading,
        headingLevel: sec.headingLevel,
        headingPath: sec.headingPath,
        startLine: piece.start,
        endLine: piece.end,
        text,
      });
    }
  }
  return chunks;
}

/** Carve line ranges into sections delimited by heading lines, tracking the
 *  ancestor heading path via a level stack. The content before the first
 *  heading becomes a headingless preamble section. */
function buildSections(lineCount: number, headings: Heading[]): Section[] {
  const sections: Section[] = [];
  const firstHeadingLine = headings.length ? headings[0]!.line : lineCount;
  if (firstHeadingLine > 0) {
    sections.push({ heading: "", headingLevel: 0, headingPath: "", start: 0, end: firstHeadingLine - 1 });
  }
  const stack: Heading[] = [];
  for (let h = 0; h < headings.length; h += 1) {
    const cur = headings[h]!;
    const next = headings[h + 1];
    const end = (next ? next.line : lineCount) - 1;
    while (stack.length && stack[stack.length - 1]!.level >= cur.level) stack.pop();
    stack.push(cur);
    sections.push({
      heading: cur.text,
      headingLevel: cur.level,
      headingPath: stack.map((x) => x.text).join(" > "),
      start: cur.line,
      end,
    });
  }
  return sections;
}

interface Piece {
  lines: string[];
  start: number; // 0-based, inclusive
  end: number; // 0-based, inclusive
}

/** Greedily pack lines into pieces that stay under `maxChars`, splitting only at
 *  line boundaries. A section already within the cap is returned as one piece. */
function splitToSize(lines: string[], baseStart: number, maxChars: number): Piece[] {
  if (lines.join("\n").length <= maxChars) {
    return [{ lines, start: baseStart, end: baseStart + lines.length - 1 }];
  }
  const pieces: Piece[] = [];
  let cur: string[] = [];
  let curStart = baseStart;
  let curChars = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const lineLen = line.length + 1; // + newline
    if (cur.length > 0 && curChars + lineLen > maxChars) {
      pieces.push({ lines: cur, start: curStart, end: baseStart + i - 1 });
      cur = [];
      curStart = baseStart + i;
      curChars = 0;
    }
    cur.push(line);
    curChars += lineLen;
  }
  if (cur.length > 0) pieces.push({ lines: cur, start: curStart, end: baseStart + lines.length - 1 });
  return pieces;
}
