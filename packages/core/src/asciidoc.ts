// AsciiDoc conversion with include:: support via File System Access API
import Asciidoctor from "@asciidoctor/core";
import { escapeHtml } from "./utils";
import { extractFrontmatter, type Frontmatter } from "./frontmatter";

export interface ConvertResult {
  html: string;
  frontmatter: Frontmatter | null;
}

const asciidoctor = Asciidoctor();

/**
 * Scan raw AsciiDoc text for include:: targets.
 * Returns a list of relative paths referenced by include directives.
 */
export function scanIncludes(content: string): string[] {
  const regex = /^include::([^\[]+)\[/gm;
  const targets: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[1]) targets.push(match[1]);
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
 * Recursively collect all includes (including nested) from content.
 * Returns a Map of resolvedPath -> content.
 */
export async function collectIncludes(
  content: string,
  baseDirPath: string,
  readFile: (path: string) => Promise<string | null>,
  visited = new Set<string>(),
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const targets = scanIncludes(content);

  for (const target of targets) {
    const resolved = resolvePath(baseDirPath, target);
    if (visited.has(resolved)) continue;
    visited.add(resolved);

    const fileContent = await readFile(resolved);
    if (fileContent !== null) {
      result.set(resolved, fileContent);
      // Recursively scan for nested includes
      const nestedDir = resolved.includes("/")
        ? resolved.substring(0, resolved.lastIndexOf("/"))
        : "";
      const nested = await collectIncludes(
        fileContent,
        nestedDir,
        readFile,
        visited,
      );
      for (const [k, v] of nested) {
        result.set(k, v);
      }
    }
  }

  return result;
}

/** AsciiDoc file extensions pattern for regex matching */
const ADOC_EXT_PATTERN = /\.(adoc|asciidoc|asc|ad)$/;

/**
 * Pre-process inter-document xref macros into pass-through HTML links.
 *
 * Asciidoctor.js with `standalone: false` can't resolve inter-document xrefs
 * (generates `href="#"`). We convert them into `pass:[]` inline macros that
 * output proper `<a>` tags which our Preview click handler can intercept.
 *
 * Handles:
 * - `xref:path/file.adoc[Text]`
 * - `xref:path/file.adoc#section[Text]`
 * - `<<path/file.adoc#section,Text>>`
 * - `<<path/file.adoc,Text>>`
 * - `<<path/file.adoc>>`
 */
function preprocessXrefs(content: string): string {
  // xref: macro syntax — xref:path.adoc[text] or xref:path.adoc#frag[text]
  content = content.replace(
    /xref:([^\[#\s]+(?:\.(?:adoc|asciidoc|asc|ad)))(#[^\[\s]*)?\[([^\]]*)\]/g,
    (_match, path: string, fragment: string | undefined, text: string) => {
      const displayText = text || path.split("/").pop()!.replace(ADOC_EXT_PATTERN, "");
      const htmlPath = path.replace(ADOC_EXT_PATTERN, ".html");
      const href = escapeHtml(`${htmlPath}${fragment || ""}`);
      return `pass:[<a href="${href}">${escapeHtml(displayText)}</a>]`;
    },
  );

  // <<path.adoc#frag,text>> shorthand with explicit text
  // NOTE: This must run before the no-text variant below, otherwise
  // the simpler regex would partially match inputs with comma+text.
  content = content.replace(
    /<<([^\s,>#]+\.(?:adoc|asciidoc|asc|ad))(#[^,>]*)?,\s*([^>]+)>>/g,
    (_match, path: string, fragment: string | undefined, text: string) => {
      const htmlPath = path.replace(ADOC_EXT_PATTERN, ".html");
      const href = escapeHtml(`${htmlPath}${fragment || ""}`);
      return `pass:[<a href="${href}">${escapeHtml(text)}</a>]`;
    },
  );

  // <<path.adoc>> or <<path.adoc#frag>> shorthand without text
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

export interface ConvertOptions {
  filePath: string;
  fileContent: string;
  readFile: (path: string) => Promise<string | null>;
}

/**
 * Get the directory portion of a path.
 */
function dirOf(path: string): string {
  return path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
}

/**
 * Convert AsciiDoc to HTML with full include:: support.
 *
 * Strategy: since asciidoctor.js include processor is synchronous,
 * we pre-load all referenced files before conversion, then use a
 * directory stack to track the current file context during processing.
 */
export async function convertAdoc(opts: ConvertOptions): Promise<ConvertResult> {
  const { filePath, fileContent, readFile } = opts;

  // Strip YAML frontmatter (if any) before any other processing
  const { frontmatter, body } = extractFrontmatter(fileContent);

  // Determine the base directory of the current file
  const baseDirPath = dirOf(filePath);

  // Pre-load all includes recursively
  const includeCache = await collectIncludes(
    body,
    baseDirPath,
    readFile,
  );

  // Directory stack: tracks the base dir of the file currently being processed.
  // When we encounter an include, we resolve relative to the top of the stack,
  // then push the included file's directory before its content is processed.
  const dirStack: string[] = [baseDirPath];

  // We also need to track when asciidoctor finishes processing an included file
  // so we can pop the stack. We do this by wrapping the included content with
  // sentinel lines that we detect in a preprocessor.
  // Actually, a simpler approach: since pushInclude handles nesting internally
  // in asciidoctor, we can use the reader's dir info. But the safest approach
  // is to build a reverse map: for each resolved path, store its directory,
  // and detect which file we're currently inside based on the target.
  //
  // Simplest correct approach: resolve the target against EVERY directory in the
  // cache and find the match.

  // Build a reverse lookup: for every cached file, map it to its dir
  const fileDirMap = new Map<string, string>();
  for (const resolvedPath of includeCache.keys()) {
    fileDirMap.set(resolvedPath, dirOf(resolvedPath));
  }

  // Create a custom extension registry
  const registry = asciidoctor.Extensions.create();

  // Register mermaid block processor: [mermaid] blocks become <div class="mermaid">
  // 1. Convert <br/> variants to newlines (used for multi-line labels in sequence diagrams)
  // 2. HTML-escape the result so tags don't become DOM elements (textContent stays clean)
  registry.block(function (this: any) {
    const self = this;
    self.named("mermaid");
    self.onContext(["listing", "literal", "open"]);
    self.process(function (_parent: any, reader: any) {
      const source = reader.getLines().join("\n")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return self.createPassBlock(
        _parent,
        `<div class="mermaid">${source}</div>`,
        {},
      );
    });
  });

  // Kroki diagram blocks (plantuml, graphviz, ditaa, etc.)
  const krokiTypes = ["plantuml", "graphviz", "ditaa", "c4plantuml", "nomnoml", "svgbob", "blockdiag", "nwdiag", "packetdiag", "rackdiag", "seqdiag", "erd", "excalidraw", "vega", "vegalite", "wavedrom"];
  for (const type of krokiTypes) {
    registry.block(function (this: any) {
      const self = this;
      self.named(type);
      self.onContext(["listing", "literal", "open"]);
      self.process(function (_parent: any, reader: any) {
        const source = reader.getLines().join("\n");
        const escaped = source
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return self.createPassBlock(
          _parent,
          `<div class="kroki" data-type="${type}">${escaped}</div>`,
          {},
        );
      });
    });
  }

  registry.includeProcessor(function (this: any) {
    const self = this;
    self.handles(function (_target: string) {
      return true; // Handle all includes
    });
    self.process(function (
      _doc: any,
      reader: any,
      target: string,
      attrs: any,
    ) {
      // Try resolving relative to each directory in the stack (most recent first)
      // This handles nested includes correctly: the innermost file's directory
      // takes priority.
      let resolved: string | null = null;
      let content: string | undefined;

      for (let i = dirStack.length - 1; i >= 0; i--) {
        const candidate = resolvePath(dirStack[i]!, target);
        content = includeCache.get(candidate);
        if (content !== undefined) {
          resolved = candidate;
          break;
        }
      }

      // Also try the target as-is (absolute from root)
      if (resolved === null) {
        content = includeCache.get(target);
        if (content !== undefined) {
          resolved = target;
        }
      }

      if (resolved !== null && content !== undefined) {
        // Push this file's directory onto the stack so nested includes
        // resolve relative to it
        dirStack.push(dirOf(resolved));
        const result = reader.pushInclude(content, target, resolved, 1, attrs);
        // Note: we can't pop here because the content hasn't been processed yet.
        // Instead, we leave the stack growing. This is acceptable because we
        // search the stack from top to bottom, so the most recent dir wins.
        return result;
      }

      // If file not found, show a warning inline
      const currentDir = dirStack[dirStack.length - 1] ?? "";
      const attempted = resolvePath(currentDir, target);
      return reader.pushInclude(
        [`[WARNING: include file not found: ${target} (resolved: ${attempted})]`],
        target,
        target,
        1,
        attrs,
      );
    });
  });

  // Pre-process inter-document xrefs into proper HTML links
  const processedContent = preprocessXrefs(body);

  const html = asciidoctor.convert(processedContent, {
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

  return { html, frontmatter };
}

/**
 * Get all include paths that a file depends on (for watch purposes).
 */
export function getIncludePaths(
  content: string,
  baseDirPath: string,
): string[] {
  const targets = scanIncludes(content);
  return targets.map((t) => resolvePath(baseDirPath, t));
}
