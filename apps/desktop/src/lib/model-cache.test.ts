import { describe, expect, it } from "bun:test";
import { BUILTIN_PROVIDERS } from "@markdraw/ai/builtin-providers.ts";
import { mergeConfigs, parseUserConfig } from "@markdraw/ai/config-schema.ts";
import {
  MODEL_CACHE_KEY,
  MODEL_CACHE_TTL_MS,
  parseModelCache,
  readModelCache,
  saveFetchedModels,
  writeModelCache,
  type ModelCacheStorage,
} from "./model-cache.ts";

function fakeStorage(initial: Record<string, string> = {}): ModelCacheStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

describe("model-cache (localStorage)", () => {
  it("usa chave versionada, com source/fetchedAt/models por provider", () => {
    const storage = fakeStorage();
    saveFetchedModels("openai", ["gpt-a", "gpt-b"], "/models", storage);
    const raw = storage.data.get(MODEL_CACHE_KEY);
    expect(raw).toBeDefined();
    const parsed = parseModelCache(raw);
    expect(parsed.openai?.source).toBe("/models");
    expect(typeof parsed.openai?.fetchedAt).toBe("string");
    expect(Object.keys(parsed.openai?.models ?? {})).toEqual(["gpt-a", "gpt-b"]);
    expect(parsed.openai?.models?.["gpt-a"]?.name).toBe("gpt-a");
    expect(MODEL_CACHE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("JSON inválido no localStorage cai no embutido", () => {
    const storage = fakeStorage({ [MODEL_CACHE_KEY]: "{not json" });
    const cache = readModelCache(storage);
    expect(Object.keys(cache)).toEqual([]);
    const merged = mergeConfigs(BUILTIN_PROVIDERS, {}, cache);
    // Any built-in model will do; the built-in list itself changes over time.
    const [builtinId, builtinModel] = Object.entries(BUILTIN_PROVIDERS.anthropic!.models)[0]!;
    expect(merged.provider.anthropic.models[builtinId]?.name).toBe(builtinModel.name);
  });

  it("descarta entradas malformadas em vez de quebrar a leitura", () => {
    const parsed = parseModelCache(JSON.stringify({
      good: {
        source: "/models",
        fetchedAt: "2026-11-19T12:00:00.000Z",
        models: {
          partial: { limit: { context: 128000, output: "nope" }, name: 42 },
          unknown: { name: "Unknown", reasoning: ["high", "bogus"], limit: { output: 64 } },
          invalid: 7,
        },
      },
      noSource: { fetchedAt: "x", models: {} },
      notAnEntry: 42,
    }));
    expect(Object.keys(parsed)).toEqual(["good"]);
    expect(parsed.good?.models.partial).toEqual({ limit: { context: 128000 } });
    expect(parsed.good?.models.unknown).toEqual({ name: "Unknown", reasoning: ["high"], limit: { output: 64 } });
    expect(parsed.good?.models.invalid).toEqual({ name: "invalid" });
  });

  it("uma atualização não altera o ai.json e mantém os modelos manuais", () => {
    // O texto abaixo representa o ai.json gravado pelo app: só modelos manuais.
    const aiJson = JSON.stringify({
      model: "ollama/manual-local",
      provider: { ollama: { models: { "manual-local": { name: "Manual local" } } } },
    });
    const storage = fakeStorage();
    saveFetchedModels("ollama", ["llama-v1"], "/models", storage);
    saveFetchedModels("ollama", ["llama-v2"], "/models", storage);
    // Nenhuma atualização escreve ai.json: o texto original permanece intacto.
    expect(aiJson).toContain('"manual-local":{"name":"Manual local"}');
    const user = parseUserConfig(aiJson);
    const merged = mergeConfigs(BUILTIN_PROVIDERS, user ?? {}, readModelCache(storage));
    expect(merged.provider.ollama.models["manual-local"]?.name).toBe("Manual local");
    expect(merged.provider.ollama.models["llama-v2"]?.name).toBe("llama-v2");
    expect(merged.provider.ollama.models["llama-v1"]).toBeUndefined();
  });

  it("substitui apenas o provider atualizado", () => {
    const storage = fakeStorage();
    writeModelCache("openai", { a: { name: "A" } }, "/models", storage, "2026-11-19T12:00:00.000Z");
    writeModelCache("ollama", { b: { name: "B" } }, "/models", storage, "2026-11-19T12:01:00.000Z");
    const cache = readModelCache(storage);
    expect(Object.keys(cache.openai?.models ?? {})).toEqual(["a"]);
    expect(Object.keys(cache.ollama?.models ?? {})).toEqual(["b"]);
  });
});
