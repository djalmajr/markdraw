import { describe, expect, it } from "bun:test";
import { openCodeReasoningVariants, reasoningLevelsFor } from "./reasoning.ts";

// The expected sets are the OpenCode `variants()` table (transform.ts), checked
// against the real built-in model ids in builtin-providers.ts.
describe("openCodeReasoningVariants", () => {
  it("hides the picker for excluded families (qwen / kimi / non-5.2 glm / non-m3 minimax / non-mini grok)", () => {
    for (const id of [
      "qwen3.7-plus",
      "qwen3.7-max",
      "qwen3.8-flash",
      "qwen4-max",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "kimi-k3",
      "kimi-k3.1-pro",
      "glm-5.1",
      "glm-5",
      "glm-5.3",
      "glm-5.3-flash",
      "minimax-m2.7",
      "minimax-m2.5",
      "grok-build",
      "grok-composer-2.5-fast",
      "grok-4.6",
      "grok-4.5",
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
    // The four builtin ids plus the dotted display names printed by `agy models`.
    for (const id of [
      "claude-opus-5-5",
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-fable-5-2",
      "claude opus 5.5 (high)",
      "claude sonnet 5.5 (low)",
    ])
      expect(openCodeReasoningVariants(id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
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
    // Current Codex cache + models.dev `openai` reasoning_options.
    for (const id of ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra"])
      expect(openCodeReasoningVariants(id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    for (const id of [
      "gpt-6.1-terra",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ])
      expect(openCodeReasoningVariants(id)).toEqual([
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
  });

  it("maps the per-family special cases", () => {
    expect(openCodeReasoningVariants("deepseek-v4-pro")).toEqual(["low", "medium", "high", "max"]);
    expect(openCodeReasoningVariants("minimax-m3")).toEqual(["none", "thinking"]);
    expect(openCodeReasoningVariants("glm-5.2")).toEqual(["high", "max"]);
    expect(openCodeReasoningVariants("grok-3-mini")).toEqual(["low", "high"]);
    // Current OpenCode Go catalog / agy display names.
    expect(openCodeReasoningVariants("minimax-m3.1-flash")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    for (const id of ["gemini-4-neon-high", "gemini 4 hydrogen (xhigh)"])
      expect(openCodeReasoningVariants(id)).toEqual(["low", "medium", "high", "xhigh"]);
    for (const id of ["gemini-4-argon-medium", "gemini 3.8 flash (high)"])
      expect(openCodeReasoningVariants(id)).toEqual(["low", "medium", "high"]);
  });

  it("returns null for unrecognised models (caller falls back to models.dev)", () => {
    expect(openCodeReasoningVariants("mimo-v2.5-pro")).toBeNull();
    expect(openCodeReasoningVariants("some-unknown-model")).toBeNull();
    expect(openCodeReasoningVariants("orchestrator (neon)")).toBeNull(); // no published levels
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
    expect(reasoningLevelsFor("gemini 4 argon (high)")).toEqual([
      "default",
      "low",
      "medium",
      "high",
    ]);
    expect(reasoningLevelsFor("gpt-6.2-sol")).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
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
