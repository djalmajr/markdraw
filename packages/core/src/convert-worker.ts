// Web Worker for heavy AsciiDoc/Markdown conversion
// Runs asciidoctor.js and markdown-it off the main thread

import Asciidoctor from "@asciidoctor/core";
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import taskLists from "markdown-it-task-lists";
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

// ─── AsciiDoc ───────────────────────────────────────────────────────────────

const asciidoctor = Asciidoctor();

const ADOC_EXT_PATTERN = /\.(adoc|asciidoc|asc|ad)$/;

function resolvePath(baseDirPath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = baseDirPath ? baseDirPath.split("/") : [];
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

function dirOf(path: string): string {
  return path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
}

function preprocessXrefs(content: string): string {
  content = content.replace(
    /xref:([^\[#\s]+(?:\.(?:adoc|asciidoc|asc|ad)))(#[^\[\s]*)?\[([^\]]*)\]/g,
    (_match, path: string, fragment: string | undefined, text: string) => {
      const displayText = text || path.split("/").pop()!.replace(ADOC_EXT_PATTERN, "");
      const htmlPath = path.replace(ADOC_EXT_PATTERN, ".html");
      const href = escapeHtml(`${htmlPath}${fragment || ""}`);
      return `pass:[<a href="${href}">${escapeHtml(displayText)}</a>]`;
    },
  );
  content = content.replace(
    /<<([^\s,>#]+\.(?:adoc|asciidoc|asc|ad))(#[^,>]*)?,\s*([^>]+)>>/g,
    (_match, path: string, fragment: string | undefined, text: string) => {
      const htmlPath = path.replace(ADOC_EXT_PATTERN, ".html");
      const href = escapeHtml(`${htmlPath}${fragment || ""}`);
      return `pass:[<a href="${href}">${escapeHtml(text)}</a>]`;
    },
  );
  content = content.replace(
    /<<([^\s,>#]+\.(?:adoc|asciidoc|asc|ad))(#[^,>]*)?>>/g,
    (_match, path: string, fragment: string | undefined) => {
      const displayText = path.split("/").pop()!.replace(ADOC_EXT_PATTERN, "");
      const htmlPath = path.replace(ADOC_EXT_PATTERN, ".html");
      const href = escapeHtml(`${htmlPath}${fragment || ""}`);
      return `pass:[<a href="${href}">${escapeHtml(displayText)}</a>]`;
    },
  );
  return content;
}

function convertAdocSync(
  fileContent: string,
  filePath: string,
  includeCache: Record<string, string>,
): string {
  const baseDirPath = dirOf(filePath);
  const cache = new Map(Object.entries(includeCache));
  const dirStack: string[] = [baseDirPath];

  const registry = asciidoctor.Extensions.create();

  registry.block(function (this: any) {
    const self = this;
    self.named("mermaid");
    self.onContext(["listing", "literal", "open"]);
    self.process(function (_parent: any, reader: any) {
      const source = reader.getLines().join("\n")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return self.createPassBlock(_parent, `<div class="mermaid">${source}</div>`, {});
    });
  });

  const krokiTypes = ["plantuml", "graphviz", "ditaa", "c4plantuml", "nomnoml", "svgbob", "blockdiag", "nwdiag", "packetdiag", "rackdiag", "seqdiag", "erd", "excalidraw", "vega", "vegalite", "wavedrom"];
  for (const type of krokiTypes) {
    registry.block(function (this: any) {
      const self = this;
      self.named(type);
      self.onContext(["listing", "literal", "open"]);
      self.process(function (_parent: any, reader: any) {
        const source = reader.getLines().join("\n");
        const escaped = source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return self.createPassBlock(_parent, `<div class="kroki" data-type="${type}">${escaped}</div>`, {});
      });
    });
  }

  registry.includeProcessor(function (this: any) {
    const self = this;
    self.handles(() => true);
    self.process(function (_doc: any, reader: any, target: string, attrs: any) {
      let resolved: string | null = null;
      let content: string | undefined;

      for (let i = dirStack.length - 1; i >= 0; i--) {
        const candidate = resolvePath(dirStack[i]!, target);
        content = cache.get(candidate);
        if (content !== undefined) { resolved = candidate; break; }
      }

      if (resolved === null) {
        content = cache.get(target);
        if (content !== undefined) resolved = target;
      }

      if (resolved !== null && content !== undefined) {
        dirStack.push(dirOf(resolved));
        return reader.pushInclude(content, target, resolved, 1, attrs);
      }

      const currentDir = dirStack[dirStack.length - 1] ?? "";
      const attempted = resolvePath(currentDir, target);
      return reader.pushInclude(
        [`[WARNING: include file not found: ${target} (resolved: ${attempted})]`],
        target, target, 1, attrs,
      );
    });
  });

  const processedContent = preprocessXrefs(fileContent);

  return asciidoctor.convert(processedContent, {
    extension_registry: registry,
    standalone: false,
    safe: "unsafe",
    attributes: {
      showtitle: true,
      icons: "font",
      sectanchors: true,
      sectlinks: true,
      idprefix: "",
      idseparator: "-",
      toc: "left",
      toclevels: 4,
    },
  }) as string;
}

// ─── Markdown ───────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[\s]+/g, "-").replace(/[^\w-]/g, "");
}

let mdInstance: MarkdownIt | null = null;

function getMd(): MarkdownIt {
  if (mdInstance) return mdInstance;

  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    // Single newlines inside a paragraph become <br> — matches Obsidian/GitHub
    // wiki style and is what users expect when they manually break lines.
    breaks: true,
  });

  md.use(anchor, { permalink: false, slugify });
  md.use(taskLists, { enabled: true, label: true });
  md.use(mk, { throwOnError: false, errorColor: "#cc0000" });
  md.use(alert);
  md.use(footnote);
  md.use(emoji);
  md.use(deflist);
  md.use(abbr);
  md.use(sub);
  md.use(sup);
  md.use(ins);
  md.use(mark);
  md.use(multimdTable, { multiline: true, rowspan: true, headerless: true, multibody: true, autolabel: true });
  for (const name of ["warning", "note", "tip", "caution", "important", "info"]) {
    md.use(container, name);
  }
  md.use(container, "details", {
    validate: (params: string) => params.trim().match(/^details\s+(.*)$/),
    render: (tokens: any, idx: number) => {
      const m = tokens[idx].info.trim().match(/^details\s+(.*)$/);
      if (tokens[idx].nesting === 1) return `<details><summary>${md.utils.escapeHtml(m?.[1] ?? "Details")}</summary>\n`;
      return "</details>\n";
    },
  });

  const defaultFence = md.renderer.rules.fence ||
    function (tokens: any, idx: any, options: any, _env: any, self: any) { return self.renderToken(tokens, idx, options); };

  md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    const token = tokens[idx]!;
    const info = token.info ? token.info.trim() : "";
    if (info === "mermaid") return `<div class="mermaid">${md.utils.escapeHtml(token.content.trim())}</div>\n`;
    const krokiSet = new Set(["plantuml", "graphviz", "ditaa", "c4plantuml", "nomnoml", "svgbob", "blockdiag", "nwdiag", "packetdiag", "rackdiag", "seqdiag", "erd", "excalidraw", "vega", "vegalite", "wavedrom"]);
    if (krokiSet.has(info)) return `<div class="kroki" data-type="${info}">${md.utils.escapeHtml(token.content.trim())}</div>\n`;
    return defaultFence(tokens, idx, options, env, self);
  };

  mdInstance = md;
  return md;
}

interface TocEntry { id: string; text: string; level: number; }

function buildTocHtml(entries: TocEntry[]): string {
  if (entries.length === 0) return "";
  let html = '<div id="toc" class="toc">\n<div id="toctitle" class="title">Table of Contents</div>\n';
  const minLevel = Math.min(...entries.map((e) => e.level));
  const normalized = entries.map((e) => ({ ...e, depth: e.level - minLevel }));
  let currentDepth = 0;
  html += "<ul>\n";
  for (let i = 0; i < normalized.length; i++) {
    const entry = normalized[i]!;
    const nextDepth = normalized[i + 1]?.depth ?? 0;
    while (currentDepth > entry.depth) { html += "</ul></li>\n"; currentDepth--; }
    html += `<li><a href="#${entry.id}">${escapeHtml(entry.text)}</a>`;
    if (nextDepth > entry.depth) { html += "\n<ul>\n"; currentDepth = entry.depth + 1; }
    else html += "</li>\n";
  }
  while (currentDepth > 0) { html += "</ul></li>\n"; currentDepth--; }
  html += "</ul>\n</div>\n";
  return html;
}

function convertMarkdownSync(processedContent: string): string {
  const md = getMd();
  // Parse once. md.render() would re-parse from scratch — wasteful since we
  // already need the token stream for TOC extraction. Parse dominates ~96%
  // of the pipeline; reusing the tokens halves total time on large docs.
  const env: Record<string, unknown> = {};
  const tokens = md.parse(processedContent, env);
  const tocEntries: TocEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type === "heading_open") {
      const level = parseInt(token.tag.slice(1), 10);
      const inlineToken = tokens[i + 1];
      if (inlineToken && inlineToken.type === "inline") {
        tocEntries.push({ id: slugify(inlineToken.content), text: inlineToken.content, level });
      }
    }
  }
  return buildTocHtml(tocEntries) + md.renderer.render(tokens, md.options, env);
}

// ─── Message handler ────────────────────────────────────────────────────────

interface ConvertAdocMessage {
  type: "convert-adoc";
  id: number;
  fileContent: string;
  filePath: string;
  includeCache: Record<string, string>;
}

interface ConvertMdMessage {
  type: "convert-md";
  id: number;
  processedContent: string;
}

type WorkerMessage = ConvertAdocMessage | ConvertMdMessage;

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  try {
    let html: string;
    if (msg.type === "convert-adoc") {
      html = convertAdocSync(msg.fileContent, msg.filePath, msg.includeCache);
    } else {
      html = convertMarkdownSync(msg.processedContent);
    }
    self.postMessage({ id: msg.id, html, error: null });
  } catch (err: any) {
    self.postMessage({ id: msg.id, html: null, error: err?.message ?? String(err) });
  }
};
