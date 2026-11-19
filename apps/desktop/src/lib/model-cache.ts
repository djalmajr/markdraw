// Fetched model catalogs live in localStorage, separate from ai.json: the
// latter holds only what the user typed (see ai-config.ts). A malformed cache
// is treated as absent — builtins/manual models must always remain usable.

import type { CachedModel, ModelCache, ModelCacheEntry } from "@markdraw/ai/config-schema.ts";
import { REASONING_LABELS } from "@markdraw/ai/reasoning.ts";

/** Versioned so a future cache shape can migrate without reading stale data. */
export const MODEL_CACHE_KEY = "markdraw-ai-model-cache.v1";
/** Validity of a fetched list — the freshness UI/auto-refresh owner uses this. */
export const MODEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Only the two localStorage operations this module needs; injectable in tests. */
export type ModelCacheStorage = Pick<Storage, "getItem" | "setItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Keep only fields the resolved model config understands; hostile JSON can
 *  contain arrays, strings or objects where a number/name was expected. */
function parseCachedModel(value: unknown): CachedModel | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name : undefined;
  const rawLimit = value.limit;
  let limit: CachedModel["limit"];
  if (isRecord(rawLimit)) {
    const context = optionalFiniteNumber(rawLimit.context);
    const output = optionalFiniteNumber(rawLimit.output);
    if (context !== undefined || output !== undefined) {
      limit = { ...(context !== undefined ? { context } : {}), ...(output !== undefined ? { output } : {}) };
    }
  }
  const reasoning = Array.isArray(value.reasoning)
    ? value.reasoning.filter(
        (level): level is NonNullable<CachedModel["reasoning"]>[number] =>
          typeof level === "string" && (REASONING_LABELS as readonly string[]).includes(level),
      )
    : undefined;
  if (name === undefined && limit === undefined && !reasoning?.length) return null;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(limit ? { limit } : {}),
    ...(reasoning?.length ? { reasoning } : {}),
  };
}

/** Pure: parse the raw localStorage value into a per-provider cache, dropping
 *  invalid JSON and malformed entries instead of throwing. */
export function parseModelCache(raw: string | null | undefined): ModelCache {
  const cache: ModelCache = Object.create(null);
  if (!raw) return cache;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return cache;
  }
  if (!isRecord(parsed)) return cache;
  for (const [providerId, rawEntry] of Object.entries(parsed)) {
    if (!providerId || !isRecord(rawEntry)) continue;
    if (typeof rawEntry.source !== "string" || typeof rawEntry.fetchedAt !== "string") continue;
    if (!isRecord(rawEntry.models)) continue;
    const models: Record<string, CachedModel> = Object.create(null);
    for (const [modelId, rawModel] of Object.entries(rawEntry.models)) {
      const model = parseCachedModel(rawModel);
      if (modelId) models[modelId] = model ?? { name: modelId };
    }
    cache[providerId] = { source: rawEntry.source, fetchedAt: rawEntry.fetchedAt, models };
  }
  return cache;
}

/** Read the cache from localStorage; any read failure degrades to no cache. */
export function readModelCache(storage: ModelCacheStorage = globalThis.localStorage): ModelCache {
  try {
    return parseModelCache(storage.getItem(MODEL_CACHE_KEY));
  } catch {
    return Object.create(null);
  }
}

/** Replace one provider's cached list. Never touches ai.json. */
export function writeModelCache(
  providerId: string,
  models: Record<string, CachedModel>,
  source: string,
  storage: ModelCacheStorage = globalThis.localStorage,
  fetchedAt: string = new Date().toISOString(),
): void {
  if (!providerId) return;
  const cache = readModelCache(storage);
  const entry: ModelCacheEntry = { source, fetchedAt, models: Object.create(null) };
  for (const [modelId, rawModel] of Object.entries(models)) {
    const model = parseCachedModel(rawModel);
    if (modelId) entry.models[modelId] = model ?? { name: modelId };
  }
  cache[providerId] = entry;
  storage.setItem(MODEL_CACHE_KEY, JSON.stringify(cache));
}

/** Cache a fetched id list from an OpenAI-compatible `/models` response. */
export function saveFetchedModels(
  providerId: string,
  ids: string[],
  source: string,
  storage?: ModelCacheStorage,
): void {
  const models: Record<string, CachedModel> = Object.create(null);
  for (const id of ids) if (id) models[id] = { name: id };
  writeModelCache(providerId, models, source, storage);
}
