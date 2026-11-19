// Fetch the live model list from an OpenAI-compatible provider's `/models`
// endpoint (DJA-11F / DJA-15). Drives the model <select> in Settings so the user
// picks from what the provider actually offers, instead of a hardcoded list.
//
// The parsers below are pure: they take the raw response (or CLI text) and
// return normalized CatalogModel lists. No network, Tauri or UI here.

export interface CatalogModel {
  id: string;
  name?: string;
  context?: number;
  reasoning?: boolean;
  deprecated?: boolean;
  /** `grok models` marks the current default with `*`. */
  default?: boolean;
}

/** Raised when a raw model list has a shape we cannot trust. Callers can catch
 *  this type instead of guessing whether a `TypeError` came from their code. */
export class ModelListParseError extends Error {
  constructor(
    readonly source: string,
    detail: string,
  ) {
    super(`${source}: ${detail}`);
    this.name = "ModelListParseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, source: string, detail: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ModelListParseError(source, detail);
  return value;
}

function dataArray(raw: unknown, source: string): unknown[] {
  const root = asRecord(raw, source, "resposta não é um objeto");
  if (!Array.isArray(root.data)) throw new ModelListParseError(source, "`data` não é uma lista");
  return root.data;
}

function requiredId(item: unknown, source: string): string {
  const model = asRecord(item, source, "item não é um objeto");
  if (typeof model.id !== "string" || model.id.trim() === "") {
    throw new ModelListParseError(source, "item sem `id` válido");
  }
  return model.id;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function deprecatedFlag(model: Record<string, unknown>): boolean | undefined {
  return model.deprecated === true || model.status === "deprecated" ? true : undefined;
}

function reasoningFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.supported === "boolean") return value.supported;
  if (Array.isArray(value.supported_efforts) && value.supported_efforts.length > 0) return true;
  return value.mandatory === true || value.default_enabled === true ? true : undefined;
}

