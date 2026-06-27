import { describe, expect, it } from "bun:test";
import { openCodeReasoningVariants, reasoningLevelsFor } from "./reasoning.ts";

// The expected sets are the OpenCode `variants()` table (transform.ts), checked
// against the real built-in model ids in builtin-providers.ts.
describe("openCodeReasoningVariants", () => {
  it("hides the picker for excluded families (qwen / kimi / non-5.2 glm / non-m3 minimax / non-mini grok)", () => {
    for (const id of [
      "qwen3.7-plus",
      "qwen3.7-max",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "glm-5.1",
      "glm-5",
      "minimax-m2.7",
      "minimax-m2.5",
      "grok-build",
      "grok-composer-2.5-fast",
      "deepseek-chat",
      "deepseek-v3",
    ]) {
      expect(openCodeReasoningVariants(id)).toEqual([]);
    }
  });

  it("maps Claude by version (hyphenated ids)", () => {
    expect(openCodeReasoningVariants("claude-opus-4-8")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(openCodeReasoningVariants("claude-sonnet-4-6")).toEqual(["low", "medium", "high", "max"]);
    expect(openCodeReasoningVariants("claude-haiku-4-5")).toEqual(["high", "max"]);
  });

  it("maps GPT-5.x by version (dotted ids)", () => {
    expect(openCodeReasoningVariants("gpt-5.5")).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(openCodeReasoningVariants("gpt-5.4-mini")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(openCodeReasoningVariants("gpt-5.3-codex-spark")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("maps the per-family special cases", () => {
    expect(openCodeReasoningVariants("deepseek-v4-pro")).toEqual(["low", "medium", "high", "max"]);
    expect(openCodeReasoningVariants("minimax-m3")).toEqual(["none", "thinking"]);
    expect(openCodeReasoningVariants("glm-5.2")).toEqual(["high", "max"]);
    expect(openCodeReasoningVariants("grok-3-mini")).toEqual(["low", "high"]);
  });

  it("returns null for unrecognised models (caller falls back to models.dev)", () => {
    expect(openCodeReasoningVariants("mimo-v2.5-pro")).toBeNull();
    expect(openCodeReasoningVariants("some-unknown-model")).toBeNull();
  });
});

describe("reasoningLevelsFor", () => {
  it('prepends "default" to a non-empty table result', () => {
    expect(reasoningLevelsFor("claude-opus-4-8")).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(reasoningLevelsFor("minimax-m3")).toEqual(["default", "none", "thinking"]);
  });

  it("returns no levels for an excluded model", () => {
    expect(reasoningLevelsFor("qwen3.7-plus")).toEqual([]);
  });

  it("uses an explicit override verbatim (no default prepended)", () => {
    expect(reasoningLevelsFor("anything", { override: ["default", "high"] })).toEqual([
      "default",
      "high",
    ]);
    expect(reasoningLevelsFor("claude-opus-4-8", { override: [] })).toEqual([]);
  });

  it("falls back to models.dev for unrecognised models (boolean + no options)", () => {
    // reasoning: true with no declared options ⇒ generic menu (e.g. MiMo).
    expect(reasoningLevelsFor("mimo-v2.5-pro", { modelsDev: { reasoning: true } })).toEqual([
      "default",
      "low",
      "medium",
      "high",
    ]);
    expect(
      reasoningLevelsFor("mimo-v2.5-pro", { modelsDev: { reasoning: true, reasoning_options: [] } }),
    ).toEqual(["default", "low", "medium", "high"]);
    expect(reasoningLevelsFor("mimo-v2.5-pro", { modelsDev: { reasoning: false } })).toEqual([]);
    expect(reasoningLevelsFor("mimo-v2.5-pro")).toEqual([]); // unknown ⇒ hide
  });

  it("derives the fallback menu from models.dev reasoning_options shapes", () => {
    const lvl = (reasoning_options: { type: string; values?: string[]; max?: number }[]) =>
      reasoningLevelsFor("some-unknown-model", { modelsDev: { reasoning: true, reasoning_options } });
    // effort → the declared values we know how to forward
    expect(lvl([{ type: "effort", values: ["high", "max"] }])).toEqual(["default", "high", "max"]);
    // toggle → none/thinking
    expect(lvl([{ type: "toggle" }])).toEqual(["default", "none", "thinking"]);
    // budget_tokens only → hidden (no discrete label to serialise yet)
    expect(lvl([{ type: "budget_tokens", max: 32000 }])).toEqual([]);
    // unknown effort labels → don't invent a menu
    expect(lvl([{ type: "effort", values: ["weird"] }])).toEqual([]);
  });
});
