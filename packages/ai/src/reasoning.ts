// Per-model reasoning-effort levels for the composer's effort picker.
//
// The authoritative source is OpenCode's `variants()` in
// packages/opencode/src/provider/transform.ts (repo anomalyco/opencode, branch
// `dev`) — it, NOT models.dev, decides which effort labels each model shows.
// We port that table here. models.dev is only a secondary signal (its boolean
// `reasoning` flag) for models the table doesn't recognise.
//
// "default" (let the model use its own default — no explicit effort) is always
// the first entry the picker shows; the per-family lists below are weakest →
// strongest, WITHOUT "default" (it's prepended in reasoningLevelsFor).

import type { ModelsDevModel } from "./models-dev.ts";

/** Effort labels the picker can show, in canonical strength order. */
export const REASONING_LABELS = [
  "default",
  "none",
  "thinking",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningLabel = (typeof REASONING_LABELS)[number];

/** OpenCode `variants()` ported. Returns the effort labels (without "default")
 *  a model exposes, or:
 *   - `[]`   → the model is explicitly NO-picker (exclusion list / capability),
 *   - `null` → the model isn't recognised here (caller falls back to models.dev).
 *  Match on the model id (lowercased), mirroring transform.ts's id checks. */
export function openCodeReasoningVariants(modelId: string): ReasoningLabel[] | null {
  const id = modelId.toLowerCase();

  // ── No-picker exclusion list (transform.ts L702–714 + grok/cohere) ──
  // Whole families with no user-facing effort levels.
  if (/qwen|big-pickle|cohere/.test(id)) return [];
  if (/kimi|k2p/.test(id)) return []; // Kimi: thinking on by default, no picker
  if (/glm/.test(id) && !/glm-?5\.2/.test(id)) return []; // only GLM-5.2 has a picker
  if (/minimax/.test(id) && !/minimax-m3/.test(id)) return []; // only MiniMax M3
  if (/deepseek/.test(id) && /(chat|reasoner|r1|v3)/.test(id)) return []; // only V4
  if (/grok/.test(id) && !/grok-3-mini/.test(id)) return []; // only grok-3-mini

  // ── Per-family label sets ──
  if (/glm-?5\.2/.test(id)) return ["high", "max"];
  if (/deepseek-v4/.test(id)) return ["low", "medium", "high", "max"];
  if (/minimax-m3/.test(id)) return ["none", "thinking"];
  if (/grok-3-mini/.test(id)) return ["low", "high"];

  // OpenAI GPT-5.x (transform.ts L517–595)
  if (/gpt-5/.test(id)) {
    if (/pro/.test(id)) return ["medium", "high", "xhigh"];
    if (/codex/.test(id)) return ["none", "low", "medium", "high", "xhigh"];
    if (/gpt-5\.(?:[2-9]|\d\d)/.test(id)) return ["none", "low", "medium", "high", "xhigh"];
    if (/gpt-5\.1/.test(id)) return ["none", "low", "medium", "high"];
    return ["minimal", "low", "medium", "high"]; // base gpt-5
  }

  // Anthropic Claude (transform.ts L598–624, adaptive efforts). markdraw ids use
  // HYPHENS for the Claude version (claude-opus-4-8), so match "-<major>-<minor>"
  // rather than a dotted version (unlike GPT-5.x / GLM-5.2 above, which use dots).
  if (/claude|^opus|^sonnet|^haiku|fable/.test(id)) {
    if (/opus-4-[789]|-[5-9]-\d|fable/.test(id)) return ["low", "medium", "high", "xhigh", "max"];
    if (/-4-6(?!\d)/.test(id)) return ["low", "medium", "high", "max"];
    return ["high", "max"]; // classic thinking budget (e.g. Haiku 4.5)
  }

  // Google Gemini (transform.ts L626–663)
  if (/gemini-3/.test(id)) return /flash/.test(id) ? ["minimal", "low", "medium", "high"] : ["low", "medium", "high"];
  if (/gemini-2\.5/.test(id)) return ["high", "max"];

  return null; // unrecognised — let models.dev decide
}

/** Fallback effort levels for a model the OpenCode table doesn't recognise,
 *  derived from what models.dev actually declares (not a blanket low/medium/high
 *  — that could offer discrete levels to a toggle/budget-only model and make the
 *  engine forward unsupported request options):
 *   - `reasoning` not true            → [] (hide)
 *   - an `effort` option with values  → the values we know how to forward
 *   - a `toggle` option               → none/thinking
 *   - a `budget_tokens` option only   → [] (no discrete label to serialise yet)
 *   - reasoning true, no options      → generic low/medium/high */
function fallbackLevelsFromModelsDev(model: ModelsDevModel | null | undefined): ReasoningLabel[] {
  if (!model || model.reasoning !== true) return [];
  const options = model.reasoning_options ?? [];
  const effort = options.find((o) => o.type === "effort");
  if (effort?.values?.length) {
    const known = effort.values.filter((v): v is ReasoningLabel =>
      (REASONING_LABELS as readonly string[]).includes(v),
    );
    if (known.length > 0) return known;
  }
  if (options.some((o) => o.type === "toggle")) return ["none", "thinking"];
  if (options.some((o) => o.type === "budget_tokens")) return [];
  return options.length === 0 ? ["low", "medium", "high"] : [];
}

/** The composer's effort menu for a model, in display order ("default" first).
 *  Resolution order:
 *   1. `opts.override` — an explicit `model.reasoning` from ai.json, used verbatim
 *      (the user controls the exact menu; empty ⇒ no picker).
 *   2. the ported OpenCode table (`openCodeReasoningVariants`).
 *   3. when the table doesn't recognise the model, models.dev's declared options
 *      (see `fallbackLevelsFromModelsDev`).
 *  Empty array ⇒ no picker. */
export function reasoningLevelsFor(
  modelId: string,
  opts?: { modelsDev?: ModelsDevModel | null; override?: readonly ReasoningLabel[] },
): ReasoningLabel[] {
  if (opts?.override) return [...opts.override];
  const variants = openCodeReasoningVariants(modelId) ?? fallbackLevelsFromModelsDev(opts?.modelsDev);
  return variants.length > 0 ? ["default", ...variants] : [];
}
