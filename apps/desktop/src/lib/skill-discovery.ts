// Bridge + logic for agent skills that OTHER tools (Claude, Codex/Agents,
// OpenCode) expose as `SKILL.md` files. Skills are prompt instructions, not MCP
// servers: they are discovered automatically, deduped, shown read-only in
// Settings, and injected into chat context only when the current turn matches.

import { invoke } from "./chaos-invoke.ts";
import { djb2 } from "@markdraw/core/hash.ts";

export type SkillTool = "claude" | "codex" | "opencode";
export type SkillScope = "global" | "project";

export interface DiscoveredSkillFile {
  name: string;
  description?: string;
  content: string;
  tool: SkillTool;
  scope: SkillScope;
  root?: string;
  sourcePath: string;
}

export interface DiscoveredSkillEntry {
  id: string;
  name: string;
  description?: string;
  content: string;
  slashCommands: string[];
  scope: SkillScope;
  root?: string;
  contentHash: string;
  sources: Array<{ tool: SkillTool; scope: SkillScope; path: string; active: boolean }>;
}

export function discoverSkills(
  roots: string[],
  tools: string[],
): Promise<DiscoveredSkillFile[]> {
  if (tools.length === 0) return Promise.resolve([]);
  return invoke<DiscoveredSkillFile[]>("skills_discover", { roots, tools });
}

export function skillIdentity(s: { name: string }): string {
  return s.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const TOOL_PRIORITY: Record<SkillTool, number> = {
  codex: 0,
  claude: 1,
  opencode: 2,
};

function priority(s: Pick<DiscoveredSkillFile, "scope" | "tool" | "sourcePath">): string {
  const scope = s.scope === "project" ? 0 : 1;
  return `${scope}:${TOOL_PRIORITY[s.tool] ?? 99}:${s.sourcePath}`;
}

function sourceOf(s: DiscoveredSkillFile, active: boolean) {
  return { tool: s.tool, scope: s.scope, path: s.sourcePath, active };
}

function slashCommandsFromContent(content: string): string[] {
  const commands = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*\/([a-z0-9][a-z0-9_-]*)(?:\s|$)/i.exec(line);
    if (match) commands.add(match[1]!.toLowerCase());
  }
  return [...commands].sort();
}

export function dedupeSkills(files: DiscoveredSkillFile[]): DiscoveredSkillEntry[] {
  const byIdentity = new Map<string, DiscoveredSkillEntry>();
  const activePriority = new Map<string, string>();

  for (const file of files) {
    const identity = skillIdentity(file);
    if (!identity) continue;
    const nextPriority = priority(file);
    const contentHash = djb2(file.content);
    const existing = byIdentity.get(identity);

    if (!existing) {
      byIdentity.set(identity, {
        id: `skill:${djb2(identity)}`,
        name: file.name,
        description: file.description,
        content: file.content,
        slashCommands: slashCommandsFromContent(file.content),
        scope: file.scope,
        root: file.root,
        contentHash,
        sources: [sourceOf(file, true)],
      });
      activePriority.set(identity, nextPriority);
      continue;
    }

    const currentPriority = activePriority.get(identity) ?? "";
    const shouldReplace = nextPriority < currentPriority;
    existing.sources.push(sourceOf(file, shouldReplace));
    if (shouldReplace) {
      for (const source of existing.sources) source.active = source.path === file.sourcePath;
      existing.name = file.name;
      existing.description = file.description ?? existing.description;
      existing.content = file.content;
      existing.slashCommands = slashCommandsFromContent(file.content);
      existing.scope = file.scope;
      existing.root = file.root;
      existing.contentHash = contentHash;
      activePriority.set(identity, nextPriority);
    }
  }

  return [...byIdentity.values()].sort((a, b) => skillIdentity(a).localeCompare(skillIdentity(b)));
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9:_-]*/g)
      ?.map((w) => w.trim())
      .filter((w) => w.length >= 3) ?? [],
  );
}

function splitName(name: string): string[] {
  return skillIdentity({ name })
    .split(/[:_-]+/)
    .filter((w) => w.length >= 3);
}

function hasRelatedWord(promptWords: Set<string>, term: string): boolean {
  for (const word of promptWords) {
    if (word === term) return true;
    if (word.length >= 5 && term.length >= 5 && (word.startsWith(term) || term.startsWith(word))) {
      return true;
    }
    if (word.length >= 5 && term.length >= 4 && word.startsWith(term)) {
      return true;
    }
  }
  return false;
}

function scoreSkill(skill: DiscoveredSkillEntry, prompt: string): number {
  const lower = prompt.toLowerCase();
  const identity = skillIdentity(skill);
  if (!identity) return 0;
  let score = 0;
  if (lower.includes(`$${identity}`)) score += 1000;
  if (lower.includes(`/${identity}`)) score += 1000;
  if (skill.slashCommands.some((command) => lower.includes(`/${command}`))) score += 1000;
  if (lower.includes(identity)) score += 100;

  const promptWords = words(prompt);
  for (const part of splitName(skill.name)) {
    if (hasRelatedWord(promptWords, part)) score += 12;
  }
  for (const term of words(skill.description ?? "")) {
    if (hasRelatedWord(promptWords, term)) score += 2;
  }
  return score;
}

export function selectSkillsForPrompt(
  skills: DiscoveredSkillEntry[],
  prompt: string,
  limit = 3,
): DiscoveredSkillEntry[] {
  const ranked = skills
    .map((skill) => ({ skill, score: scoreSkill(skill, prompt) }))
    .filter((item) => item.score >= 12)
    .sort((a, b) => b.score - a.score || skillIdentity(a.skill).localeCompare(skillIdentity(b.skill)));
  return ranked.slice(0, limit).map((item) => item.skill);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 30)).trimEnd()}\n[skill content truncated]`;
}

export function buildSkillContextForPrompt(
  skills: DiscoveredSkillEntry[],
  prompt: string,
  opts: { maxSkills?: number; maxChars?: number } = {},
): string | undefined {
  const selected = selectSkillsForPrompt(skills, prompt, opts.maxSkills ?? 3);
  if (selected.length === 0) return undefined;

  const maxChars = opts.maxChars ?? 12_000;
  const perSkill = Math.max(1_000, Math.floor(maxChars / selected.length));
  const blocks = selected.map((skill) => {
    const source = skill.sources.find((s) => s.active) ?? skill.sources[0];
    const sourceLabel = source ? `${source.tool}/${source.scope}` : "unknown";
    return [
      `--- skill: ${skill.name} (${sourceLabel}) ---`,
      truncate(skill.content.trim(), perSkill),
    ].join("\n");
  });

  return [
    "[Agent skills]",
    "Use the following skill instructions when they are relevant to this turn. They are discovered from local agent skill files and are not MCP tools.",
    ...blocks,
    "[/Agent skills]",
  ].join("\n\n");
}
