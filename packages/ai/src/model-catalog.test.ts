import { describe, expect, it } from "bun:test";
import agyFixture from "./__fixtures__/agy-models.txt";
import codexFixture from "./__fixtures__/codex-models-cache.json";
import goFixture from "./__fixtures__/opencode-go-models.json";
import grokFixture from "./__fixtures__/grok-models.txt";
import openRouterFixture from "./__fixtures__/openrouter-models.json";
import zenFixture from "./__fixtures__/opencode-zen-models.json";
import {
  type AnthropicPageState,
  ModelListParseError,
  parseAntigravityModels,
  parseAnthropicModels,
  parseCodexModelCache,
  parseGrokModels,
  parseOpenAiCompatibleModels,
  parseOpenCodeModels,
  parseOpenRouterModels,
} from "./model-catalog.ts";

describe("parseOpenAiCompatibleModels", () => {
  const raw = {
    data: [
      { id: "gpt-6.2-astra", name: "GPT-6.2 Astra" },
      { id: "text-embedding-3-large" },
      { id: "whisper-1" },
      { id: "o3" },
    ],
  };

  it("normalizes other OpenAI-compatible providers without filtering", () => {
    expect(parseOpenAiCompatibleModels(raw)).toEqual([
      { id: "gpt-6.2-astra", name: "GPT-6.2 Astra" },
      { id: "text-embedding-3-large" },
      { id: "whisper-1" },
      { id: "o3" },
    ]);
  });

  it("applies the OpenAI chat filter moved here from app.tsx", () => {
    expect(parseOpenAiCompatibleModels(raw, { chatFilter: true })).toEqual([
      { id: "gpt-6.2-astra", name: "GPT-6.2 Astra" },
      { id: "o3" },
    ]);
    // Control ids that the allowlist/denylist keep or reject.
    expect(parseOpenAiCompatibleModels({ data: [{ id: "chatgpt-4o" }] }, { chatFilter: true })).toEqual([
      { id: "chatgpt-4o" },
    ]);
    expect(
      parseOpenAiCompatibleModels({ data: [{ id: "dall-e-3" }] }, { chatFilter: true }),
    ).toEqual([]);
  });

  it("keeps a deprecated flag instead of dropping the model", () => {
    expect(
      parseOpenAiCompatibleModels({
        data: [{ id: "gpt-4", name: "GPT-4", deprecated: true }],
      }),
    ).toEqual([{ id: "gpt-4", name: "GPT-4", deprecated: true }]);
  });

  it("returns an empty list for empty data and a typed error for malformed input", () => {
    expect(parseOpenAiCompatibleModels({ data: [] })).toEqual([]);
    expect(() => parseOpenAiCompatibleModels(null)).toThrow(ModelListParseError);
    expect(() => parseOpenAiCompatibleModels({ data: {} })).toThrow(ModelListParseError);
    expect(() => parseOpenAiCompatibleModels({ data: [{ name: "no id" }] })).toThrow(
      ModelListParseError,
    );
  });
});

