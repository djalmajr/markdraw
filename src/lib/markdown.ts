// Markdown conversion with include support, mermaid, syntax highlighting, and extensions
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js/lib/common";
import mk from "@traptitech/markdown-it-katex";
import { alert } from "@mdit/plugin-alert";
import footnote from "markdown-it-footnote";
import { full as emoji } from "markdown-it-emoji";
import deflist from "markdown-it-deflist";
import abbr from "markdown-it-abbr";
import sub from "markdown-it-sub";
import sup from "markdown-it-sup";
import ins from "markdown-it-ins";
import mark from "markdown-it-mark";
import multimdTable from "markdown-it-multimd-table";
import container from "markdown-it-container";
import { escapeHtml } from "./utils";

// --- Include preprocessor ---

/**
 * Scan raw Markdown text for <!-- include: path --> directives.
 * Returns a list of relative paths referenced by include directives.
 */
export function scanMarkdownIncludes(content: string): string[] {
  const regex = /<!--\s*include:\s*(.+?)\s*-->/g;
  const targets: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[1]) targets.push(match[1].trim());
  }
  return targets;
}

/**
 * Resolve a relative path against a base directory path.
 */
function resolvePath(baseDirPath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1); // absolute from root

  const parts = baseDirPath ? baseDirPath.split("/") : [];
  const targetParts = target.split("/");

  for (const part of targetParts) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }

  return parts.join("/");
}

/**
 * Get directory portion of a path.
 */
function dirOf(path: string): string {
  return path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
}

/**
 * Recursively process include directives in Markdown content.
 * Replaces <!-- include: path --> with the file contents, resolving
 * nested includes relative to each included file's directory.
 */
async function processIncludes(
  content: string,
  baseDirPath: string,
  readFile: (path: string) => Promise<string | null>,
  visited = new Set<string>(),
): Promise<string> {
  const regex = /<!--\s*include:\s*(.+?)\s*-->/g;

  // Collect all matches first (to avoid issues with async replacements)
  const matches: { fullMatch: string; target: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    matches.push({ fullMatch: match[0], target: match[1]!.trim() });
  }

  if (matches.length === 0) return content;

  let result = content;
  for (const { fullMatch, target } of matches) {
    const resolved = resolvePath(baseDirPath, target);

    if (visited.has(resolved)) {
      // Circular include — leave a warning
      result = result.replace(
        fullMatch,
        `<!-- WARNING: circular include: ${target} -->`,
      );
      continue;
    }

    visited.add(resolved);
    const fileContent = await readFile(resolved);

    if (fileContent !== null) {
      // Recursively process nested includes
      const nestedDir = dirOf(resolved);
      const processed = await processIncludes(
        fileContent,
        nestedDir,
        readFile,
        visited,
      );
      result = result.replace(fullMatch, processed);
    } else {
      result = result.replace(
        fullMatch,
        `<!-- WARNING: include file not found: ${target} (resolved: ${resolved}) -->`,
      );
    }
  }

  return result;
}

// --- TOC generation ---

interface TocEntry {
  id: string;
  text: string;
  level: number;
}

/**
 * Build a TOC HTML string that matches the structure AsciiDoc's #toc produces,
 * so the same CSS and scroll-tracking logic works for both formats.
 */
function buildTocHtml(entries: TocEntry[]): string {
  if (entries.length === 0) return "";

  let html = '<div id="toc" class="toc">\n<div id="toctitle" class="title">Table of Contents</div>\n';

  // Build nested list based on heading levels
  const minLevel = Math.min(...entries.map((e) => e.level));

  // Normalize levels so they start at 0
  const normalized = entries.map((e) => ({
    ...e,
    depth: e.level - minLevel,
  }));

  let currentDepth = 0;
  html += "<ul>\n";

  for (const entry of normalized) {
    while (currentDepth < entry.depth) {
      html += "<ul>\n";
      currentDepth++;
    }
    while (currentDepth > entry.depth) {
      html += "</ul>\n";
      currentDepth--;
    }
    html += `<li><a href="#${entry.id}">${escapeHtml(entry.text)}</a></li>\n`;
  }

  while (currentDepth > 0) {
    html += "</ul>\n";
    currentDepth--;
  }

  html += "</ul>\n</div>\n";
  return html;
}

/** Escape HTML special characters */
// --- Slugify ---

/** Generate a URL-friendly slug from heading text */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[\s]+/g, "-")
    .replace(/[^\w-]/g, "");
}

// --- Markdown-it setup ---

