import { describe, expect, it } from "bun:test";
import {
  buildRuleContextForPrompt,
  dedupeRules,
  evaluateRuleViolations,
  ruleIdentity,
  selectRulesForPrompt,
  type DiscoveredRuleFile,
} from "./ai-rules.ts";

const file = (overrides: Partial<DiscoveredRuleFile> & Pick<DiscoveredRuleFile, "name" | "content">): DiscoveredRuleFile => ({
  scope: "project",
  source: "markdraw",
  sourcePath: `/repo/.markdraw/rules/${ruleIdentity(overrides)}.md`,
  ...overrides,
});

describe("ai rules", () => {
  it("dedupes rules by invocation identity and prefers project Markdraw sources", () => {
    const rules = dedupeRules([
      file({
        content: "global copy",
        name: "Build Rule",
        scope: "global",
        source: "codex",
        sourcePath: "/home/.codex/AGENTS.md",
      }),
      file({
        alwaysApply: true,
        content: "project copy",
        name: "Build Rule",
        sourcePath: "/repo/.markdraw/RULES.md",
      }),
    ]);

    expect(rules).toHaveLength(1);
    expect(rules[0]?.content).toBe("project copy");
    expect(rules[0]?.alwaysApply).toBe(true);
    expect(rules[0]?.sources).toEqual([
      { active: false, path: "/home/.codex/AGENTS.md", scope: "global", source: "codex" },
      { active: true, path: "/repo/.markdraw/RULES.md", scope: "project", source: "markdraw" },
    ]);
  });

  it("selects explicit and semantic matches while always-apply rules enter the context", () => {
    const rules = dedupeRules([
      file({ alwaysApply: true, content: "Always keep edits minimal.", name: "Always" }),
      file({ content: "Use line operations.", description: "JSON operations", name: "Json Ops" }),
      file({ content: "Unrelated", name: "Other" }),
    ]);

    expect(selectRulesForPrompt(rules, "please use #json-ops")).toEqual([rules[1]]);
    const context = buildRuleContextForPrompt(rules, "please use #json-ops");
    expect(context).toContain("Always keep edits minimal.");
    expect(context).toContain("Use line operations.");
    expect(context).not.toContain("Unrelated");
  });

  it("evaluates retry-trigger conditions and ignores invalid regexes", () => {
    const rules = dedupeRules([
      file({ condition: "[", content: "bad regex", name: "Broken" }),
      file({ condition: "created? no tool", content: "Call app__create_file.", name: "Create Files" }),
    ]);

    const violation = evaluateRuleViolations(rules, {
      assistantText: "I created no tool call",
      toolNames: [],
      userMessage: "create a file",
    });

    expect(violation?.rule.name).toBe("Create Files");
    expect(violation?.message).toContain("Create Files");
    expect(violation?.reminder).toContain("Call app__create_file.");
    expect(violation?.signature).toMatch(/^rule:/);
  });

  it("skips regex conditions prone to catastrophic backtracking without hanging", () => {
    const rules = dedupeRules([file({ condition: "(a+)+$", content: "evil", name: "Evil Rule" })]);

    const start = Date.now();
    const violation = evaluateRuleViolations(rules, {
      assistantText: `${"a".repeat(30)}!`,
      toolNames: [],
      userMessage: "hi",
    });

    expect(violation).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("skips overlapping-alternation ReDoS patterns without hanging", () => {
    // Nested quantifiers AND overlapping alternation under a quantifier — the
    // exponential-backtracking families. A dash run in the haystack (a markdown
    // separator the assistant might print) is the trigger the guard must defuse.
    for (const condition of ["(a|a)*$", "(-|-)*z", "(\\d|\\d\\d)*$", "(a*)*$"]) {
      const rules = dedupeRules([file({ condition, content: "x", name: `Evil ${condition}` })]);
      const start = Date.now();
      const violation = evaluateRuleViolations(rules, {
        assistantText: `${"-".repeat(40)} ${"a".repeat(40)}`,
        toolNames: [],
        userMessage: "hi",
      });
      expect(violation).toBeUndefined();
      expect(Date.now() - start).toBeLessThan(500);
    }
  });

  it("still evaluates safe grouped/bounded conditions after the ReDoS guard", () => {
    // Disjoint alternation branches and bounded quantifiers are linear-safe and
    // must NOT be over-flagged (skipped).
    const rules = dedupeRules([
      file({ condition: "(?:remove|delete)+ files", content: "Confirm first.", name: "Cleanup" }),
      file({ condition: "(ab){2,4} done", content: "ok", name: "Bounded" }),
    ]);

    expect(
      evaluateRuleViolations(rules, {
        assistantText: "I will delete files now",
        toolNames: [],
        userMessage: "delete files",
      })?.rule.name,
    ).toBe("Cleanup");

    expect(
      evaluateRuleViolations(rules, {
        assistantText: "abab done",
        toolNames: [],
        userMessage: "go",
      })?.rule.name,
    ).toBe("Bounded");
  });

  it("keeps total rule context within RULE_CONTEXT_CAP despite many always-apply rules", () => {
    const rules = dedupeRules(
      Array.from({ length: 40 }, (_, i) =>
        file({ alwaysApply: true, content: "x".repeat(2000), name: `Rule ${i}` }),
      ),
    );
    const context = buildRuleContextForPrompt(rules, "anything");
    expect(context).toBeTruthy();
    // 40 rules × 2000 chars would be 80k with the old floor; the running budget
    // keeps it near the 12k cap (plus small header/wrapper overhead).
    expect(context!.length).toBeLessThan(14_000);
  });
});
