// Per-provider model-list refresh. One click (or one startup pass) resolves a
// provider's source, parses it with the shared readers and writes ONLY the
// versioned localStorage cache — never ai.json. A failure leaves every cache
// entry untouched, so the old list and hand-written models keep working. A
// selected model dropped by a source keeps its old definition in the new cache
// entry, which is what makes it survive a later launch (there is no `previous`
// config to carry it at boot).

import type { CachedModel, ModelCache } from "@markdraw/ai/config-schema.ts";
import {
  parseAnthropicModels,
  parseAntigravityModels,
  type AnthropicPageState,
  parseGrokModels,
  parseOpenAiCompatibleModels,
  parseOpenCodeModels,
  parseOpenRouterModels,
  type CatalogModel,
} from "@markdraw/ai/model-catalog.ts";
import { parseModelsDevCatalog, type ModelsDevCatalogModel } from "@markdraw/ai/models-dev.ts";
import { REASONING_LABELS } from "@markdraw/ai/reasoning.ts";
import {
  MODEL_CACHE_TTL_MS,
  readModelCache,
  writeModelCache,
  type ModelCacheStorage,
} from "./model-cache.ts";
import {
  codexModelsCache,
  httpGetJson,
  listCliModels,
  type CliModelsProviderId,
  type CodexCachedModel,
} from "./model-sources.ts";

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const MODELS_DEV_URL = "https://models.dev/api.json";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_ANTHROPIC_PAGES = 20;
/** Omitted from every result/error: a fixed string, never an upstream detail. */
export const MODEL_REFRESH_FAILURE = "model-refresh-failed";

export interface RefreshableProvider {
  kind?: string;
  name?: string;
  options?: {
    baseURL?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  };
}

/** A public JSON body fetched WHOLE, with no size cap. */
export type PublicJsonFetch = (url: string) => Promise<unknown>;

/** A minimal fetch: global `fetch` and the Tauri HTTP plugin's `fetch` (which
 *  carries extra client options) both satisfy it. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Adapt a fetch into a {@link PublicJsonFetch}: a non-2xx status is a failure
 *  and the body is parsed whole — nothing here caps its size. Thrown errors
 *  carry no URL, header or upstream text. */
export function publicJsonFetcher(fetchImpl: FetchLike): PublicJsonFetch {
  return async (url: string) => {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error("model list request failed");
    return (await res.json()) as unknown;
  };
}

/** Default source for callers that inject nothing (the app always injects the
 *  plugin's `fetch`): the plugin is loaded lazily so this module stays
 *  importable in tests and outside a Tauri webview. */
const pluginJsonFetch: PublicJsonFetch = async (url: string) => {
  const { fetch: pluginFetch } = await import("@tauri-apps/plugin-http");
  return publicJsonFetcher(pluginFetch)(url);
};

export interface ModelRefreshSources {
  httpGetJson: typeof httpGetJson;
  /** models.dev's catalog only: the Tauri HTTP plugin, which has no 4 MiB body
   *  cap (the native `ai_http_get_json` command rejects api.json as `too_large`). */
  fetchPublicJson: PublicJsonFetch;
  listCliModels: typeof listCliModels;
  codexModelsCache: typeof codexModelsCache;
}

export interface ModelRefreshContext {
  /** Effective config (builtins + manual models); keys are never read from it. */
  providers: Record<string, RefreshableProvider>;
  /** Resolves the user's key from the keychain/refs, or null for no key. */
  apiKeyFor?: (providerId: string) => string | null | Promise<string | null>;
  /** Fakes for tests; production uses the native Tauri commands. */
  sources?: Partial<ModelRefreshSources>;
  storage?: ModelCacheStorage;
  now?: () => Date;
  /** Selected `provider/model` (`getStoredAiModel()`), if any. */
  selectedModel?: string | null;
  /** Its definition in the config loaded BEFORE the refresh (name/limits), so
   *  a source that drops it cannot make it disappear on the next launch. */
  modelDefinition?: (providerId: string, modelId: string) => CachedModel | undefined;
}

export interface ModelRefreshResult {
  ok: boolean;
  /** Provider ids actually written to the cache. */
  refreshed: string[];
  /** Fixed code — no upstream text, URL, header or key. */
  error?: typeof MODEL_REFRESH_FAILURE;
}

type RefreshWrite = { providerId: string; models: Record<string, CachedModel>; source: string };