function createMarkdownIt(): MarkdownIt {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight(str, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
        } catch {
          // fall through to default
        }
      }
      return ""; // use markdown-it's default escaping
    },
  });

  // --- Core plugins ---

  // Heading anchors
  md.use(anchor, {
    permalink: false,
    slugify,
  });

  // Task lists (checkboxes)
  md.use(taskLists, { enabled: true, label: true });

  // --- Math (KaTeX) ---
  md.use(mk, { throwOnError: false, errorColor: "#cc0000" });

  // --- GitHub-style alerts (NOTE, WARNING, TIP, CAUTION, IMPORTANT) ---
  md.use(alert);

  // --- Footnotes ---
  md.use(footnote);

  // --- Emoji (:smile: → 😄) ---
  md.use(emoji);

  // --- Typography extensions ---
  md.use(deflist);   // Definition lists (term\n: definition)
  md.use(abbr);      // Abbreviations (*[HTML]: Hyper Text Markup Language)
  md.use(sub);       // Subscript ~text~
  md.use(sup);       // Superscript ^text^
  md.use(ins);       // Inserted text ++text++
  md.use(mark);      // Marked/highlighted text ==text==

  // --- Advanced tables (colspan, rowspan, multi-line) ---
  md.use(multimdTable, {
    multiline: true,
    rowspan: true,
    headerless: true,
    multibody: true,
    autolabel: true,
  });

  // --- Custom containers (::: type) ---
  // Register common container types
  for (const name of ["warning", "note", "tip", "caution", "important", "info"]) {
    md.use(container, name);
  }

  // Details/summary container
  md.use(container, "details", {
    validate: (params: string) => params.trim().match(/^details\s+(.*)$/),
    render: (tokens: any, idx: number) => {
      const m = tokens[idx].info.trim().match(/^details\s+(.*)$/);
      if (tokens[idx].nesting === 1) {
        return `<details><summary>${md.utils.escapeHtml(m?.[1] ?? "Details")}</summary>\n`;
      }
      return "</details>\n";
    },
  });

  // --- Mermaid fence override ---
  const defaultFence =
    md.renderer.rules.fence ||
    function (tokens: any, idx: any, options: any, _env: any, self: any) {
      return self.renderToken(tokens, idx, options);
    };

  md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    const token = tokens[idx]!;
    const info = token.info ? token.info.trim() : "";

    if (info === "mermaid") {
      const content = token.content.trim();
      return `<div class="mermaid">${md.utils.escapeHtml(content)}</div>\n`;
    }

    return defaultFence(tokens, idx, options, env, self);
  };

  return md;
}

// Singleton instance
let mdInstance: MarkdownIt | null = null;

function getMd(): MarkdownIt {
  if (!mdInstance) {
    mdInstance = createMarkdownIt();
  }
  return mdInstance;
}

// --- Public API ---

export interface ConvertOptions {
  filePath: string;
  fileContent: string;
  readFile: (path: string) => Promise<string | null>;
}

/**
 * Convert Markdown to HTML with include support, mermaid blocks, and TOC.
 * Returns the same kind of HTML string as convertAdoc.
 */
export async function convertMarkdown(opts: ConvertOptions): Promise<string> {
  const { filePath, fileContent, readFile } = opts;

  const baseDirPath = dirOf(filePath);

  // Process includes recursively
  const processed = await processIncludes(
    fileContent,
    baseDirPath,
    readFile,
  );

  const md = getMd();

  // Parse tokens to extract headings for TOC
  const tokens = md.parse(processed, {});
  const tocEntries: TocEntry[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type === "heading_open") {
      const level = parseInt(token.tag.slice(1), 10);
      const inlineToken = tokens[i + 1];
      if (inlineToken && inlineToken.type === "inline") {
        const text = inlineToken.content;
        const id = slugify(text);
        tocEntries.push({ id, text, level });
      }
    }
  }

  // Render HTML
  const bodyHtml = md.render(processed);

  // Build TOC and prepend it (same structure as AsciiDoc's toc=left)
  const tocHtml = buildTocHtml(tocEntries);

  // Combine: TOC first (for right sidebar), then body
  return tocHtml + bodyHtml;
}

/**
 * Get all include paths that a Markdown file depends on (for watch purposes).
 */
export function getMarkdownIncludePaths(
  content: string,
  baseDirPath: string,
): string[] {
  const targets = scanMarkdownIncludes(content);
  return targets.map((t) => resolvePath(baseDirPath, t));
}
