import { describe, expect, it } from "bun:test";
import modelsDevFixture from "./__fixtures__/models-dev.json";
import { ModelListParseError } from "./model-catalog.ts";
import { parseModelsDevCatalog } from "./models-dev.ts";

describe("parseModelsDevCatalog", () => {
  it("reads the real catalog cut by provider with name, context, reasoning and status", () => {
    const catalog = parseModelsDevCatalog(modelsDevFixture);
    expect(catalog.anthropic).toEqual([
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5 (latest)",
        context: 200000,
        reasoning: true,
        deprecated: true,
      },
      {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        context: 1000000,
        reasoning: true,
      },
    ]);
    expect(catalog["opencode-go"]).toEqual([
      {
        id: "glm-5.3-flash",
        name: "GLM-5.3-Flash",
        context: 1000000,
        reasoning: true,
      },
      {
        id: "cat-jam-free",
        name: "Cat Jam Free",
        context: 1048576,
        reasoning: true,
        deprecated: true,
      },
    ]);
  });

  it("falls back to the catalog key when the model has no id and keeps sparse models", () => {
    expect(
      parseModelsDevCatalog({
        vendor: { models: { "id-from-key": { name: "Named", reasoning: false } } },
      }),
    ).toEqual({ vendor: [{ id: "id-from-key", name: "Named", reasoning: false }] });
  });

  it("keeps a valid calendar day as releaseDate and treats anything else as absent", () => {
    expect(
      parseModelsDevCatalog({
        anthropic: {
          models: {
            "claude-opus-5-5": {
              id: "claude-opus-5-5",
              name: "Opus 5.5",
              release_date: "2026-01-15",
            },
            "claude-opus-4-8": { id: "claude-opus-4-8", name: "Opus 4.8", release_date: "" },
            "claude-opus-4-7": { id: "claude-opus-4-7", release_date: 20250101 },
            "claude-opus-4-6": { id: "claude-opus-4-6" },
            // F4: Date.parse normalize `2026-02-30` para 2 de março; o dia
            // impossível tem de contar como ausente, não como 2 de março.
            "claude-opus-4-5": { id: "claude-opus-4-5", release_date: "2026-02-30" },
            "claude-opus-4-4": { id: "claude-opus-4-4", release_date: "2026-02-29" },
            "claude-opus-4-3": { id: "claude-opus-4-3", release_date: "2026-13-01" },
            "claude-opus-4-2": { id: "claude-opus-4-2", release_date: "2026-1-5" },
            "claude-opus-4-1": { id: "claude-opus-4-1", release_date: "15/01/2026" },
          },
        },
      }).anthropic,
    ).toEqual([
      { id: "claude-opus-5-5", name: "Opus 5.5", releaseDate: "2026-01-15" },
      { id: "claude-opus-4-8", name: "Opus 4.8" },
      { id: "claude-opus-4-7" },
      { id: "claude-opus-4-6" },
      { id: "claude-opus-4-5" },
      { id: "claude-opus-4-4" },
      { id: "claude-opus-4-3" },
      { id: "claude-opus-4-2" },
      { id: "claude-opus-4-1" },
    ]);
  });

  it("accepts a leap day that exists and rejects one that does not", () => {
    expect(
      parseModelsDevCatalog({
        anthropic: {
          models: {
            "claude-opus-5-5": { id: "claude-opus-5-5", release_date: "2024-02-29" },
            "claude-opus-5-4": { id: "claude-opus-5-4", release_date: "2023-02-29" },
          },
        },
      }).anthropic,
    ).toEqual([
      { id: "claude-opus-5-5", releaseDate: "2024-02-29" },
      { id: "claude-opus-5-4" },
    ]);
  });

  it("skips providers with no models and tolerates an empty catalog", () => {
    expect(parseModelsDevCatalog({ vendor: {} })).toEqual({});
    expect(parseModelsDevCatalog({ vendor: { models: {} } })).toEqual({ vendor: [] });
    expect(parseModelsDevCatalog({})).toEqual({});
  });

  it("rejects malformed catalogs with the typed parse error", () => {
    expect(() => parseModelsDevCatalog([])).toThrow(ModelListParseError);
    expect(() => parseModelsDevCatalog({ vendor: { models: [] } })).toThrow(ModelListParseError);
    expect(() => parseModelsDevCatalog({ vendor: { models: { bad: null } } })).toThrow(
      ModelListParseError,
    );
  });
});