const OPENCODE_GO_IDS = ["opencode-go", "opencode-go-chat"] as const;
const CLI_KINDS: Record<string, string> = {
  "grok-cli": "grok-sub",
  "antigravity-cli": "antigravity-sub",
  "codex-cli": "codex-sub",
  "claude-cli": "claude-sub",
};

function canonicalId(providerId: string): string {
  return providerId === "opencode-go-chat" ? "opencode-go" : providerId;
}

/** Whether a connect-time refresh must actually fetch for this id. The settings
 *  Connect flow calls the hook once per id of a merged catalog group; ids that
 *  share one model source collapse to their canonical id (see `canonicalId`),
 *  and a refresh of the canonical id already writes every cache entry of the
 *  group. So the alias does not fetch again — the same dedupe the refresh icon
 *  gets from `refreshProviderModels` over the whole group. */
function ownsConnectRefresh(providerId: string): boolean {
  return canonicalId(providerId) === providerId;
}

/** Ids that have a real source. Used by the UI to show the icon only where a
 *  refresh can do something, and by startup to skip unconnected CLIs. */
export function canRefreshProvider(
  providerId: string,
  provider: RefreshableProvider | undefined,
): boolean {
  if (!provider) return false;
  if (OPENCODE_GO_IDS.includes(providerId as (typeof OPENCODE_GO_IDS)[number])) return true;
  if (providerId === "claude-sub" || provider.kind === "claude-cli") return true;
  if (providerId === "codex-sub" || provider.kind === "codex-cli") return true;
  if (CLI_KINDS[provider.kind ?? ""] || CLI_KINDS[providerId]) return true;
  if (providerId === "anthropic") return true;
  return !!provider.options?.baseURL && provider.kind !== "claude-cli";
}

/** Only stale or never-updated providers. Groups sharing one endpoint are
 *  represented by their canonical id, so startup fetches each list once. */
export function staleProviderIds(
  connectedIds: string[],
  cache: ModelCache = readModelCache(),
  now: number = Date.now(),
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of connectedIds) {
    const canonical = canonicalId(id);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const fetchedAt = Date.parse(cache[canonical]?.fetchedAt ?? "");
    if (!Number.isFinite(fetchedAt) || now - fetchedAt >= MODEL_CACHE_TTL_MS) out.push(canonical);
  }
  return out;
}

function toCached(models: CatalogModel[]): Record<string, CachedModel> {
  const out: Record<string, CachedModel> = Object.create(null);
  for (const model of models) {
    if (!model.id || model.deprecated) continue;
    const context =
      typeof model.context === "number" && Number.isFinite(model.context) && model.context > 0
        ? model.context
        : undefined;
    out[model.id] = {
      name: model.name || model.id,
      ...(context !== undefined ? { limit: { context } } : {}),
    };
  }
  return out;
}

function ensureNonEmpty(models: Record<string, CachedModel>): void {
  if (Object.keys(models).length === 0) throw new Error("empty model list");
}

/** Keep the currently selected model in the fresh cache entry when a source
 *  dropped it. The old definition is copied verbatim: same name and limits,
 *  never a synthesized `{ name: id }`. A still-present id is left untouched. */
function retainSelectedModel(writes: RefreshWrite[], ctx: ModelRefreshContext): void {
  const ref = ctx.selectedModel;
  if (!ref) return;
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash >= ref.length - 1) return;
  const providerId = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const target = writes.find((write) => write.providerId === providerId);
  if (!target || target.models[modelId]) return;
  const previous = ctx.modelDefinition?.(providerId, modelId);
  if (!previous) return;
  target.models[modelId] = structuredClone(previous);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("invalid model list response");
  }
}