describe("parseAnthropicModels", () => {
  it("normalizes display_name and writes the next-page cursor to the output parameter", () => {
    const page: AnthropicPageState = { hasMore: false, lastId: "stale" };
    const models = parseAnthropicModels(
      {
        data: [
          { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
          { id: "claude-haiku-5-5" },
        ],
        has_more: true,
        last_id: "claude-haiku-5-5",
      },
      page,
    );
    expect(models).toEqual([
      { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { id: "claude-haiku-5-5" },
    ]);
    expect(page).toEqual({ hasMore: true, lastId: "claude-haiku-5-5" });
  });

  it("preserves a deprecated flag", () => {
    const page: AnthropicPageState = { hasMore: false };
    expect(
      parseAnthropicModels(
        { data: [{ id: "claude-sonnet-4-5", status: "deprecated" }], has_more: false },
        page,
      ),
    ).toEqual([{ id: "claude-sonnet-4-5", deprecated: true }]);
  });

  it("clears the cursor on the last page", () => {
    const page: AnthropicPageState = { hasMore: true, lastId: "old" };
    expect(parseAnthropicModels({ data: [], has_more: false, last_id: null }, page)).toEqual([]);
    expect(page).toEqual({ hasMore: false, lastId: undefined });
  });

  it("rejects malformed pages with the typed error", () => {
    const page: AnthropicPageState = { hasMore: false };
    expect(() => parseAnthropicModels({ data: "nope" }, page)).toThrow(ModelListParseError);
    expect(() => parseAnthropicModels([], page)).toThrow(ModelListParseError);
  });
});

describe("parseOpenCodeModels", () => {
  it("splits the real OpenCode Go sample by recommended_api and discards other formats", () => {
    const lists = parseOpenCodeModels(goFixture);
    expect(lists.chatCompletions).toEqual([
      {
        id: "deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash 1017",
        context: 1000000,
        reasoning: true,
      },
    ]);
    expect(lists.messages).toEqual([
      { id: "minimax-m3", name: "MiniMax-M3", context: 1000000, reasoning: true },
    ]);
    // responses (gpt-6-luna) and generate-content (gemini-4-argon) are gone.
  });

  it("splits the real OpenCode Zen sample and drops images", () => {
    const lists = parseOpenCodeModels(zenFixture);
    expect(lists.chatCompletions.map((m) => m.id)).toEqual(["big-pickle"]);
    expect(lists.messages.map((m) => m.id)).toEqual(["claude-haiku-5-5"]);
    expect(lists).not.toHaveProperty("images");
    // gemini-nano-banana-2.1 has api keys images + generate-content.
  });

  it("drops deprecated models and unknown API formats", () => {
    const deprecated = structuredClone(goFixture) as {
      data: Array<Record<string, unknown>>;
    };
    deprecated.data[0]!.status = "deprecated";
    expect(parseOpenCodeModels(deprecated)).toEqual({
      messages: [{ id: "minimax-m3", name: "MiniMax-M3", context: 1000000, reasoning: true }],
      chatCompletions: [],
    });
    expect(
      parseOpenCodeModels({
        data: [{ id: "live-1", api: { live: {} }, recommended_api: "live" }],
      }),
    ).toEqual({ messages: [], chatCompletions: [] });
  });

  it("falls back to api keys when recommended_api is absent", () => {
    expect(
      parseOpenCodeModels({
        data: [{ id: "claude-x", api: { messages: {} }, name: "Claude X" }],
      }),
    ).toEqual({ messages: [{ id: "claude-x", name: "Claude X" }], chatCompletions: [] });
  });

  it("returns empty lists for empty data and a typed error for malformed input", () => {
    expect(parseOpenCodeModels({ data: [] })).toEqual({ messages: [], chatCompletions: [] });
    expect(() => parseOpenCodeModels({})).toThrow(ModelListParseError);
    expect(() => parseOpenCodeModels({ data: [null] })).toThrow(ModelListParseError);
  });
});

describe("parseOpenRouterModels", () => {
  it("reads the real public sample: name, context_length and reasoning", () => {
    expect(parseOpenRouterModels(openRouterFixture)).toEqual([
      {
        id: "google/gemini-4-neon",
        name: "Google: Gemini 4 Neon",
        context: 1048576,
        reasoning: true,
      },
      {
        id: "google/gemini-4-neon:batch",
        name: "Google: Gemini 4 Neon (batch)",
        context: 1048576,
        reasoning: true,
      },
      {
        id: "openai/gpt-6.2-astra-pro",
        name: "OpenAI: GPT-6.2 Astra Pro",
        context: 1050000,
        reasoning: true,
      },
    ]);
  });

  it("handles missing optional fields, deprecated records and malformed input", () => {
    expect(parseOpenRouterModels({ data: [{ id: "x/y" }] })).toEqual([{ id: "x/y" }]);
    expect(
      parseOpenRouterModels({ data: [{ id: "old/y", status: "deprecated" }] }),
    ).toEqual([{ id: "old/y", deprecated: true }]);
    expect(parseOpenRouterModels({ data: [] })).toEqual([]);
    expect(() => parseOpenRouterModels({ data: [{ name: "no id" }] })).toThrow(
      ModelListParseError,
    );
  });
});

describe("parseGrokModels", () => {
  it("reads the real CLI output, marking the default and ignoring headers", () => {
    expect(parseGrokModels(grokFixture)).toEqual([
      { id: "grok-4.6", default: true },
      { id: "grok-4.5" },
    ]);
  });

  it("ignores hostile-looking header lines and handles empty output", () => {
    expect(
      parseGrokModels("You are not authenticated.\n\nDefault model: grok-4.6\nAvailable models:\n"),
    ).toEqual([]);
    expect(() => parseGrokModels(null as unknown as string)).toThrow(ModelListParseError);
  });
});

describe("parseAntigravityModels", () => {
  it("reads the real CLI output as id + display name", () => {
    const models = parseAntigravityModels(agyFixture);
    expect(models).toHaveLength(23);
    expect(models[0]).toEqual({ id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" });
    expect(models.at(-1)).toEqual({ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" });
  });

  it("skips the fetching banner and rejects malformed input", () => {
    expect(parseAntigravityModels("Fetching available models...\n")).toEqual([]);
    expect(() => parseAntigravityModels(42 as unknown as string)).toThrow(ModelListParseError);
  });
});

describe("parseCodexModelCache", () => {
  it("reads only model fields from the real cache cut and drops hidden entries", () => {
    expect(parseCodexModelCache(codexFixture)).toEqual([
      {
        id: "gpt-6.2-sol",
        name: "GPT-6.2-Sol",
        context: 500000,
        reasoning: true,
      },
      {
        id: "gpt-6.2-astra",
        name: "GPT-6.2-Astra",
        context: 272000,
        reasoning: true,
      },
    ]);
    // gpt-6-chat-thinking, gpt-reserve and codex-auto-review are visibility: hide.
  });

  it("preserves a deprecated flag", () => {
    expect(
      parseCodexModelCache({
        models: [{ slug: "old-codex", visibility: "list", deprecated: true }],
      }),
    ).toEqual([{ id: "old-codex", deprecated: true }]);
  });

  it("accepts an object keyed by id, skips empty lists and rejects malformed input", () => {
    expect(
      parseCodexModelCache({ models: { a: { slug: "a", visibility: "list" } } }),
    ).toEqual([{ id: "a" }]);
    expect(parseCodexModelCache({ models: [] })).toEqual([]);
    expect(() => parseCodexModelCache({})).toThrow(ModelListParseError);
    expect(() => parseCodexModelCache({ models: [{ display_name: "no slug" }] })).toThrow(
      ModelListParseError,
    );
  });
});
