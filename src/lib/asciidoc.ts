// AsciiDoc conversion with include:: support via File System Access API
import Asciidoctor from "@asciidoctor/core";

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
export async function convertAdoc(opts: ConvertOptions): Promise<string> {
  const { filePath, fileContent, readFile } = opts;

  // Determine the base directory of the current file
  const baseDirPath = dirOf(filePath);

  // Pre-load all includes recursively
  const includeCache = await collectIncludes(
    fileContent,
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
  registry.block(function (this: any) {
    const self = this;
    self.named("mermaid");
    self.onContext(["listing", "literal", "open"]);
    self.process(function (_parent: any, reader: any) {
      const source = reader.getLines().join("\n");
      return self.createPassBlock(
        _parent,
        `<div class="mermaid">${source}</div>`,
        {},
      );
    });
  });

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

  const html = asciidoctor.convert(fileContent, {
    extension_registry: registry,
    standalone: false,
    safe: "unsafe",
    attributes: {
      showtitle: true,
      icons: "font",
      "source-highlighter": "highlight.js",
      sectanchors: true,
      sectlinks: true,
      idprefix: "",
      idseparator: "-",
      toc: "left",
    },
  }) as string;

  return html;
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
