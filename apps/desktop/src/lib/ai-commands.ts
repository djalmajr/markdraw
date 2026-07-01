// Loader for file-backed slash commands + custom instructions (omp#1).
// Commands are *.md files in two directories — global (<appConfigDir>/commands)
// and project (<workspace root>/.markdraw/commands) — merged over the inline
// builtins with precedence builtin < global < project (encoded by merge order
// in mergeSlashCommands). Loading is strictly best-effort: a missing dir or an
// unreadable file is skipped, never thrown, so the composer always gets a
// usable command list.

import { appConfigDir } from "@tauri-apps/api/path";
import {
  mergeSlashCommands,
  parseInstructionsFile,
  parseSlashCommandFile,
  type CustomInstructions,
  type SlashCommandDef,
} from "@markdraw/ai/slash-commands.ts";
import { invoke } from "./chaos-invoke.ts";
import { readFileContent } from "./fs.ts";

/** Mirror of the Rust read_dir entry (only the fields the loader needs). */
interface DirEntryLite {
  kind: string;
  name: string;
  path: string;
}

export interface ContextFileDependency {
  content: string;
  path: string;
}

/** Commands every install ships, overridable by global/project files. */
export const BUILTIN_COMMANDS: SlashCommandDef[] = [
  {
    description: "Explain a topic using workspace context",
    name: "explain",
    source: "builtin",
    template: "Explain the following in the context of this workspace:\n\n$ARGUMENTS",
  },
  {
    description: "Summarize the conversation",
    name: "summarize",
    source: "builtin",
    template: "Summarize our conversation so far: key decisions, open questions, next steps.",
  },
];

export const CONTEXT_FILE_CANDIDATES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
];

const CONTEXT_IMPORT_MAX_DEPTH = 5;
/** Total expanded-content budget for one context file's @-import tree. Bounds a
 *  content-explosion / prompt-bloat DoS from a deep or fan-out import graph. */