function contextFrom(value: unknown): number | undefined {
  return isRecord(value) ? optionalNumber(value.context) : undefined;
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
  fetchImpl: typeof globalThis.fetch = fetch,
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

/** OpenAI's `/v1/models` also lists embeddings, audio, image and legacy ids.
 *  This is the chat-only filter previously in `apps/desktop/src/app.tsx`; it
 *  lives here so every caller can reuse it (pass `chatFilter: true`). */
export function isOpenAiChatModelId(id: string): boolean {
  const CHAT_OK = /^(gpt-|o\d|chatgpt-)/;
  const NON_CHAT =
    /(embedding|whisper|tts|audio|image|moderation|realtime|transcribe|search|dall-e)/;
  return CHAT_OK.test(id) && !NON_CHAT.test(id);
}

/** Parse `{ data: [{ id, name? }] }`. `chatFilter: true` applies the OpenAI
 *  chat-only allowlist; other OpenAI-compatible providers keep every id. */
export function parseOpenAiCompatibleModels(
  raw: unknown,
  options: { chatFilter?: boolean } = {},
): CatalogModel[] {
  const source = "openai-compatible";
  return dataArray(raw, source)
    .map((item) => {
      const model = asRecord(item, source, "item não é um objeto");
      const name = optionalString(model.name);
      const deprecated = deprecatedFlag(model);
      return {
        id: requiredId(item, source),
        ...(name ? { name } : {}),
        ...(deprecated ? { deprecated } : {}),
      };
    })
    .filter((model) => !options.chatFilter || isOpenAiChatModelId(model.id));
}

/** Anthropic's `/v1/models` page. `page` is the output parameter: after parsing,
 *  `hasMore` tells whether to request another page and `lastId` is its cursor. */
export interface AnthropicPageState {
  hasMore: boolean;
  lastId?: string;
}

export function parseAnthropicModels(raw: unknown, page: AnthropicPageState): CatalogModel[] {
  const source = "anthropic";
  const root = asRecord(raw, source, "resposta não é um objeto");
  if (!Array.isArray(root.data)) throw new ModelListParseError(source, "`data` não é uma lista");
  page.hasMore = root.has_more === true;
  page.lastId = optionalString(root.last_id);
  return root.data.map((item) => {
    const model = asRecord(item, source, "item não é um objeto");
    const name = optionalString(model.display_name);
    const deprecated = deprecatedFlag(model);
    return {
      id: requiredId(item, source),
      ...(name ? { name } : {}),
      ...(deprecated ? { deprecated } : {}),
    };
  });
}

export interface OpenCodeModelLists {
  /** `messages` / Anthropic-shaped models. */
  messages: CatalogModel[];
  /** `chat-completions` / OpenAI-shaped models. */
  chatCompletions: CatalogModel[];
}

type OpenCodeApi = "messages" | "chat-completions";

function openCodeApiOf(model: Record<string, unknown>): OpenCodeApi | undefined {
  const supported = (value: unknown): value is OpenCodeApi =>
    value === "messages" || value === "chat-completions";
  if (supported(model.recommended_api)) return model.recommended_api;
  // Fallback when `recommended_api` is absent or unknown: first supported key
  // in the model's `api` map, in the order the endpoint returned them.
  if (isRecord(model.api)) {
    for (const key of Object.keys(model.api)) {
      if (supported(key)) return key;
    }
  }
  return undefined;
}

/** OpenCode Go and Zen `/models`. Only `messages` and `chat-completions` are
 *  usable by Markdraw; `responses`, `generate-content`, `images`, `live` etc.
 *  and models flagged deprecated are discarded. */
export function parseOpenCodeModels(raw: unknown): OpenCodeModelLists {
  const source = "opencode";
  const lists: OpenCodeModelLists = { messages: [], chatCompletions: [] };
  for (const item of dataArray(raw, source)) {
    const model = asRecord(item, source, "item não é um objeto");
    if (deprecatedFlag(model)) continue;
    const api = openCodeApiOf(model);
    if (!api) continue;
    const name = optionalString(model.name);
    const context = contextFrom(model.limit);
    const reasoning = isRecord(model.capabilities)
      ? reasoningFlag(model.capabilities.reasoning)
      : undefined;
    const normalized: CatalogModel = {
      id: requiredId(item, source),
      ...(name ? { name } : {}),
      ...(context !== undefined ? { context } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    };
    if (api === "messages") lists.messages.push(normalized);
    else lists.chatCompletions.push(normalized);
  }
  return lists;
}

/** OpenRouter `/api/v1/models`: `name`, `context_length` and reasoning metadata. */
export function parseOpenRouterModels(raw: unknown): CatalogModel[] {
  const source = "openrouter";
  return dataArray(raw, source).map((item) => {
    const model = asRecord(item, source, "item não é um objeto");
    const name = optionalString(model.name);
    const context = optionalNumber(model.context_length);
    const reasoning = reasoningFlag(model.reasoning);
    const deprecated = deprecatedFlag(model);
    return {
      id: requiredId(item, source),
      ...(name ? { name } : {}),
      ...(context !== undefined ? { context } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(deprecated ? { deprecated } : {}),
    };
  });
}

/** `grok models` plain text. `*` marks the default, `-` the remaining ids.
 *  Headers such as "You are not authenticated" and "Default model:" are noise. */
export function parseGrokModels(text: string): CatalogModel[] {
  if (typeof text !== "string") throw new ModelListParseError("grok", "saída não é texto");
  const models: CatalogModel[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([*-])\s+(\S+)(?:\s+\(default\))?$/.exec(line.trim());
    if (!match) continue;
    models.push({ id: match[2], ...(match[1] === "*" ? { default: true } : {}) });
  }
  return models;
}

/** `agy models` plain text: "Fetching available models..." followed by
 *  `id<TAB>display name` rows. */
export function parseAntigravityModels(text: string): CatalogModel[] {
  if (typeof text !== "string") throw new ModelListParseError("agy", "saída não é texto");
  const models: CatalogModel[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^fetching available models/i.test(trimmed)) continue;
    const match = /^(\S+)[ \t]+(.+)$/.exec(trimmed);
    if (!match) continue;
    models.push({ id: match[1], name: match[2].trim() });
  }
  return models;
}

/** `~/.codex/models_cache.json`, reduced to its `models` list. Only model
 *  fields are read; account/identity fields are never touched. Models with
 *  `visibility: "hide"` are not shown by Codex and are dropped. */
export function parseCodexModelCache(raw: unknown): CatalogModel[] {
  const source = "codex-cache";
  const root = asRecord(raw, source, "cache não é um objeto");
  const models = root.models;
  const entries = Array.isArray(models)
    ? models
    : isRecord(models)
      ? Object.values(models)
      : undefined;
  if (!entries) throw new ModelListParseError(source, "`models` não é uma lista");
  const result: CatalogModel[] = [];
  for (const item of entries) {
    const model = asRecord(item, source, "item não é um objeto");
    if (model.visibility === "hide" || model.visibility === "hidden" || model.hidden === true) {
      continue;
    }
    const slug = model.slug;
    if (typeof slug !== "string" || slug.trim() === "") {
      throw new ModelListParseError(source, "item sem `slug` válido");
    }
    const name = optionalString(model.display_name);
    const context = optionalNumber(model.context_window);
    const levels = model.supported_reasoning_levels;
    const reasoning = Array.isArray(levels) && levels.length > 0 ? true : undefined;
    const deprecated = deprecatedFlag(model);
    result.push({
      id: slug,
      ...(name ? { name } : {}),
      ...(context !== undefined ? { context } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(deprecated ? { deprecated } : {}),
    });
  }
  return result;
}