function urlFor(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/models`;
}

async function getJson(
  sources: ModelRefreshSources,
  url: string,
  headers?: Record<string, string>,
): Promise<unknown> {
  const res = await sources.httpGetJson(url, headers);
  if (res.status < 200 || res.status >= 300) throw new Error("model list request failed");
  return parseJson(res.body);
}

/**
 * The newest Claude model per family in a models.dev catalog. Dated snapshot
 * ids and deprecated entries are excluded, mirroring the curated built-in
 * list (Fable / Opus / Sonnet / Haiku).
 *
 * Recency follows ONE rule per family, decided before any candidate is
 * compared: when EVERY candidate of the family carries a valid
 * `release_date`, the dates decide (a date tie falls back to the version tuple
 * after the family token); when any candidate has no valid date, the version
 * tuple decides for the WHOLE family and the family's dates are ignored. A
 * pairwise "date if both have one" rule is not transitive and made the winner
 * depend on the catalog's order. Both rules are total orders, so the result
 * does not depend on the order of the catalog. Version ties keep that order.
 */
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Epoch milliseconds for a catalog `release_date`, or undefined when absent.
 *  `parseModelsDevCatalog` only keeps a valid `YYYY-MM-DD` calendar day, and
 *  `T00:00:00Z` keeps the conversion timezone-free. */
function releaseTimestamp(model: ModelsDevCatalogModel): number | undefined {
  if (!model.releaseDate) return undefined;
  const parsed = Date.parse(`${model.releaseDate}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface ClaudeCandidate {
  model: CatalogModel;
  version: number[];
  releasedAt?: number;
}

/** > 0 when `candidate` is newer than `prior` under the family's single rule:
 *  with `allDated`, (date, version) lexicographically; otherwise the version
 *  tuple alone, every date in the family ignored. */
function compareRecency(
  candidate: ClaudeCandidate,
  prior: ClaudeCandidate,
  allDated: boolean,
): number {
  if (allDated) {
    const byDate = (candidate.releasedAt ?? 0) - (prior.releasedAt ?? 0);
    if (byDate !== 0) return byDate;
  }
  return compareVersions(candidate.version, prior.version);
}

export function selectClaudeSubscriptionModels(models: ModelsDevCatalogModel[]): CatalogModel[] {
  const families = ["fable", "opus", "sonnet", "haiku"] as const;
  const candidates = new Map<string, ClaudeCandidate[]>();
  for (const model of models) {
    if (model.deprecated || !model.id || /\d{8}/.test(model.id) || /\d{4}-\d{2}-\d{2}/.test(model.id))
      continue;
    const lower = model.id.toLowerCase();
    const family = families.find((f) => lower.includes(f));
    if (!family) continue;
    const after = lower.slice(lower.indexOf(family) + family.length);
    const version = (after.match(/\d+/g) ?? []).map(Number);
    if (version.length === 0) continue;
    const list = candidates.get(family) ?? [];
    list.push({ model, version, releasedAt: releaseTimestamp(model) });
    candidates.set(family, list);
  }
  const best = new Map<string, CatalogModel>();
  for (const [family, list] of candidates) {
    // ONE rule for the whole family, chosen before reducing it.
    const allDated = list.every((c) => c.releasedAt !== undefined);
    let winner = list[0];
    for (const candidate of list.slice(1)) {
      if (compareRecency(candidate, winner, allDated) > 0) winner = candidate;
    }
    best.set(family, winner.model);
  }
  return families.flatMap((f) => (best.has(f) ? [best.get(f)!] : []));
}

async function openAiCompatibleWrite(
  id: string,
  provider: RefreshableProvider,
  ctx: ModelRefreshContext,
  sources: ModelRefreshSources,
): Promise<RefreshWrite> {
  const baseURL = provider.options?.baseURL;
  if (!baseURL) throw new Error("no base URL");
  const key = (await ctx.apiKeyFor?.(id)) ?? null;
  const headers: Record<string, string> = { ...(provider.options?.headers ?? {}) };
  if (key && !Object.keys(headers).some((h) => h.toLowerCase() === "authorization")) {
    headers.Authorization = `Bearer ${key}`;
  }
  const raw = await getJson(sources, urlFor(baseURL), headers);
  const models =
    id === "openrouter"
      ? parseOpenRouterModels(raw)
      : parseOpenAiCompatibleModels(raw, { chatFilter: id === "openai" || provider.kind === "openai" });
  const cached = toCached(models);
  ensureNonEmpty(cached);
  return { providerId: id, models: cached, source: "openai-compatible:/models" };
}

async function anthropicWrite(
  ctx: ModelRefreshContext,
  sources: ModelRefreshSources,
): Promise<RefreshWrite> {
  const key = (await ctx.apiKeyFor?.("anthropic")) ?? null;
  const headers: Record<string, string> = { "anthropic-version": ANTHROPIC_VERSION };
  if (key && !Object.keys(headers).some((h) => h.toLowerCase() === "x-api-key")) {
    headers["x-api-key"] = key;
  }
  const models: CatalogModel[] = [];
  const seenCursors = new Set<string>();
  let afterId: string | undefined;
  for (let page = 0; page < MAX_ANTHROPIC_PAGES; page++) {
    const url = afterId
      ? `${ANTHROPIC_MODELS_URL}?after_id=${encodeURIComponent(afterId)}`
      : ANTHROPIC_MODELS_URL;
    const state: AnthropicPageState = { hasMore: false };
    const rows = parseAnthropicModels(await getJson(sources, url, headers), state);
    models.push(...rows);
    if (!state.hasMore || !state.lastId || seenCursors.has(state.lastId)) break;
    seenCursors.add(state.lastId);
    afterId = state.lastId;
  }
  const cached = toCached(models);
  ensureNonEmpty(cached);
  return { providerId: "anthropic", models: cached, source: "anthropic:/v1/models" };
}

async function openCodeGoWrites(
  provider: RefreshableProvider,
  sources: ModelRefreshSources,
): Promise<RefreshWrite[]> {
  const baseURL = provider.options?.baseURL;
  if (!baseURL) throw new Error("no base URL");
  const lists = parseOpenCodeModels(await getJson(sources, urlFor(baseURL)));
  const messages = toCached(lists.messages);
  const chat = toCached(lists.chatCompletions);
  ensureNonEmpty(messages);
  ensureNonEmpty(chat);
  return [
    { providerId: "opencode-go", models: messages, source: "opencode-go:/models" },
    { providerId: "opencode-go-chat", models: chat, source: "opencode-go:/models" },
  ];
}

async function cliWrite(
  providerId: "grok-sub" | "antigravity-sub",
  sources: ModelRefreshSources,
): Promise<RefreshWrite> {
  const text = await sources.listCliModels(providerId as CliModelsProviderId);
  const models =
    providerId === "grok-sub" ? parseGrokModels(text) : parseAntigravityModels(text);
  const cached: Record<string, CachedModel> = Object.create(null);
  for (const model of models) {
    if (!model.id) continue;
    // `agy --model` takes the DISPLAY name, so the display name is the cache key.
    const key = providerId === "antigravity-sub" ? model.name || model.id : model.id;
    cached[key] = { name: key };
  }
  ensureNonEmpty(cached);
  return {
    providerId,
    models: cached,
    source: providerId === "grok-sub" ? "grok:cli" : "agy:cli",
  };
}

function codexCached(models: CodexCachedModel[]): Record<string, CachedModel> {
  const out: Record<string, CachedModel> = Object.create(null);
  for (const model of models) {
    if (model.visibility !== "list" || !model.slug) continue;
    const efforts = model.reasoningEfforts.filter((level): level is (typeof REASONING_LABELS)[number] =>
      (REASONING_LABELS as readonly string[]).includes(level),
    );
    out[model.slug] = {
      name: model.displayName || model.slug,
      ...(model.contextWindow && model.contextWindow > 0
        ? { limit: { context: model.contextWindow } }
        : {}),
      ...(efforts.length > 0 ? { reasoning: efforts } : {}),
    };
  }
  ensureNonEmpty(out);
  return out;
}

async function claudeSubscriptionWrite(sources: ModelRefreshSources): Promise<RefreshWrite> {
  // The one source fetched through the plugin: models.dev's api.json is ~6.7 MB
  // and the native command answers `too_large` above 4 MiB, so the subscription
  // list could never refresh through it.
  const raw = await sources.fetchPublicJson(MODELS_DEV_URL);
  const catalog = parseModelsDevCatalog(raw);
  const selected = selectClaudeSubscriptionModels(catalog.anthropic ?? []);
  const cached = toCached(selected);
  ensureNonEmpty(cached);
  return { providerId: "claude-sub", models: cached, source: "models.dev:anthropic" };
}

async function resolveWrites(
  id: string,
  ctx: ModelRefreshContext,
  sources: ModelRefreshSources,
): Promise<RefreshWrite[]> {
  const provider = ctx.providers[id];
  if (!provider) throw new Error("unknown provider");
  if (id === "claude-sub" || provider.kind === "claude-cli") {
    return [await claudeSubscriptionWrite(sources)];
  }
  if (id === "codex-sub" || provider.kind === "codex-cli") {
    return [
      {
        providerId: id,
        models: codexCached(await sources.codexModelsCache()),
        source: "codex:cache",
      },
    ];
  }
  if (id === "grok-sub" || provider.kind === "grok-cli") return [await cliWrite("grok-sub", sources)];
  if (id === "antigravity-sub" || provider.kind === "antigravity-cli") {
    return [await cliWrite("antigravity-sub", sources)];
  }
  if (id === "anthropic" || (provider.kind === "anthropic" && !provider.options?.baseURL)) {
    return [await anthropicWrite(ctx, sources)];
  }
  if (OPENCODE_GO_IDS.includes(id as (typeof OPENCODE_GO_IDS)[number])) {
    return openCodeGoWrites(provider, sources);
  }
  return [await openAiCompatibleWrite(id, provider, ctx, sources)];
}

/**
 * Refresh the given provider ids. Every source failure is contained: nothing
 * is written for that provider (and both halves of OpenCode Go fail together),
 * so a stale list is always preferable to an empty cache.
 */
export async function refreshProviderModels(
  providerIds: string[],
  ctx: ModelRefreshContext,
): Promise<ModelRefreshResult> {
  const sources: ModelRefreshSources = {
    httpGetJson: ctx.sources?.httpGetJson ?? httpGetJson,
    fetchPublicJson: ctx.sources?.fetchPublicJson ?? pluginJsonFetch,
    listCliModels: ctx.sources?.listCliModels ?? listCliModels,
    codexModelsCache: ctx.sources?.codexModelsCache ?? codexModelsCache,
  };
  const storage = ctx.storage ?? globalThis.localStorage;
  const fetchedAt = (ctx.now?.() ?? new Date()).toISOString();
  const canonical = [...new Set(providerIds.map(canonicalId))];
  const refreshed: string[] = [];
  let ok = true;
  for (const id of canonical) {
    try {
      // Resolve FIRST: a failed source must not touch a single cache entry.
      const writes = await resolveWrites(id, ctx, sources);
      retainSelectedModel(writes, ctx);
      for (const write of writes) {
        writeModelCache(write.providerId, write.models, write.source, storage, fetchedAt);
        refreshed.push(write.providerId);
      }
    } catch {
      ok = false;
    }
  }
  return ok ? { ok, refreshed } : { ok, refreshed, error: MODEL_REFRESH_FAILURE };
}

/** Refresh behind a UI button. A partial failure is an error even when a
 *  sibling source was written; `onWritten` lets the caller pick up those
 *  writes BEFORE the fixed error reaches the UI. Nothing is undone. */
export async function refreshModelsFromUi(
  providerIds: string[],
  ctx: ModelRefreshContext,
  onWritten: () => void | Promise<void>,
): Promise<void> {
  const result = await refreshProviderModels(providerIds, ctx);
  if (result.refreshed.length > 0) await onWritten();
  if (!result.ok) throw new Error(MODEL_REFRESH_FAILURE);
}

/** First fetch when connecting a provider with a dynamic source. A source
 *  failure is non-fatal: the credential/subscription is already valid and the
 *  embedded list remains usable. Never throws an upstream detail to the UI.
 *  Connect may span several catalog ids of one service (OpenCode Go's two API
 *  shapes), so only the canonical id fetches: its single fetch writes every
 *  cache entry of the group and the alias returns without a second one. */
export async function refreshModelsOnConnect(
  providerId: string,
  ctx: ModelRefreshContext,
): Promise<ModelRefreshResult> {
  if (!ownsConnectRefresh(providerId)) return { ok: true, refreshed: [] };
  try {
    return await refreshProviderModels([providerId], ctx);
  } catch {
    return { ok: false, refreshed: [], error: MODEL_REFRESH_FAILURE };
  }
}

/** Startup pass: one provider at a time, no UI feedback, no CLI for a
 *  subscription that isn't connected (the caller passes only connected ids). */
export async function refreshStaleProviders(
  staleIds: string[],
  ctx: ModelRefreshContext,
): Promise<ModelRefreshResult> {
  const refreshed: string[] = [];
  let ok = true;
  for (const id of staleIds) {
    try {
      const result = await refreshProviderModels([id], ctx);
      refreshed.push(...result.refreshed);
      if (!result.ok) ok = false;
    } catch {
      ok = false;
    }
  }
  return ok ? { ok, refreshed } : { ok, refreshed, error: MODEL_REFRESH_FAILURE };
}