const CONTEXT_IMPORT_MAX_BYTES = 128 * 1024;
const CONTEXT_IMPORT_RE = /(^|[\s([])@(?:<([^>\r\n]+)>|([^\s`"')\]},>]+))/g;

/** The command name a directory entry's *.md file defines (extension-insensitive
 *  on case), or null for anything that is not a command file. */
export function commandNameFromFile(fileName: string): string | null {
  if (!/\.md$/i.test(fileName)) return null;
  // parseSlashCommandFile lowercases + validates the remainder.
  return fileName.slice(0, -3);
}

/** Join a base directory and a child segment without doubling separators
 *  (appConfigDir may or may not end with one, per platform). */
export function joinDir(base: string, child: string): string {
  return /[\\/]$/.test(base) ? `${base}${child}` : `${base}/${child}`;
}

function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(0, index) : "";
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const drive = normalized.match(/^[a-zA-Z]:\//)?.[0] ?? "";
  const absolute = normalized.startsWith("/") || !!drive;
  const start = drive ? drive.length : absolute ? 1 : 0;
  const parts: string[] = [];
  for (const part of normalized.slice(start).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  if (drive) return `${drive}${parts.join("/")}`;
  if (absolute) return `/${parts.join("/")}`;
  return parts.join("/");
}

function stripTrailingSlash(path: string): string {
  const normalized = normalizePath(path);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function isAbsolutePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
}

function pathEquals(a: string, b: string): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

function isInsideRoot(rootPath: string, path: string): boolean {
  const root = stripTrailingSlash(rootPath).toLowerCase();
  const target = normalizePath(path).toLowerCase();
  return target === root || target.startsWith(`${root}/`);
}

function relativeToRoot(rootPath: string, path: string): string {
  const root = stripTrailingSlash(rootPath);
  const target = normalizePath(path);
  return pathEquals(root, target) ? "" : target.slice(root.length + 1);
}

function resolveContextImport(rootPath: string, baseDir: string, token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  if (isAbsolutePath(trimmed)) return null;
  const target = normalizePath(joinDir(baseDir, trimmed));
  return isInsideRoot(rootPath, target) ? target : null;
}

function findContextImports(line: string): string[] {
  const imports: string[] = [];
  const segments = line.split("`");
  for (let index = 0; index < segments.length; index += 2) {
    const segment = segments[index] ?? "";
    for (const match of segment.matchAll(CONTEXT_IMPORT_RE)) {
      const target = match[2] ?? match[3];
      if (target) imports.push(target);
    }
  }
  return imports;
}

async function expandContextImports(
  rootPath: string,
  filePath: string,
  raw: string,
  readFile: (path: string) => Promise<string>,
  visited: Set<string>,
  depth: number,
  budget: { used: number },
): Promise<string> {
  if (depth >= CONTEXT_IMPORT_MAX_DEPTH) return raw;
  const out: string[] = [];
  const baseDir = dirname(filePath) || rootPath;
  let fenced = false;
  for (const line of raw.split(/\r?\n/)) {
    out.push(line);
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const token of findContextImports(line)) {
      const target = resolveContextImport(rootPath, baseDir, token);
      // `visited` is never cleared: each file is inlined at most once across the
      // whole tree (not just the current path), so a diamond/fan-out graph can't
      // re-expand the same file exponentially. The byte budget caps total size.
      if (!target || visited.has(target)) continue;
      if (budget.used >= CONTEXT_IMPORT_MAX_BYTES) continue;
      visited.add(target);
      try {
        const content = await readFile(target);
        budget.used += content.length;
        const expanded = await expandContextImports(rootPath, target, content, readFile, visited, depth + 1, budget);
        out.push("");
        out.push(`<context-import path="${relativeToRoot(rootPath, target)}">`);
        out.push(expanded.trim());
        out.push("</context-import>");
      } catch {
        // Missing/unreadable imports are ignored; stale references should not
        // make the whole instructions load fail.
      }
    }
  }
  return out.join("\n").trim();
}

export function expandContextFile(
  rootPath: string,
  filePath: string,
  raw: string,
  readFile: (path: string) => Promise<string> = readFileContent,
): Promise<string> {
  return expandContextImports(
    stripTrailingSlash(rootPath),
    normalizePath(filePath),
    raw,
    readFile,
    new Set([normalizePath(filePath)]),
    0,
    { used: raw.length },
  );
}

async function loadCommandsFromDir(
  dir: string,
  source: SlashCommandDef["source"],
): Promise<SlashCommandDef[]> {
  let entries: DirEntryLite[];
  try {
    entries = await invoke<DirEntryLite[]>("read_dir", { path: dir });
  } catch {
    return []; // missing/unreadable dir
  }
  const commands: SlashCommandDef[] = [];
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const name = commandNameFromFile(entry.name);
    if (name === null) continue;
    try {
      const raw = await readFileContent(joinDir(dir, entry.name));
      const parsed = parseSlashCommandFile(name, raw, source);
      if (parsed) commands.push(parsed);
    } catch {
      // unreadable file — skip it, keep the rest
    }
  }
  return commands;
}

/** All slash commands for the current workspace: builtins, then the global
 *  dir, then the project dir — later sources override earlier ones by name. */
export async function loadSlashCommands(rootPath: string | null): Promise<SlashCommandDef[]> {
  let global: SlashCommandDef[] = [];
  try {
    global = await loadCommandsFromDir(joinDir(await appConfigDir(), "commands"), "global");
  } catch {
    // no resolvable config dir — builtins/project still serve
  }
  const project = rootPath
    ? await loadCommandsFromDir(`${rootPath}/.markdraw/commands`, "project")
    : [];
  return mergeSlashCommands(BUILTIN_COMMANDS, global, project);
}

/** The workspace's custom instructions (`<root>/.markdraw/instructions.md`),
 *  or null when no root is open / the file is missing or empty. */
export async function loadCustomInstructions(
  rootPath: string | null,
): Promise<CustomInstructions | null> {
  if (!rootPath) return null;
  try {
    return parseInstructionsFile(await readFileContent(`${rootPath}/.markdraw/instructions.md`));
  } catch {
    return null;
  }
}

/** Workspace-level agent/context files (AGENTS.md, CLAUDE.md, etc.) expanded
 *  with bounded @file imports. Returned as append-only instructions so the app
 *  still owns the base system prompt and `.markdraw/instructions.md` semantics. */
export async function loadContextInstructions(
  rootPath: string | null,
): Promise<CustomInstructions | null> {
  if (!rootPath) return null;
  const blocks: ContextFileDependency[] = [];
  const root = stripTrailingSlash(rootPath);
  for (const relativePath of CONTEXT_FILE_CANDIDATES) {
    const filePath = normalizePath(joinDir(root, relativePath));
    try {
      const raw = await readFileContent(filePath);
      const expanded = await expandContextFile(root, filePath, raw);
      if (expanded.trim()) blocks.push({ content: expanded.trim(), path: relativePath });
    } catch {
      // Optional context file not present.
    }
  }
  if (blocks.length === 0) return null;
  return {
    mode: "append",
    text: [
      "[Workspace context files]",
      ...blocks.map((block) => `<context-file path="${block.path}">\n${block.content}\n</context-file>`),
      "[/Workspace context files]",
    ].join("\n\n"),
  };
}
