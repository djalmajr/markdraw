// Fakes live in the test only: no IPC, no CLI, no network and no credentials.
// Each provider source returns a fixed payload so the cache write is checked
// against the actual reader output, not a hand-copied expectation.

import { describe, expect, it } from "bun:test";
import type { CachedModel, ModelCache } from "@markdraw/ai/config-schema.ts";
import {
  canRefreshProvider,
  MODEL_REFRESH_FAILURE,
  refreshProviderModels,
  refreshStaleProviders,
  staleProviderIds,
  type ModelRefreshContext,
  type ModelRefreshSources,
} from "./model-refresh.ts";
import { MODEL_CACHE_KEY, MODEL_CACHE_TTL_MS, parseModelCache } from "./model-cache.ts";

const NOW = new Date("2026-11-19T12:00:00.000Z");

function fakeStorage(seed?: string) {
  let raw: string | null = seed ?? null;
  return {
    getItem: (key: string) => (key === MODEL_CACHE_KEY ? raw : null),
    setItem: (key: string, value: string) => {
      if (key === MODEL_CACHE_KEY) raw = value;
    },
    get raw() {
      return raw;
    },
  };
}

interface Calls {
  http: Array<{ url: string; headers?: Record<string, string> }>;
  cli: string[];
  codex: number;
}

function harness(responses: Record<string, unknown> = {}, options: { cli?: string; codex?: unknown } = {}) {
  const calls: Calls = { http: [], cli: [], codex: 0 };
  const sources: ModelRefreshSources = {
    httpGetJson: async (url, headers) => {
      calls.http.push({ url, headers });
      if (!(url in responses)) throw new Error(`unexpected ${url}`);
      return { status: 200, body: JSON.stringify(responses[url]) };
    },
    listCliModels: async (provider) => {
      calls.cli.push(provider);
      return options.cli ?? "";
    },
    codexModelsCache: async () => {
      calls.codex++;
      return (options.codex ?? []) as never;
    },
  };
  const storage = fakeStorage();
  const ctx: ModelRefreshContext = {
    providers: {},
    apiKeyFor: () => "fake-key",
    sources,
    storage,
    now: () => NOW,
  };
  const cache = () => parseModelCache(storage.raw);
  return { ctx, calls, storage, cache };
}

function openAiProvider(baseURL: string, kind = "openai-compatible") {
  return { kind, name: "test", options: { baseURL } };
}

function models(entry: ModelCache[string] | undefined): Record<string, CachedModel> {
  return (entry?.models ?? {}) as Record<string, CachedModel>;
}

