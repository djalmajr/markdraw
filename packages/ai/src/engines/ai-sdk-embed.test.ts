import { describe, expect, it, mock } from "bun:test";
import type { ResolvedModel } from "../resolve-model.ts";
import { NotSupportedError } from "../types.ts";
import { aiSdkEngine } from "./ai-sdk.ts";

function resolved(kind: string, providerId: string, modelId: string): ResolvedModel {
  return {
    modelId,
    providerId,
    provider: { kind, name: providerId, models: {} },
  } as unknown as ResolvedModel;
}

describe("ai-sdk engine embed()", () => {
  it("throws NotSupportedError for providers without embeddings (anthropic)", async () => {
    const p = aiSdkEngine.createProvider(resolved("anthropic", "anthropic", "x"), async () => "key");
    await expect(p.embed("hello")).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("embeds via OpenAI textEmbeddingModel; wraps a single string; short-circuits empty", async () => {
    mock.module("@ai-sdk/openai", () => ({
      createOpenAI: () => ({ textEmbeddingModel: (id: string) => ({ id }) }),
    }));
    mock.module("ai", () => ({
      embedMany: async ({ values }: { values: string[] }) => ({
        embeddings: values.map(() => [0.1, 0.2, 0.3]),
      }),
    }));

    const p = aiSdkEngine.createProvider(
      resolved("openai", "openai", "text-embedding-3-small"),
      async () => "key",
    );

    expect(await p.embed([])).toEqual([]);
    expect(await p.embed("hello")).toEqual([[0.1, 0.2, 0.3]]);
    const multi = await p.embed(["a", "b"]);
    expect(multi).toHaveLength(2);
  });
});
