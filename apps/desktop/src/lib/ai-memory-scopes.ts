// ai-memory workspace scoping. Each open workspace root may carry an
// `.ai-memory.toml` routing marker (`workspace` + `project`). When the
// ai-memory MCP is connected, we surface those scopes to the chat model so it
// queries/writes the right project(s) — and, with several roots open, ALL of
// them at once (the MCP `scopes` arg is an array).
//
// The scope is fed to the model as an appended instruction (not a hardcoded
// tool-arg rewrite): the model stays free to search globally or narrow further,
// but defaults to the open workspaces' scopes.

import { readFileContent } from "./fs.ts";

export interface MemoryScope {
  /** Absolute root path the marker was read from (for the human-facing note). */
  root: string;
  workspace: string;
  project: string;
}

/** Pull `workspace`/`project` out of an `.ai-memory.toml` (flat top-level keys;
 *  values are single- or double-quoted). Ignores everything else. */
export function parseAiMemoryToml(text: string): { workspace?: string; project?: string } {
  const value = (key: string): string | undefined => {
    const m = text.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*["']([^"'\\n]+)["']`, "m"));
    return m?.[1]?.trim() || undefined;
  };
  return { workspace: value("workspace"), project: value("project") };
}

/** Read each root's `.ai-memory.toml`; keep the ones that declare both keys. */
export async function loadMemoryScopes(rootPaths: string[]): Promise<MemoryScope[]> {
  const scopes: MemoryScope[] = [];
  for (const root of rootPaths) {
    try {
      const { workspace, project } = parseAiMemoryToml(
        await readFileContent(`${root}/.ai-memory.toml`),
      );
      if (workspace && project) scopes.push({ root, workspace, project });
    } catch {
      // No marker in this root — it just doesn't participate in memory scoping.
    }
  }
  return scopes;
}

/** Build the system-prompt note that tells the model which scopes to pass to the
 *  ai-memory MCP tools. Returns null when no open root declares a scope. */
export function buildMemoryScopesInstruction(scopes: MemoryScope[]): string | null {
  if (scopes.length === 0) return null;
  const list = scopes.map((s) => `- workspace "${s.workspace}", project "${s.project}"`).join("\n");
  const scopesArg = JSON.stringify(scopes.map((s) => ({ workspace: s.workspace, project: s.project })));
  return (
    "## ai-memory scopes\n" +
    "The ai-memory MCP is connected. The open workspace(s) declare these memory " +
    `scopes (from their \`.ai-memory.toml\`):\n${list}\n\n` +
    "When you call ai-memory tools (`memory_query`, `memory_recent`, " +
    "`memory_read_page`, `memory_write_page`, …), pass the `scopes` argument " +
    `\`${scopesArg}\` so you read/write the right project(s). With multiple ` +
    "scopes, the search covers all of them. Only omit/override the scopes when " +
    "the user explicitly asks about a different project or a global search."
  );
}
