// models.dev — the community model catalog OpenCode draws from. We use it as the
// AUTHORITATIVE source for which models support reasoning and which effort
// levels they expose, instead of guessing. The catalog keys models by provider;
// the SAME model id can carry different `reasoning_options` under different
// providers (a model's effort menu depends on who serves it), so we index by
// provider and resolve a markdraw provider to its models.dev counterpart.

const MODELS_DEV_URL = "https://models.dev/api.json";

/** A minimal fetch — global `fetch` and the Tauri HTTP plugin's `fetch` (which
 *  carries extra client options) both satisfy it. Avoids requiring the full
 *  `typeof fetch` (whose `preconnect` member the Tauri impl lacks). */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A reasoning control a model exposes, as declared by models.dev. `effort`
 *  carries the discrete levels; `toggle` is on/off thinking; `budget_tokens`
 *  is a continuous budget (no discrete menu). */
export interface ReasoningOption {
  type: "effort" | "toggle" | "budget_tokens" | string;
  values?: string[];
  max?: number;
}

export interface ModelsDevModel {
  reasoning?: boolean;
  reasoning_options?: ReasoningOption[];
}

/** provider id → (model id → reasoning metadata). Only reasoning fields kept. */
export type ModelsDevReasoningIndex = Record<string, Record<string, ModelsDevModel>>;

/** Fetch models.dev/api.json and keep only each model's reasoning metadata,
 *  indexed by provider then model id. The full catalog is ~2.3 MB; the caller
 *  is expected to cache the (small) result. Throws on a non-OK response. */
export async function fetchModelsDevReasoning(
  fetchImpl: FetchLike = fetch,
): Promise<ModelsDevReasoningIndex> {
  const res = await fetchImpl(MODELS_DEV_URL);
  if (!res.ok) throw new Error(`models.dev request failed (${res.status} ${res.statusText})`);
  const catalog = (await res.json()) as Record<
    string,
    { models?: Record<string, ModelsDevModel> } | undefined
  >;
  const index: ModelsDevReasoningIndex = {};
  for (const [providerId, provider] of Object.entries(catalog)) {
    const models = provider?.models;
    if (!models) continue;
    const out: Record<string, ModelsDevModel> = {};
    for (const [modelId, model] of Object.entries(models)) {
      if (typeof model?.reasoning === "boolean") {
        out[modelId] = {
          reasoning: model.reasoning,
          ...(model.reasoning_options ? { reasoning_options: model.reasoning_options } : {}),
        };
      }
    }
    if (Object.keys(out).length > 0) index[providerId] = out;
  }
  return index;
}

/** Map a markdraw provider id to its models.dev provider id. The subscription/
 *  CLI providers reuse the underlying vendor's catalog (Claude CLI → anthropic,
 *  Codex → openai, Grok CLI → xai), and OpenCode Go's two API-shape entries
 *  both resolve to the single "opencode-go" models.dev provider. Unmapped
 *  providers (local Ollama/LM Studio, custom) have no catalog entry. */
const PROVIDER_TO_MODELS_DEV: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  xai: "xai",
  "opencode-go": "opencode-go",
  "opencode-go-chat": "opencode-go",
  "opencode-zen": "opencode",
  gemini: "google",
  "claude-sub": "anthropic",
  "codex-sub": "openai",
  "grok-sub": "xai",
};

export function modelsDevProviderFor(markdrawProviderId: string): string | undefined {
  return PROVIDER_TO_MODELS_DEV[markdrawProviderId];
}

/** Look up a model's reasoning metadata in the index, resolving the markdraw
 *  provider to its models.dev provider. Returns null when the provider isn't
 *  mapped or the model isn't in the catalog. */
export function modelsDevReasoningFor(
  index: ModelsDevReasoningIndex,
  markdrawProviderId: string,
  modelId: string,
): ModelsDevModel | null {
  const mdProvider = modelsDevProviderFor(markdrawProviderId);
  if (!mdProvider) return null;
  return index[mdProvider]?.[modelId] ?? null;
}
