// Lightweight, UI-facing AI preferences persisted in localStorage — the
// *selection* (which engine, which model, which indexing tier), kept separate
// from the heavier provider catalog (packages/ai). Mirrors editor-prefs.ts.
//
// Per the M1 decisions: no default model (empty until the user configures a
// provider), default indexing tier "lite" (ADR-002), default engine "ai-sdk".

/** Indexing tier (ADR-002). Logic is M2; M1 only persists/shows the choice. */
type IndexingTier = "off" | "lite" | "full";

/** Which SDK speaks to providers. Mirrors `AIEngineId` in `@markdraw/ai`
 *  (duplicated here so core stays free of an ai dependency — core is the base
 *  package that ai itself depends on). */
type AIEngineId = "ai-sdk" | "tanstack";

/** Chat mode:
 *  - "plan" produces a saved plan with no tools;
 *  - "build" implements with the full tool set and auto-runs tool calls;
 *  - "ask" implements with the full tool set but asks before every tool call. */
type AIChatMode = "ask" | "build" | "plan";

/** Reasoning effort forwarded to providers that support it (the engine maps it
 *  per provider kind). Labels mirror OpenCode's per-model effort menu (see
 *  `@markdraw/ai/reasoning.ts`); the available subset depends on the model.
 *  "default" (the default) leaves the request unchanged — the model uses its own
 *  default effort. "none" explicitly disables thinking; "thinking" enables it. */
type AIReasoningEffort =
  | "default"
  | "none"
  | "thinking"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Every valid stored effort — anything else (incl. the legacy "off") reads back
 *  as "default". */
const REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "default",
  "none",
  "thinking",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const MODE_KEY = "markdraw-ai-mode";
const ENGINE_KEY = "markdraw-ai-engine";
const MODEL_KEY = "markdraw-ai-model";
const SMALL_MODEL_KEY = "markdraw-ai-small-model";
const EMBEDDING_MODEL_KEY = "markdraw-ai-embedding-model";
const TIER_KEY = "markdraw-ai-indexing-tier";
const STREAMING_KEY = "markdraw-ai-streaming";
const REASONING_KEY = "markdraw-ai-reasoning";
const HIDDEN_MODELS_KEY = "markdraw-ai-hidden-models";
const CONNECTED_SUBS_KEY = "markdraw-ai-connected-subscriptions";

function getStoredAiMode(): AIChatMode {
  const stored = localStorage.getItem(MODE_KEY);
  if (stored === "ask" || stored === "plan") return stored;
  return "build";
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

/** Reasoning effort. Default "default"; lenient read falls back to "default" for
 *  any unknown/garbage stored value (including the legacy "off"). */
function getStoredAiReasoning(): AIReasoningEffort {
  const stored = localStorage.getItem(REASONING_KEY);
  if (stored && REASONING_EFFORTS.has(stored)) return stored as AIReasoningEffort;
  return "default";
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

/** Provider ids of CLI subscriptions (claude-sub / codex-sub) the user has
 *  explicitly connected. Unlike API providers — whose "connected" state is
 *  derived from a stored keychain key — a subscription has no key, so its
 *  connection is persisted here and NEVER auto-probed on startup. Lenient read
 *  drops malformed blobs. */
function getStoredConnectedSubscriptions(): string[] {
  const raw = localStorage.getItem(CONNECTED_SUBS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function setStoredConnectedSubscriptions(ids: string[]): void {
  localStorage.setItem(CONNECTED_SUBS_KEY, JSON.stringify([...new Set(ids)]));
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
  getStoredConnectedSubscriptions,
  setStoredConnectedSubscriptions,
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
