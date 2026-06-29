import { describe, expect, it } from "bun:test";
import {
  buildSkillContextForPrompt,
  dedupeSkills,
  selectSkillsForPrompt,
  type DiscoveredSkillFile,
} from "./skill-discovery.ts";

function skill(overrides: Partial<DiscoveredSkillFile> & { name: string }): DiscoveredSkillFile {
  return {
    name: overrides.name,
    description: overrides.description,
    content: overrides.content ?? `# ${overrides.name}\nBody`,
    tool: overrides.tool ?? "claude",
    scope: overrides.scope ?? "global",
    root: overrides.root,
    sourcePath: overrides.sourcePath ?? `/skills/${overrides.name}/SKILL.md`,
  };
}

describe("skill discovery", () => {
  it("dedupes the same skill across tools and prefers project scope", () => {
    const entries = dedupeSkills([
      skill({
        name: "review",
        tool: "claude",
        scope: "global",
        content: "claude global",
        sourcePath: "/home/.claude/skills/review/SKILL.md",
      }),
      skill({
        name: "review",
        tool: "codex",
        scope: "project",
        root: "/repo",
        content: "codex project",
        sourcePath: "/repo/.codex/skills/review/SKILL.md",
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.content).toBe("codex project");
    expect(entries[0]!.scope).toBe("project");
    expect(entries[0]!.root).toBe("/repo");
    expect(entries[0]!.sources.map((s) => `${s.tool}:${s.scope}:${s.active}`)).toEqual([
      "claude:global:false",
      "codex:project:true",
    ]);
  });

  it("prefers Codex over Claude for same-scope duplicates", () => {
    const entries = dedupeSkills([
      skill({ name: "docs", tool: "claude", content: "claude", sourcePath: "/a/SKILL.md" }),
      skill({ name: "docs", tool: "codex", content: "codex", sourcePath: "/b/SKILL.md" }),
    ]);

    expect(entries[0]!.content).toBe("codex");
    expect(entries[0]!.sources.find((s) => s.active)?.tool).toBe("codex");
  });

  it("selects skills by explicit name, name parts, and description terms", () => {
    const entries = dedupeSkills([
      skill({ name: "agile-proto", description: "Create interactive UI prototypes" }),
      skill({ name: "openai-docs", description: "Use OpenAI documentation" }),
      skill({
        name: "security-scan",
        description: "Review vulnerabilities",
        content: '# Security Scan\n/security-scan "target"',
      }),
    ]);

    expect(selectSkillsForPrompt(entries, "please build a prototype").map((s) => s.name)).toEqual([
      "agile-proto",
    ]);
    expect(selectSkillsForPrompt(entries, "use $openai-docs").map((s) => s.name)).toEqual([
      "openai-docs",
    ]);
    expect(selectSkillsForPrompt(entries, "/security-scan this diff").map((s) => s.name)).toEqual([
      "security-scan",
    ]);
    expect(entries.find((s) => s.name === "security-scan")?.slashCommands).toEqual([
      "security-scan",
    ]);
  });

  it("builds a bounded context block for selected skills", () => {
    const entries = dedupeSkills([
      skill({
        name: "openai-docs",
        description: "Use OpenAI documentation",
        content: "# OpenAI Docs\n" + "x".repeat(2_000),
      }),
    ]);

    const context = buildSkillContextForPrompt(entries, "check OpenAI docs", {
      maxChars: 1_200,
    });
    expect(context).toContain("[Agent skills]");
    expect(context).toContain("--- skill: openai-docs");
    expect(context).toContain("[skill content truncated]");
  });
});
