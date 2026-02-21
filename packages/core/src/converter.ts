// Main-thread converter API that delegates heavy work to a Web Worker.
// Include resolution (which needs platform-specific readFile) stays on main thread.
// The actual conversion (asciidoctor.js / markdown-it) runs in the worker.

import { collectIncludes } from "./asciidoc";
import type { ConvertOptions } from "./asciidoc";

export type { ConvertOptions };

// ─── Include resolution (Markdown) ──────────────────────────────────────────

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

async function processMarkdownIncludes(
  content: string,
  baseDirPath: string,
  readFile: (path: string) => Promise<string | null>,
  visited = new Set<string>(),
): Promise<string> {
  const regex = /<!--\s*include:\s*(.+?)\s*-->/g;
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
      result = result.replace(fullMatch, `<!-- WARNING: circular include: ${target} -->`);
      continue;
    }
    visited.add(resolved);
    const fileContent = await readFile(resolved);
    if (fileContent !== null) {
      const processed = await processMarkdownIncludes(fileContent, dirOf(resolved), readFile, visited);
      result = result.replace(fullMatch, processed);
    } else {
      result = result.replace(fullMatch, `<!-- WARNING: include file not found: ${target} (resolved: ${resolved}) -->`);
    }
  }
  return result;
}

// ─── Worker management ──────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (html: string) => void;
  reject: (err: Error) => void;
}

let nextId = 0;
const pending = new Map<number, PendingRequest>();

function setupWorker(w: Worker) {
  w.onmessage = (e: MessageEvent<{ id: number; html: string | null; error: string | null }>) => {
    const { id, html, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(html!);
  };
}

function postToWorker(w: Worker, msg: Record<string, unknown>): Promise<string> {
  const id = nextId++;
  msg.id = id;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage(msg);
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function createConverter(w: Worker) {
  setupWorker(w);

  async function convertAdoc(opts: ConvertOptions): Promise<string> {
    const { filePath, fileContent, readFile } = opts;
    const baseDirPath = dirOf(filePath);

    const includeCache = await collectIncludes(fileContent, baseDirPath, readFile);
    const includeCacheObj: Record<string, string> = {};
    for (const [k, v] of includeCache) {
      includeCacheObj[k] = v;
    }

    return postToWorker(w, {
      type: "convert-adoc",
      fileContent,
      filePath,
      includeCache: includeCacheObj,
    });
  }

  async function convertMarkdown(opts: ConvertOptions): Promise<string> {
    const { filePath, fileContent, readFile } = opts;
    const baseDirPath = dirOf(filePath);

    const processedContent = await processMarkdownIncludes(fileContent, baseDirPath, readFile);

    return postToWorker(w, {
      type: "convert-md",
      processedContent,
    });
  }

  return { convertAdoc, convertMarkdown };
}
