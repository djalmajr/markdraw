// Fetch the live model list from an OpenAI-compatible provider's `/models`
// endpoint (DJA-11F / DJA-15). Drives the model <select> in Settings so the user
// picks from what the provider actually offers, instead of a hardcoded list.

export interface CatalogModel {
  id: string;
  name?: string;
}

export type ModelCatalogFetch = (input: string, init?: RequestInit) => Promise<Response>;

export const OPENCODE_GO_PROVIDER_IDS = ["opencode-go", "opencode-go-chat"] as const;
export const OPENCODE_GO_REFRESH_GROUP = "opencode-go";
export const OPENCODE_GO_MODEL_CACHE_KEY = "markdraw:opencode-go-models:v1";
export const MODEL_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

export type OpenCodeGoProviderId = (typeof OPENCODE_GO_PROVIDER_IDS)[number];
export type OpenCodeGoModelEndpoint = "chat-completions" | "messages";
export type ModelCatalogSource = "cache" | "network";

export interface CachedModelCatalogResult {
  error?: string;
  fetchedAt: number;
  models: CatalogModel[];
  source: ModelCatalogSource;
}

export interface ModelCatalogCacheEntry {
  fetchedAt: number;
  models: CatalogModel[];
  version: 1;
}

export interface ModelCatalogStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const OPENCODE_GO_MODEL_NAMES: Record<string, string> = {
  "minimax-m3": "MiniMax M3",
  "minimax-m2.7": "MiniMax M2.7",
  "minimax-m2.5": "MiniMax M2.5",
  "qwen3.7-max": "Qwen3.7 Max",
  "qwen3.7-plus": "Qwen3.7 Plus",
  "qwen3.6-plus": "Qwen3.6 Plus",
  "qwen3.5-plus": "Qwen3.5 Plus",
  "glm-5.2": "GLM-5.2",
  "glm-5.1": "GLM-5.1",
  "glm-5": "GLM-5",
  "kimi-k2.7-code": "Kimi K2.7 Code",
  "kimi-k2.6": "Kimi K2.6",
  "kimi-k2.5": "Kimi K2.5",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "mimo-v2-pro": "MiMo-V2-Pro",
  "mimo-v2-omni": "MiMo-V2-Omni",
  "mimo-v2.5-pro": "MiMo-V2.5-Pro",
  "mimo-v2.5": "MiMo-V2.5",
  "hy3-preview": "HY3 Preview",
};

const OPENCODE_GO_MODEL_ENDPOINTS: Record<string, OpenCodeGoModelEndpoint> = {
  "deepseek-v4-flash": "chat-completions",
  "deepseek-v4-pro": "chat-completions",
  "glm-5": "chat-completions",
  "glm-5.1": "chat-completions",
  "glm-5.2": "chat-completions",
  "hy3-preview": "chat-completions",
  "kimi-k2.5": "chat-completions",
  "kimi-k2.6": "chat-completions",
  "kimi-k2.7-code": "chat-completions",
  "mimo-v2-omni": "chat-completions",
  "mimo-v2-pro": "chat-completions",
  "mimo-v2.5": "chat-completions",
  "mimo-v2.5-pro": "chat-completions",
  "minimax-m2.5": "messages",
  "minimax-m2.7": "messages",
  "minimax-m3": "messages",
  "qwen3.5-plus": "messages",
  "qwen3.6-plus": "messages",
  "qwen3.7-max": "messages",
  "qwen3.7-plus": "messages",
};

export function isOpenCodeGoProviderId(providerId: string): providerId is OpenCodeGoProviderId {
  return providerId === "opencode-go" || providerId === "opencode-go-chat";
}

export function openCodeGoRefreshGroup(providerId: string): string | undefined {
  return isOpenCodeGoProviderId(providerId) ? OPENCODE_GO_REFRESH_GROUP : undefined;
}

export function openCodeGoModelName(modelId: string): string {
  return OPENCODE_GO_MODEL_NAMES[modelId] ?? modelId;
}

export function openCodeGoModelEndpoint(modelId: string): OpenCodeGoModelEndpoint | undefined {
  return OPENCODE_GO_MODEL_ENDPOINTS[modelId];
}

export interface PartitionedOpenCodeGoModels {
  messages: CatalogModel[];
  chatCompletions: CatalogModel[];
  unknown: CatalogModel[];
}