describe("model-refresh — fontes", () => {
  it("OpenAI: filtra chat, grava no cache e manda a chate em Authorization", async () => {
    const h = harness({
      "https://api.openai.com/v1/models": {
        data: [
          { id: "gpt-5.5" },
          { id: "text-embedding-3-small" },
          { id: "whisper-1" },
        ],
      },
    });
    h.ctx.providers = { openai: openAiProvider("https://api.openai.com/v1", "openai") };
    const result = await refreshProviderModels(["openai"], h.ctx);
    expect(result).toEqual({ ok: true, refreshed: ["openai"] });
    expect(h.calls.http[0].url).toBe("https://api.openai.com/v1/models");
    expect(h.calls.http[0].headers?.Authorization).toBe("Bearer fake-key");
    expect(Object.keys(models(h.cache().openai))).toEqual(["gpt-5.5"]);
    expect(h.cache().openai?.source).toBe("openai-compatible:/models");
    expect(h.cache().openai?.fetchedAt).toBe(NOW.toISOString());
  });

  it("OpenRouter: usa o leitor próprio (nome/contexto) e não o filtro da OpenAI", async () => {
    const h = harness({
      "https://openrouter.ai/api/v1/models": {
        data: [{ id: "google/gemini-4-neon", name: "Gemini 4 Neon", context_length: 1048576 }],
      },
    });
    h.ctx.providers = { openrouter: openAiProvider("https://openrouter.ai/api/v1") };
    const result = await refreshProviderModels(["openrouter"], h.ctx);
    expect(result.ok).toBe(true);
    expect(models(h.cache().openrouter)["google/gemini-4-neon"]).toEqual({
      name: "Gemini 4 Neon",
      limit: { context: 1048576 },
    });
  });

  it("provider customizado com baseURL arbitrária também atualiza", async () => {
    const h = harness({ "https://custom.test/v1/models": { data: [{ id: "custom-a" }] } });
    h.ctx.providers = { custom: openAiProvider("https://custom.test/v1/") };
    expect((await refreshProviderModels(["custom"], h.ctx)).ok).toBe(true);
    expect(h.calls.http[0].url).toBe("https://custom.test/v1/models");
    expect(Object.keys(models(h.cache().custom))).toEqual(["custom-a"]);
  });

  it("Anthropic: pagina com after_id, x-api-key e anthropic-version", async () => {
    const h = harness({
      "https://api.anthropic.com/v1/models": {
        data: [{ id: "claude-a", display_name: "Claude A" }],
        has_more: true,
        last_id: "claude-a",
      },
      "https://api.anthropic.com/v1/models?after_id=claude-a": {
        data: [{ id: "claude-b" }],
        has_more: false,
      },
    });
    h.ctx.providers = { anthropic: { kind: "anthropic", name: "Anthropic" } };
    const result = await refreshProviderModels(["anthropic"], h.ctx);
    expect(result.ok).toBe(true);
    expect(h.calls.http.map((c) => c.url)).toEqual([
      "https://api.anthropic.com/v1/models",
      "https://api.anthropic.com/v1/models?after_id=claude-a",
    ]);
    expect(h.calls.http[0].headers?.["x-api-key"]).toBe("fake-key");
    expect(h.calls.http[0].headers?.["anthropic-version"]).toBe("2023-06-01");
    expect(models(h.cache().anthropic)["claude-a"]).toEqual({ name: "Claude A" });
    expect(models(h.cache().anthropic)["claude-b"]).toEqual({ name: "claude-b" });
  });

  it("um clique no OpenCode Go atualiza os dois providers do grupo", async () => {
    const h = harness({
      "https://opencode.ai/zen/go/v1/models": {
        data: [
          { id: "claude-haiku-5-5", name: "Haiku", recommended_api: "messages" },
          { id: "glm-5.3", name: "GLM", api: { "chat-completions": {} } },
          { id: "muse-spark", api: { responses: {} } },
        ],
      },
    });
    h.ctx.providers = {
      "opencode-go": openAiProvider("https://opencode.ai/zen/go/v1", "anthropic"),
      "opencode-go-chat": openAiProvider("https://opencode.ai/zen/go/v1"),
    };
    const result = await refreshProviderModels(["opencode-go", "opencode-go-chat"], h.ctx);
    expect(result.ok).toBe(true);
    expect(h.calls.http).toHaveLength(1); // grupo deduplicado
    expect(result.refreshed).toEqual(["opencode-go", "opencode-go-chat"]);
    expect(Object.keys(models(h.cache()["opencode-go"]))).toEqual(["claude-haiku-5-5"]);
    expect(Object.keys(models(h.cache()["opencode-go-chat"]))).toEqual(["glm-5.3"]);
    expect(h.cache()["opencode-go-chat"]?.source).toBe("opencode-go:/models");
  });

  it("Grok CLI: usa ids da saída de texto", async () => {
    const h = harness({}, { cli: "* grok-4.6 (default)\n  - grok-4.5\n" });
    h.ctx.providers = { "grok-sub": { kind: "grok-cli", name: "Grok" } };
    expect((await refreshProviderModels(["grok-sub"], h.ctx)).ok).toBe(true);
    expect(h.calls.cli).toEqual(["grok-sub"]);
    expect(Object.keys(models(h.cache()["grok-sub"]))).toEqual(["grok-4.6", "grok-4.5"]);
  });

  it("Antigravity: a chave do modelo é o nome de exibição", async () => {
    const h = harness(
      {},
      { cli: "Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\n" },
    );
    h.ctx.providers = { "antigravity-sub": { kind: "antigravity-cli", name: "Antigravity" } };
    expect((await refreshProviderModels(["antigravity-sub"], h.ctx)).ok).toBe(true);
    expect(h.calls.cli).toEqual(["antigravity-sub"]);
    expect(models(h.cache()["antigravity-sub"])).toEqual({
      "Gemini 4 Neon (High)": { name: "Gemini 4 Neon (High)" },
    });
  });

  it("Codex: filtra visibility == list e adapta os campos camelCase do Rust", async () => {
    const h = harness({}, {
      codex: [
        {
          slug: "gpt-6.2-sol",
          displayName: "GPT-6.2-Sol",
          contextWindow: 500000,
          visibility: "list",
          defaultReasoningLevel: "medium",
          reasoningEfforts: ["low", "high", "bogus"],
        },
        { slug: "hidden-one", displayName: "Hidden", visibility: "hide" },
      ],
    });
    h.ctx.providers = { "codex-sub": { kind: "codex-cli", name: "Codex" } };
    expect((await refreshProviderModels(["codex-sub"], h.ctx)).ok).toBe(true);
    expect(h.calls.codex).toBe(1);
    expect(models(h.cache()["codex-sub"])).toEqual({
      "gpt-6.2-sol": {
        name: "GPT-6.2-Sol",
        limit: { context: 500000 },
        reasoning: ["low", "high"],
      },
    });
  });

  it("Claude da assinatura: o mais novo de cada família, sem datas nem deprecated", async () => {
    const h = harness({
      "https://models.dev/api.json": {
        anthropic: {
          models: {
            "claude-opus-5-5": { id: "claude-opus-5-5", name: "Opus 5.5" },
            "claude-opus-4-8": { id: "claude-opus-4-8", name: "Opus 4.8" },
            "claude-opus-5-4": { id: "claude-opus-5-4", name: "Opus 5.4" },
            "claude-fable-5-2": { id: "claude-fable-5-2", name: "Fable 5.2" },
            "claude-sonnet-4-6": { id: "claude-sonnet-4-6", status: "deprecated" },
            "claude-sonnet-5-5": { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
            "claude-3-5-haiku-20241022": { id: "claude-3-5-haiku-20241022" },
            "claude-haiku-5-5": { id: "claude-haiku-5-5", name: "Haiku 5.5" },
            "claude-haiku-4-5": { id: "claude-haiku-4-5" },
          },
        },
        openai: { models: { "gpt-6": { id: "gpt-6" } } },
      },
    });
    h.ctx.providers = { "claude-sub": { kind: "claude-cli", name: "Claude" } };
    expect((await refreshProviderModels(["claude-sub"], h.ctx)).ok).toBe(true);
    expect(Object.keys(models(h.cache()["claude-sub"]))).toEqual([
      "claude-fable-5-2",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    expect(h.cache()["claude-sub"]?.source).toBe("models.dev:anthropic");
    expect(h.calls.cli).toEqual([]);
  });

  it("non-2xx é falha: não grava nada", async () => {
    const h = harness();
    h.ctx.sources!.httpGetJson = async () => ({ status: 401, body: "{}" });
    h.ctx.providers = { openai: openAiProvider("https://api.openai.com/v1", "openai") };
    const result = await refreshProviderModels(["openai"], h.ctx);
    expect(result).toEqual({ ok: false, refreshed: [], error: MODEL_REFRESH_FAILURE });
    expect(h.cache().openai).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("fake-key");
  });
});

describe("model-refresh — falha e atualização automática", () => {
  it("falha nunca apaga o cache anterior", async () => {
    const h = harness();
    const seed = {
      openai: {
        source: "openai-compatible:/models",
        fetchedAt: "2026-11-01T12:00:00.000Z",
        models: { "gpt-old": { name: "GPT old" } },
      },
    };
    h.storage.setItem(MODEL_CACHE_KEY, JSON.stringify(seed));
    const before = h.storage.raw;
    h.ctx.providers = { openai: openAiProvider("https://api.openai.com/v1", "openai") };
    h.ctx.sources!.httpGetJson = async () => {
      throw new Error("network down");
    };
    const result = await refreshProviderModels(["openai"], h.ctx);
    expect(result.ok).toBe(false);
    expect(h.storage.raw).toBe(before);
    expect(models(h.cache().openai)).toEqual({ "gpt-old": { name: "GPT old" } });
    expect(h.cache().openai?.fetchedAt).toBe("2026-11-01T12:00:00.000Z");
  });

  it("TTL: vencido e nunca atualizado entram; recente não", () => {
    const cache = {
      stale: { source: "x", fetchedAt: "2026-11-01T12:00:00.000Z", models: {} },
      fresh: { source: "x", fetchedAt: "2026-11-18T12:00:00.000Z", models: {} },
      never: { source: "x", fetchedAt: "not-a-date", models: {} },
    };
    expect(staleProviderIds(["stale", "fresh", "never"], cache, NOW.getTime())).toEqual([
      "stale",
      "never",
    ]);
  });

  it("startup: atualiza só conectados, um por vez, sem erro em toast", async () => {
    const order: string[] = [];
    const responses: Record<string, unknown> = {
      "https://api.openai.com/v1/models": { data: [{ id: "gpt-5.5" }] },
      "https://opencode.ai/zen/go/v1/models": {
        data: [
          { id: "m", recommended_api: "messages" },
          { id: "c", recommended_api: "chat-completions" },
        ],
      },
    };
    const h = harness(responses);
    h.ctx.sources!.httpGetJson = async (url) => {
      order.push(url);
      return { status: 200, body: JSON.stringify(responses[url]) };
    };
    h.ctx.providers = {
      openai: openAiProvider("https://api.openai.com/v1", "openai"),
      "opencode-go": openAiProvider("https://opencode.ai/zen/go/v1", "anthropic"),
      "opencode-go-chat": openAiProvider("https://opencode.ai/zen/go/v1"),
      "claude-sub": { kind: "claude-cli", name: "Claude" },
      "codex-sub": { kind: "codex-cli", name: "Codex" },
    };
    // Claude/Codex are in the config but NOT connected: never passed to startup.
    const connected = ["openai", "opencode-go", "opencode-go-chat"];
    const stale = staleProviderIds(connected, {}, NOW.getTime());
    expect(stale).toEqual(["openai", "opencode-go"]);
    const result = await refreshStaleProviders(stale, h.ctx);
    expect(result.ok).toBe(true);
    expect(order).toEqual([
      "https://api.openai.com/v1/models",
      "https://opencode.ai/zen/go/v1/models",
    ]);
    expect(h.calls.cli).toEqual([]);
    expect(h.calls.codex).toBe(0);
    expect(result.refreshed).toEqual(["openai", "opencode-go", "opencode-go-chat"]);
  });

  it("canRefreshProvider só marca providers com fonte", () => {
    expect(canRefreshProvider("openai", openAiProvider("https://api.openai.com/v1"))).toBe(true);
    expect(canRefreshProvider("grok-sub", { kind: "grok-cli", name: "Grok" })).toBe(true);
    expect(canRefreshProvider("custom", { kind: "openai-compatible", name: "x" })).toBe(false);
    expect(canRefreshProvider("missing", undefined)).toBe(false);
  });
});
