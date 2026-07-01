import { describe, expect, it } from "bun:test";
import {
  fetchModelsWithCache,
  isModelCatalogCacheFresh,
  openCodeGoModelName,
  openCodeGoRefreshGroup,
  partitionOpenCodeGoModels,
  readModelCatalogCache,
  writeModelCatalogCache,
  type ModelCatalogStorage,
} from "./model-catalog.ts";

function memoryStorage(): ModelCatalogStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("OpenCode Go model catalog helpers", () => {
  it("classifies the current /zen/go/v1/models ids by API shape", () => {
    const ids = [
      "minimax-m3",
      "minimax-m2.7",
      "minimax-m2.5",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "kimi-k2.5",
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.6-plus",
      "qwen3.5-plus",
      "mimo-v2-pro",
      "mimo-v2-omni",
      "mimo-v2.5-pro",
      "mimo-v2.5",
      "hy3-preview",
    ];
    const partitioned = partitionOpenCodeGoModels(ids.map((id) => ({ id })));

    expect(partitioned.messages.map((m) => m.id)).toEqual([
      "minimax-m3",
      "minimax-m2.7",
      "minimax-m2.5",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.6-plus",
      "qwen3.5-plus",
    ]);
    expect(partitioned.chatCompletions.map((m) => m.id)).toEqual([
      "kimi-k2.7-code",
      "kimi-k2.6",
      "kimi-k2.5",
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "mimo-v2-pro",
      "mimo-v2-omni",
      "mimo-v2.5-pro",
      "mimo-v2.5",
      "hy3-preview",
    ]);
    expect(partitioned.unknown).toEqual([]);
  });

  it("keeps unknown future families out of the picker until their API shape is known", () => {
    const partitioned = partitionOpenCodeGoModels([{ id: "new-family-1" }]);

    expect(partitioned.messages).toEqual([]);
    expect(partitioned.chatCompletions).toEqual([]);
    expect(partitioned.unknown.map((m) => m.id)).toEqual(["new-family-1"]);
  });

  it("exposes a shared refresh group for both internal OpenCode Go providers", () => {
    expect(openCodeGoRefreshGroup("opencode-go")).toBe("opencode-go");
    expect(openCodeGoRefreshGroup("opencode-go-chat")).toBe("opencode-go");
    expect(openCodeGoRefreshGroup("openai")).toBeUndefined();
  });

  it("uses display names for known OpenCode Go ids", () => {
    expect(openCodeGoModelName("glm-5.2")).toBe("GLM-5.2");
    expect(openCodeGoModelName("unknown-model")).toBe("unknown-model");
  });

  it("reads and writes a persistent model cache", () => {
    const storage = memoryStorage();
    const written = writeModelCatalogCache(storage, [{ id: "glm-5.2", name: "GLM-5.2" }], 1000);

    expect(readModelCatalogCache(storage)).toEqual(written);
    expect(isModelCatalogCacheFresh(written, 1000 + 60_000)).toBe(true);
    expect(isModelCatalogCacheFresh(written, 1000 + 25 * 60 * 60 * 1_000)).toBe(false);
  });

  it("returns cached models when a refresh fails after a successful fetch", async () => {
    const storage = memoryStorage();
    const okFetch = async () =>
      new Response(JSON.stringify({ data: [{ id: "glm-5.2", name: "GLM-5.2" }] }), {
        status: 200,
      });
    const first = await fetchModelsWithCache({
      baseURL: "https://opencode.ai/zen/go/v1",
      fetchImpl: okFetch,
      now: 1000,
      storage,
    });
    const failingFetch = async () => {
      throw new Error("offline");
    };
    const second = await fetchModelsWithCache({
      baseURL: "https://opencode.ai/zen/go/v1",
      fetchImpl: failingFetch,
      now: 2000,
      storage,
    });

    expect(first.source).toBe("network");
    expect(second).toEqual({
      error: "offline",
      fetchedAt: 1000,
      models: [{ id: "glm-5.2", name: "GLM-5.2" }],
      source: "cache",
    });
  });

  it("does not clobber a prior good cache when a later fetch returns no models", async () => {
    const storage = memoryStorage();
    const okFetch = async () =>
      new Response(JSON.stringify({ data: [{ id: "glm-5.2", name: "GLM-5.2" }] }), {
        status: 200,
      });
    await fetchModelsWithCache({
      baseURL: "https://opencode.ai/zen/go/v1",
      fetchImpl: okFetch,
      now: 1000,
      storage,
    });

    const emptyFetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    const empty = await fetchModelsWithCache({
      baseURL: "https://opencode.ai/zen/go/v1",
      fetchImpl: emptyFetch,
      now: 2000,
      storage,
    });

    // The empty response is surfaced, but it must not overwrite the good cache.
    expect(empty).toEqual({ fetchedAt: 2000, models: [], source: "network" });
    expect(readModelCatalogCache(storage)).toEqual({
      fetchedAt: 1000,
      models: [{ id: "glm-5.2", name: "GLM-5.2" }],
      version: 1,
    });

    // A subsequent network failure still finds the earlier good cache.
    const failingFetch = async () => {
      throw new Error("offline");
    };
    const offline = await fetchModelsWithCache({
      baseURL: "https://opencode.ai/zen/go/v1",
      fetchImpl: failingFetch,
      now: 3000,
      storage,
    });
    expect(offline).toEqual({
      error: "offline",
      fetchedAt: 1000,
      models: [{ id: "glm-5.2", name: "GLM-5.2" }],
      source: "cache",
    });
  });

  it("passes the api key to the live /models request", async () => {
    const seen: { authorization?: string | null } = {};
    const storage = memoryStorage();
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      seen.authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: [{ id: "glm-5.2" }] }), { status: 200 });
    };

    await fetchModelsWithCache({
      apiKey: "sk-opencode",
      baseURL: "https://opencode.ai/zen/go/v1",
      fetchImpl,
      storage,
    });

    expect(seen.authorization).toBe("Bearer sk-opencode");
  });
});