/**
 * OpenCode Go exposes one `/models` list for two API shapes. The endpoint only
 * gives ids, so Markdraw keeps a local family split to route each model through
 * the provider kind that matches its runtime endpoint.
 */
export function partitionOpenCodeGoModels(models: CatalogModel[]): PartitionedOpenCodeGoModels {
  const messages: CatalogModel[] = [];
  const chatCompletions: CatalogModel[] = [];
  const unknown: CatalogModel[] = [];
  for (const model of models) {
    const endpoint = openCodeGoModelEndpoint(model.id);
    if (endpoint === "messages") messages.push(model);
    else if (endpoint === "chat-completions") chatCompletions.push(model);
    else unknown.push(model);
  }
  return { messages, chatCompletions, unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCatalogModel(value: unknown): CatalogModel | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return typeof value.name === "string" ? { id: value.id, name: value.name } : { id: value.id };
}

export function readModelCatalogCache(
  storage: ModelCatalogStorage,
  key = OPENCODE_GO_MODEL_CACHE_KEY,
): ModelCatalogCacheEntry | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.fetchedAt !== "number") {
      return null;
    }
    if (!Array.isArray(parsed.models)) return null;
    const models = parsed.models.flatMap((model) => {
      const parsedModel = parseCatalogModel(model);
      return parsedModel ? [parsedModel] : [];
    });
    if (models.length === 0) return null;
    return { fetchedAt: parsed.fetchedAt, models, version: 1 };
  } catch {
    return null;
  }
}

export function writeModelCatalogCache(
  storage: ModelCatalogStorage,
  models: CatalogModel[],
  now = Date.now(),
  key = OPENCODE_GO_MODEL_CACHE_KEY,
): ModelCatalogCacheEntry {
  const entry: ModelCatalogCacheEntry = { fetchedAt: now, models, version: 1 };
  storage.setItem(key, JSON.stringify(entry));
  return entry;
}

export function isModelCatalogCacheFresh(
  entry: ModelCatalogCacheEntry,
  now = Date.now(),
  ttlMs = MODEL_CATALOG_CACHE_TTL_MS,
): boolean {
  return now - entry.fetchedAt < ttlMs;
}

export async function fetchModelsWithCache(opts: {
  apiKey?: string;
  baseURL: string;
  fetchImpl?: ModelCatalogFetch;
  headers?: Record<string, string>;
  now?: number;
  storage: ModelCatalogStorage;
}): Promise<CachedModelCatalogResult> {
  const now = opts.now ?? Date.now();
  try {
    const models = await fetchModels(
      opts.baseURL,
      opts.apiKey,
      opts.headers,
      opts.fetchImpl ?? fetch,
    );
    // A successful-but-empty `/models` response (e.g. a transient provider
    // hiccup returning `{ data: [] }`) must not overwrite a prior good cache,
    // or the next real network failure would have no offline fallback left.
    // Persist only non-empty lists; still surface the empty result so a
    // legitimately empty provider isn't masked behind stale models.
    if (models.length === 0) {
      return { fetchedAt: now, models, source: "network" };
    }
    const entry = writeModelCatalogCache(opts.storage, models, now);
    return { fetchedAt: entry.fetchedAt, models: entry.models, source: "network" };
  } catch (error) {
    const cached = readModelCatalogCache(opts.storage);
    if (cached) {
      return {
        error: error instanceof Error ? error.message : String(error),
        fetchedAt: cached.fetchedAt,
        models: cached.models,
        source: "cache",
      };
    }
    throw error;
  }
}

/**
 * GET `<baseURL>/models` (OpenAI shape: `{ data: [{ id }] }`). Returns the model
 * ids. Throws on a non-OK response so the caller can surface auth/network errors.
 */
export async function fetchModels(
  baseURL: string,
  apiKey?: string,
  headers?: Record<string, string>,
  /** Custom fetch (e.g. Tauri HTTP plugin) to dodge webview CORS; defaults to
   *  the global fetch. */
  fetchImpl: ModelCatalogFetch = fetch,
): Promise<CatalogModel[]> {
  const url = `${baseURL.replace(/\/+$/, "")}/models`;
  const res = await fetchImpl(url, {
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to list models (${res.status} ${res.statusText})`);
  }
  const json = (await res.json()) as {
    data?: Array<{ id?: string; name?: string }>;
  };
  return (json.data ?? [])
    .filter((m): m is { id: string; name?: string } => typeof m.id === "string")
    .map((m) => ({ id: m.id, name: m.name }));
}
