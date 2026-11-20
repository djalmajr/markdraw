// Fakes live in the test only: no IPC, no CLI, no network and no credentials.
// Each provider source returns a fixed payload so the cache write is checked
// against the actual reader output, not a hand-copied expectation.

import { describe, expect, it } from "bun:test";
import {
  mergeConfigs,
  type CachedModel,
  type ModelCache,
  type ModelConfig,
} from "@markdraw/ai/config-schema.ts";
import {
  canRefreshProvider,
  MODEL_REFRESH_FAILURE,
  publicJsonFetcher,
  refreshModelsFromUi,
  refreshModelsOnConnect,
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
  /** models.dev only: the plugin HTTP source, no 4 MiB cap. */
  publicJson: string[];
  cli: string[];
  codex: number;
}

function harness(responses: Record<string, unknown> = {}, options: { cli?: string; codex?: unknown } = {}) {
  const calls: Calls = { http: [], publicJson: [], cli: [], codex: 0 };
  const sources: ModelRefreshSources = {
    httpGetJson: async (url, headers) => {
      calls.http.push({ url, headers });
      if (!(url in responses)) throw new Error(`unexpected ${url}`);
      return { status: 200, body: JSON.stringify(responses[url]) };
    },
    fetchPublicJson: async (url) => {
      calls.publicJson.push(url);
      if (!(url in responses)) throw new Error(`unexpected ${url}`);
      return responses[url];
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

  it("Claude da assinatura: release_date decide quando os dois da família têm data", async () => {
    // O id mais novo em número saiu ANTES: só a data distingue os dois, então
    // este caso falha se `release_date` for ignorado.
    const h = harness({
      "https://models.dev/api.json": {
        anthropic: {
          models: {
            "claude-opus-4-8": {
              id: "claude-opus-4-8",
              name: "Opus 4.8",
              release_date: "2026-02-01",
            },
            "claude-opus-5-5": {
              id: "claude-opus-5-5",
              name: "Opus 5.5",
              release_date: "2026-01-01",
            },
          },
        },
      },
    });
    h.ctx.providers = { "claude-sub": { kind: "claude-cli", name: "Claude" } };
    expect((await refreshProviderModels(["claude-sub"], h.ctx)).ok).toBe(true);
    expect(models(h.cache()["claude-sub"])).toEqual({ "claude-opus-4-8": { name: "Opus 4.8" } });
  });

  it("Claude da assinatura: a mesma data nos dois cai para a versão do id", async () => {
    const h = harness({
      "https://models.dev/api.json": {
        anthropic: {
          models: {
            "claude-opus-4-8": {
              id: "claude-opus-4-8",
              name: "Opus 4.8",
              release_date: "2026-02-01",
            },
            "claude-opus-5-5": {
              id: "claude-opus-5-5",
              name: "Opus 5.5",
              release_date: "2026-02-01",
            },
          },
        },
      },
    });
    h.ctx.providers = { "claude-sub": { kind: "claude-cli", name: "Claude" } };
    expect((await refreshProviderModels(["claude-sub"], h.ctx)).ok).toBe(true);
    expect(models(h.cache()["claude-sub"])).toEqual({ "claude-opus-5-5": { name: "Opus 5.5" } });
  });

  it("Claude da assinatura: sem data em um dos dois, a versão do id decide (comportamento de hoje)", async () => {
    const h = harness({
      "https://models.dev/api.json": {
        anthropic: {
          models: {
            "claude-opus-4-8": {
              id: "claude-opus-4-8",
              name: "Opus 4.8",
              release_date: "2027-01-01",
            },
            "claude-opus-5-5": { id: "claude-opus-5-5", name: "Opus 5.5" },
          },
        },
      },
    });
    h.ctx.providers = { "claude-sub": { kind: "claude-cli", name: "Claude" } };
    expect((await refreshProviderModels(["claude-sub"], h.ctx)).ok).toBe(true);
    expect(models(h.cache()["claude-sub"])).toEqual({ "claude-opus-5-5": { name: "Opus 5.5" } });
  });

  // F3/F4: a regra de recência é da FAMÍLIA, decidida antes de reduzi-la, então
  // o vencedor gravado não pode depender da ordem do catálogo. As permutações
  // passam pelo mesmo ponto de entrada (o refresh que persiste o cache).
  async function claudeWinners(entries: Array<Record<string, unknown>>): Promise<string[]> {
    const h = harness({
      "https://models.dev/api.json": {
        anthropic: { models: Object.fromEntries(entries.map((e) => [e.id as string, e])) },
      },
    });
    h.ctx.providers = { "claude-sub": { kind: "claude-cli", name: "Claude" } };
    expect((await refreshProviderModels(["claude-sub"], h.ctx)).ok).toBe(true);
    return Object.keys(models(h.cache()["claude-sub"]));
  }

  function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items];
    return items.flatMap((item, i) =>
      permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
    );
  }

  it("Claude da assinatura: todos com data válida → a data decide, em qualquer ordem (F3)", async () => {
    const catalog = [
      { id: "claude-opus-4-8", name: "Opus 4.8", release_date: "2026-02-01" },
      { id: "claude-opus-5-5", name: "Opus 5.5", release_date: "2026-01-01" },
      { id: "claude-opus-5-0", name: "Opus 5.0", release_date: "2026-03-01" },
    ];
    const orders = permutations(catalog);
    expect(orders.length).toBe(6);
    for (const order of orders) expect(await claudeWinners(order)).toEqual(["claude-opus-5-0"]);
  });

  it("Claude da assinatura: um sem data → a versão decide a família inteira, em qualquer ordem (F3)", async () => {
    // Sonda da revisão: 4.8 vence 5.5 pela data, 5.5 vence 5.0 pela versão e
    // 5.0 vence 4.8 pela versão. Com a regra única, um candidato sem data leva
    // a família inteira para a versão do id — e a ordem deixa de importar.
    const catalog = [
      { id: "claude-opus-4-8", name: "Opus 4.8", release_date: "2026-02-01" },
      { id: "claude-opus-5-5", name: "Opus 5.5", release_date: "2026-01-01" },
      { id: "claude-opus-5-0", name: "Opus 5.0" },
    ];
    const orders = permutations(catalog);
    expect(orders.length).toBe(6);
    for (const order of orders) expect(await claudeWinners(order)).toEqual(["claude-opus-5-5"]);
  });

  it("Claude da assinatura: data impossível conta como ausente, em qualquer ordem (F4)", async () => {
    // `Date.parse("2026-02-30")` vira 2 de março; se a data inválida contasse,
    // 4.8 venceria. Como ela é ausente, a família cai para a versão: 5.5.
    const invalid = { id: "claude-opus-4-8", name: "Opus 4.8", release_date: "2026-02-30" };
    const valid = { id: "claude-opus-5-5", name: "Opus 5.5", release_date: "2026-02-28" };
    expect(await claudeWinners([invalid, valid])).toEqual(["claude-opus-5-5"]);
    expect(await claudeWinners([valid, invalid])).toEqual(["claude-opus-5-5"]);
    // Controle próximo: com as duas datas válidas, a mais recente decide.
    expect(
      await claudeWinners([
        { id: "claude-opus-4-8", name: "Opus 4.8", release_date: "2026-02-28" },
        { id: "claude-opus-5-5", name: "Opus 5.5", release_date: "2026-02-01" },
      ]),
    ).toEqual(["claude-opus-4-8"]);
    // Fronteira: um único candidato com data impossível continua sendo a
    // família (a data ausente não o exclui do catálogo).
    expect(await claudeWinners([invalid])).toEqual(["claude-opus-4-8"]);
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

describe("model-refresh — rodada 2: F1, F2 e connect", () => {
  it("F2: selecionado fora da nova lista fica no cache com nome/limites de antes e volta sem previous", async () => {
    // Same shape as a live ModelConfig: writing it to the cache must preserve
    // every field, and a fresh config load must resolve it verbatim.
    const previous: ModelConfig = {
      name: "GPT velho (manual)",
      limit: { context: 123456, output: 4096 },
      reasoning: ["low"],
    };
    const h = harness({
      "https://api.openai.com/v1/models": { data: [{ id: "gpt-new", name: "GPT novo" }] },
    });
    h.ctx.providers = { openai: openAiProvider("https://api.openai.com/v1", "openai") };
    h.ctx.selectedModel = "openai/gpt-old";
    h.ctx.modelDefinition = (id, modelId) =>
      id === "openai" && modelId === "gpt-old" ? structuredClone(previous) : undefined;
    const result = await refreshProviderModels(["openai"], h.ctx);
    expect(result).toEqual({ ok: true, refreshed: ["openai"] });
    expect(models(h.cache().openai)).toEqual({
      "gpt-new": { name: "GPT novo" },
      "gpt-old": previous,
    });
    expect(h.cache().openai?.source).toBe("openai-compatible:/models");
    expect(h.cache().openai?.fetchedAt).toBe(NOW.toISOString());

    // Nova abertura: só o cache e os embutidos, sem `previous` nem `selected`.
    const reopened = mergeConfigs(
      { openai: { kind: "openai", name: "OpenAI", models: {} } },
      {},
      h.cache(),
    );
    expect(reopened.provider.openai.models["gpt-old"]).toEqual(previous);
    expect(reopened.provider.openai.models["gpt-new"]).toEqual({ name: "GPT novo" });
  });

  it("F2: selecionado ainda presente mantém a definição nova da fonte", async () => {
    const h = harness({
      "https://api.openai.com/v1/models": { data: [{ id: "gpt-old", name: "Nome novo" }] },
    });
    h.ctx.providers = { openai: openAiProvider("https://api.openai.com/v1", "openai") };
    h.ctx.selectedModel = "openai/gpt-old";
    h.ctx.modelDefinition = () => ({ name: "Nome antigo", limit: { context: 1 } });
    expect((await refreshProviderModels(["openai"], h.ctx)).ok).toBe(true);
    // O leitor OpenAI não traz contexto; o que importa é o nome novo vencer o antigo.
    expect(models(h.cache().openai)).toEqual({ "gpt-old": { name: "Nome novo" } });
  });

  it("F2: sem definição anterior não inventa entrada; falha não grava a retenção", async () => {
    const h = harness();
    h.ctx.providers = { openai: openAiProvider("https://api.openai.com/v1", "openai") };
    h.ctx.selectedModel = "openai/gpt-old";
    h.ctx.modelDefinition = () => undefined;
    h.ctx.sources!.httpGetJson = async () => ({ status: 200, body: JSON.stringify({ data: [{ id: "gpt-new" }] }) });
    expect((await refreshProviderModels(["openai"], h.ctx)).ok).toBe(true);
    expect(Object.keys(models(h.cache().openai))).toEqual(["gpt-new"]);

    h.storage.setItem(MODEL_CACHE_KEY, JSON.stringify({ openai: {
      source: "x",
      fetchedAt: "2026-11-01T12:00:00.000Z",
      models: { "gpt-kept": { name: "GPT kept" } },
    } }));
    const before = h.storage.raw;
    h.ctx.modelDefinition = () => ({ name: "GPT velho" });
    h.ctx.sources!.httpGetJson = async () => { throw new Error("network down"); };
    expect((await refreshProviderModels(["openai"], h.ctx)).ok).toBe(false);
    expect(h.storage.raw).toBe(before);
  });

  it("F1: falha parcial em grupo misto avisa a UI e mantém o que foi gravado", async () => {
    const responses: Record<string, unknown> = {
      "https://models.dev/api.json": {
        anthropic: {
          models: { "claude-opus-5-5": { id: "claude-opus-5-5", name: "Opus 5.5" } },
        },
      },
    };
    const h = harness(responses);
    h.ctx.sources!.httpGetJson = async (url) => {
      if (url === "https://api.anthropic.com/v1/models") return { status: 401, body: "{}" };
      return { status: 200, body: JSON.stringify(responses[url]) };
    };
    h.ctx.providers = {
      anthropic: { kind: "anthropic", name: "Anthropic" },
      "claude-sub": { kind: "claude-cli", name: "Claude" },
    };
    let reloaded = 0;
    let thrown: unknown;
    try {
      await refreshModelsFromUi(["anthropic", "claude-sub"], h.ctx, () => {
        reloaded++;
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(MODEL_REFRESH_FAILURE);
    expect(JSON.stringify(thrown)).not.toContain("fake-key");
    expect(reloaded).toBe(1);
    expect(h.cache().anthropic).toBeUndefined();
    expect(models(h.cache()["claude-sub"])).toEqual({
      "claude-opus-5-5": { name: "Opus 5.5" },
    });

    // Controle: sem falha, nenhum erro é levantado e a recarga acontece igual.
    h.ctx.sources!.httpGetJson = async (url) => ({
      status: 200,
      body: JSON.stringify(responses[url] ?? { data: [{ id: "claude-a" }] }),
    });
    reloaded = 0;
    await refreshModelsFromUi(["anthropic", "claude-sub"], h.ctx, () => {
      reloaded++;
    });
    expect(reloaded).toBe(1);
    expect(models(h.cache().anthropic)["claude-a"]).toEqual({ name: "claude-a" });
  });

  it("connect: primeira busca usa o orquestrador com a chave recém-digitada; falha não derruba a conexão", async () => {
    const h = harness({
      "https://api.anthropic.com/v1/models": {
        data: [{ id: "claude-new", display_name: "Claude New" }],
      },
    });
    h.ctx.providers = { anthropic: { kind: "anthropic", name: "Anthropic" } };
    h.ctx.apiKeyFor = (id) => (id === "anthropic" ? "just-typed-key" : null);
    const ok = await refreshModelsOnConnect("anthropic", h.ctx);
    expect(ok).toEqual({ ok: true, refreshed: ["anthropic"] });
    expect(h.calls.http[0].headers?.["x-api-key"]).toBe("just-typed-key");
    expect(models(h.cache().anthropic)["claude-new"]).toEqual({ name: "Claude New" });

    const before = h.storage.raw;
    h.ctx.sources!.httpGetJson = async () => ({ status: 401, body: "{}" });
    const failed = await refreshModelsOnConnect("anthropic", h.ctx);
    expect(failed).toEqual({ ok: false, refreshed: [], error: MODEL_REFRESH_FAILURE });
    expect(h.storage.raw).toBe(before);
  });

  it("connect: conectar o grupo OpenCode Go faz uma busca e grava os dois", async () => {
    const h = harness({
      "https://opencode.ai/zen/go/v1/models": {
        data: [
          { id: "claude-haiku-5-5", name: "Haiku", recommended_api: "messages" },
          { id: "glm-5.3", name: "GLM", api: { "chat-completions": {} } },
        ],
      },
    });
    h.ctx.providers = {
      "opencode-go": openAiProvider("https://opencode.ai/zen/go/v1", "anthropic"),
      "opencode-go-chat": openAiProvider("https://opencode.ai/zen/go/v1"),
    };
    // O fluxo de conexão chama o hook uma vez por id do grupo.
    const refreshed: string[] = [];
    for (const id of ["opencode-go", "opencode-go-chat"]) {
      expect(canRefreshProvider(id, h.ctx.providers[id])).toBe(true);
      const result = await refreshModelsOnConnect(id, h.ctx);
      expect(result.ok).toBe(true);
      refreshed.push(...result.refreshed);
    }
    expect(h.calls.http).toHaveLength(1); // uma busca para o grupo
    expect(refreshed).toEqual(["opencode-go", "opencode-go-chat"]);
    expect(Object.keys(models(h.cache()["opencode-go"]))).toEqual(["claude-haiku-5-5"]);
    expect(Object.keys(models(h.cache()["opencode-go-chat"]))).toEqual(["glm-5.3"]);
    expect(h.cache()["opencode-go-chat"]?.source).toBe("opencode-go:/models");
  });
});

const MODELS_DEV = "https://models.dev/api.json";

/** A models.dev-shaped body at the real catalog's scale: ~6 MB, far above the
 *  4 MiB ceiling the native `ai_http_get_json` command answers `too_large` for. */
function modelsDevBody(): string {
  const models: Record<string, unknown> = Object.create(null);
  for (let i = 0; i < 60_000; i++) {
    models[`filler-${i}`] = {
      id: `filler-${i}`,
      name: `Filler model ${i}`,
      limit: { context: 128000 },
    };
  }
  return JSON.stringify({
    anthropic: {
      models: {
        "claude-opus-5-5": { id: "claude-opus-5-5", name: "Opus 5.5" },
        "claude-sonnet-4-6": { id: "claude-sonnet-4-6", status: "deprecated" },
        "claude-sonnet-5-5": { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
      },
    },
    filler: { models },
  });
}

describe("model-refresh — rodada 3: models.dev pelo plugin HTTP", () => {
  it("claude-sub busca o models.dev pela fonte do plugin, nunca pelo comando nativo capado", async () => {
    const h = harness({
      [MODELS_DEV]: {
        anthropic: { models: { "claude-opus-5-5": { id: "claude-opus-5-5", name: "Opus 5.5" } } },
      },
    });
    h.ctx.providers = { "claude-sub": { kind: "claude-cli", name: "Claude" } };
    const result = await refreshProviderModels(["claude-sub"], h.ctx);
    expect(result).toEqual({ ok: true, refreshed: ["claude-sub"] });
    expect(h.calls.publicJson).toEqual([MODELS_DEV]);
    expect(h.calls.http).toEqual([]);
    expect(h.calls.cli).toEqual([]);
    expect(models(h.cache()["claude-sub"])).toEqual({
      "claude-opus-5-5": { name: "Opus 5.5" },
    });
    expect(h.cache()["claude-sub"]?.source).toBe("models.dev:anthropic");
  });

  it("catálogo maior que 4 MiB atualiza o claude-sub pela fonte do plugin", async () => {
    const body = modelsDevBody();
    // O teto que derrubava o botão no app real; a fonte do plugin não o tem.
    expect(body.length).toBeGreaterThan(4 * 1024 * 1024);
    const h = harness();
    h.ctx.sources!.fetchPublicJson = publicJsonFetcher(async (url) => {
      expect(url).toBe(MODELS_DEV);
      return new Response(body, { status: 200 });
    });
    h.ctx.providers = { "claude-sub": { kind: "claude-cli", name: "Claude" } };
    const result = await refreshProviderModels(["claude-sub"], h.ctx);
    expect(result).toEqual({ ok: true, refreshed: ["claude-sub"] });
    expect(models(h.cache()["claude-sub"])).toEqual({
      "claude-opus-5-5": { name: "Opus 5.5" },
      "claude-sonnet-5-5": { name: "Sonnet 5.5" },
    });
  });

  it("falha da fonte do plugin não apaga o cache do claude-sub", async () => {
    const h = harness();
    h.storage.setItem(
      MODEL_CACHE_KEY,
      JSON.stringify({
        "claude-sub": {
          source: "models.dev:anthropic",
          fetchedAt: "2026-11-01T12:00:00.000Z",
          models: { "claude-opus-4-8": { name: "Opus 4.8" } },
        },
      }),
    );
    const before = h.storage.raw;
    h.ctx.providers = { "claude-sub": { kind: "claude-cli", name: "Claude" } };
    h.ctx.sources!.fetchPublicJson = async () => {
      throw new Error("plugin request failed");
    };
    const result = await refreshProviderModels(["claude-sub"], h.ctx);
    expect(result).toEqual({ ok: false, refreshed: [], error: MODEL_REFRESH_FAILURE });
    expect(h.storage.raw).toBe(before);
    expect(models(h.cache()["claude-sub"])).toEqual({ "claude-opus-4-8": { name: "Opus 4.8" } });
    expect(h.cache()["claude-sub"]?.fetchedAt).toBe("2026-11-01T12:00:00.000Z");
  });

  it("publicJsonFetcher: corpo 2xx volta parseado e não-2xx é falha que preserva o cache", async () => {
    // Controle: o adaptador devolve o JSON inteiro do corpo.
    const okFetch = async () =>
      new Response(JSON.stringify({ anthropic: { models: {} } }), { status: 200 });
    expect(await publicJsonFetcher(okFetch)(MODELS_DEV)).toEqual({ anthropic: { models: {} } });

    // Invariante herdada do consumidor: status não-2xx é falha, não lista vazia.
    const h = harness();
    h.storage.setItem(
      MODEL_CACHE_KEY,
      JSON.stringify({
        "claude-sub": {
          source: "models.dev:anthropic",
          fetchedAt: "2026-11-01T12:00:00.000Z",
          models: { "claude-opus-4-8": { name: "Opus 4.8" } },
        },
      }),
    );
    const before = h.storage.raw;
    h.ctx.providers = { "claude-sub": { kind: "claude-cli", name: "Claude" } };
    h.ctx.sources!.fetchPublicJson = publicJsonFetcher(async () =>
      // O corpo é um catálogo VÁLIDO e não-vazio: só o status distingue o erro
      // de uma lista boa, então sem a checagem de `ok` isso gravaria um modelo.
      new Response(
        JSON.stringify({
          anthropic: { models: { "claude-opus-5-5": { id: "claude-opus-5-5", name: "Opus 5.5" } } },
        }),
        { status: 503 },
      ),
    );
    const result = await refreshProviderModels(["claude-sub"], h.ctx);
    expect(result).toEqual({ ok: false, refreshed: [], error: MODEL_REFRESH_FAILURE });
    expect(h.storage.raw).toBe(before);
    expect(models(h.cache()["claude-sub"])).toEqual({ "claude-opus-4-8": { name: "Opus 4.8" } });
  });
});
