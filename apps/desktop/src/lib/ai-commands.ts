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
