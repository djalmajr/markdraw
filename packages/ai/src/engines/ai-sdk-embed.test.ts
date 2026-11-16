import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "../engine.ts";
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

// Answers OpenAI `/embeddings` calls with one fixed vector per input, through
// the real SDK. (No `mock.module`: Bun's module mocks are process-wide and
// leaked a fake `ai` into every later test file.)
function fakeEmbeddingsFetch(): { fetchImpl: FetchImpl; calls: Array<{ url: string; input: string[] }> } {
  const calls: Array<{ url: string; input: string[] }> = [];
  const impl = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    calls.push({ url: String(input), input: body.input });
    return new Response(
      JSON.stringify({
        object: "list",
        data: body.input.map((_, index) => ({ object: "embedding", index, embedding: [0.1, 0.2, 0.3] })),
        model: "text-embedding-3-small",
        usage: { prompt_tokens: body.input.length, total_tokens: body.input.length },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { fetchImpl: impl as FetchImpl, calls };
}

describe("ai-sdk engine embed()", () => {
  it("throws NotSupportedError for providers without embeddings (anthropic)", async () => {
    const p = aiSdkEngine.createProvider(resolved("anthropic", "anthropic", "x"), async () => "key");
    await expect(p.embed("hello")).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("embeds via OpenAI embeddingModel; wraps a single string; short-circuits empty", async () => {
    const { fetchImpl, calls } = fakeEmbeddingsFetch();
    const p = aiSdkEngine.createProvider(
      resolved("openai", "openai", "text-embedding-3-small"),
      async () => "key",
      { fetch: fetchImpl },
    );

    expect(await p.embed([])).toEqual([]);
    expect(calls).toHaveLength(0);

    expect(await p.embed("hello")).toEqual([[0.1, 0.2, 0.3]]);
    expect(calls[0].url).toEndWith("/embeddings");
    expect(calls[0].input).toEqual(["hello"]);

    const multi = await p.embed(["a", "b"]);
    expect(multi).toHaveLength(2);
    expect(calls[1].input).toEqual(["a", "b"]);
  });
});
