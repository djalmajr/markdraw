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
