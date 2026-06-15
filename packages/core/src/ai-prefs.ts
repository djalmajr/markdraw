// Lightweight, UI-facing AI preferences persisted in localStorage — the
// *selection* (which engine, which model, which indexing tier), kept separate
// from the heavier provider catalog (packages/ai). Mirrors editor-prefs.ts.
//
// Per the M1 decisions: no default model (empty until the user configures a
// provider), default indexing tier "lite" (ADR-002), default engine "ai-sdk".

/** Indexing tier (ADR-002). Logic is M2; M1 only persists/shows the choice. */
type IndexingTier = "off" | "lite" | "full";

/** Which SDK speaks to providers. Mirrors `AIEngineId` in `@asciimark/ai`
 *  (duplicated here so core stays free of an ai dependency — core is the base
 *  package that ai itself depends on). */
type AIEngineId = "ai-sdk" | "tanstack";

/** Chat mode: "plan" produces a saved plan with no editing tools; "build"
 *  implements with the full tool set. */
type AIChatMode = "build" | "plan";

/** Reasoning effort forwarded to providers that support it (the engine maps it
 *  per provider kind). "off" (the default) leaves requests unchanged. */
type AIReasoningEffort = "off" | "low" | "medium" | "high";

const MODE_KEY = "asciimark-ai-mode";
const ENGINE_KEY = "asciimark-ai-engine";
const MODEL_KEY = "asciimark-ai-model";
const SMALL_MODEL_KEY = "asciimark-ai-small-model";
const EMBEDDING_MODEL_KEY = "asciimark-ai-embedding-model";
const TIER_KEY = "asciimark-ai-indexing-tier";
const STREAMING_KEY = "asciimark-ai-streaming";
const REASONING_KEY = "asciimark-ai-reasoning";
const HIDDEN_MODELS_KEY = "asciimark-ai-hidden-models";

function getStoredAiMode(): AIChatMode {
  return localStorage.getItem(MODE_KEY) === "plan" ? "plan" : "build";
}

function setStoredAiMode(mode: AIChatMode): void {
  localStorage.setItem(MODE_KEY, mode);
}

function getStoredAiEngine(): AIEngineId {
  return localStorage.getItem(ENGINE_KEY) === "tanstack" ? "tanstack" : "ai-sdk";
}

function setStoredAiEngine(engine: AIEngineId): void {
  localStorage.setItem(ENGINE_KEY, engine);
}

/** Selected chat model as a "provider/model" id, or null when unconfigured
 *  (the M1 default — the panel/Settings prompt the user to pick one). */
function getStoredAiModel(): string | null {
  return localStorage.getItem(MODEL_KEY);
}

function setStoredAiModel(modelId: string | null): void {
  if (modelId === null) localStorage.removeItem(MODEL_KEY);
  else localStorage.setItem(MODEL_KEY, modelId);
}

/** Selected model for lightweight tasks, or null to fall back to the main model. */
function getStoredAiSmallModel(): string | null {
  return localStorage.getItem(SMALL_MODEL_KEY);
}

function setStoredAiSmallModel(modelId: string | null): void {
  if (modelId === null) localStorage.removeItem(SMALL_MODEL_KEY);
  else localStorage.setItem(SMALL_MODEL_KEY, modelId);
}

/** Selected embedding model ("provider/model") for the "Full" workspace index,
 *  or null when unconfigured. Independent of the chat model — the user picks an
 *  embedding-capable provider/model separately (only OpenAI/openai-compatible
 *  qualify; see `providerCanEmbed`). */
function getStoredAiEmbeddingModel(): string | null {
  return localStorage.getItem(EMBEDDING_MODEL_KEY);
}

function setStoredAiEmbeddingModel(modelId: string | null): void {
  if (modelId === null) localStorage.removeItem(EMBEDDING_MODEL_KEY);
  else localStorage.setItem(EMBEDDING_MODEL_KEY, modelId);
}

function getStoredIndexingTier(): IndexingTier {
  const stored = localStorage.getItem(TIER_KEY);
  if (stored === "off" || stored === "full") return stored;
  return "lite"; // ADR-002: Lite (BM25) is the recommended default
}

function setStoredIndexingTier(tier: IndexingTier): void {
  localStorage.setItem(TIER_KEY, tier);
}

/** Whether to use the streaming engine path (real incremental deltas) instead
 *  of the buffered + fake-typing default. Default false (opt-in beta) until the
 *  WKWebView SSE behaviour is validated; the buffered path is the kill-switch. */
function getStoredAiStreaming(): boolean {
  return localStorage.getItem(STREAMING_KEY) === "true";
}

function setStoredAiStreaming(enabled: boolean): void {
  localStorage.setItem(STREAMING_KEY, enabled ? "true" : "false");
}

/** Reasoning effort. Default "off"; lenient read falls back to "off" for any
 *  unknown/garbage stored value. */
function getStoredAiReasoning(): AIReasoningEffort {
  const stored = localStorage.getItem(REASONING_KEY);
  if (stored === "low" || stored === "medium" || stored === "high") return stored;
  return "off";
}

function setStoredAiReasoning(effort: AIReasoningEffort): void {
  localStorage.setItem(REASONING_KEY, effort);
}

/** Model refs ("provider/model") the user hid from the picker ("Manage models").
 *  Default empty (everything visible); lenient read drops malformed blobs. */
function getStoredHiddenModels(): string[] {
  const raw = localStorage.getItem(HIDDEN_MODELS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function setStoredHiddenModels(refs: string[]): void {
  localStorage.setItem(HIDDEN_MODELS_KEY, JSON.stringify([...new Set(refs)]));
}

export type { AIChatMode, AIEngineId, AIReasoningEffort, IndexingTier };
export {
  getStoredAiMode,
  setStoredAiMode,
  getStoredAiEmbeddingModel,
  setStoredAiEmbeddingModel,
  getStoredAiEngine,
  getStoredAiModel,
  getStoredAiReasoning,
  getStoredAiSmallModel,
  getStoredAiStreaming,
  getStoredHiddenModels,
  getStoredIndexingTier,
  setStoredAiEngine,
  setStoredAiModel,
  setStoredAiReasoning,
  setStoredAiSmallModel,
  setStoredAiStreaming,
  setStoredHiddenModels,
  setStoredIndexingTier,
};
