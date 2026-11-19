// The write that saves a provider's key from the settings form. It must not
// replace the provider's entry: the form only carries the selected model, and
// the entry may hold a custom provider's kind/name/options, sibling manual
// models, and fields written by another version of the app.

import { describe, expect, it } from "bun:test";
import type { UserAIConfig } from "@markdraw/ai/config-schema.ts";
import { withProviderSelection } from "./ai-provider-merge.ts";

function user(provider: Record<string, unknown>, extra: Record<string, unknown> = {}): UserAIConfig {
  return { provider, ...extra } as unknown as UserAIConfig;
}

/** Read the written JSON by field name: unknown fields are exactly what the
 *  tests check survive, so the schema type is too narrow here. */
function field(config: UserAIConfig, key: string): unknown {
  return (config as unknown as Record<string, unknown>)[key];
}

function entries(config: UserAIConfig): Record<string, unknown> {
  return (field(config, "provider") ?? {}) as Record<string, unknown>;
}

describe("withProviderSelection — mescla só os campos do formulário", () => {
  it("provider customizado: kind, nome, opções e modelos manuais sobrevivem", () => {
    const before = user(
      {
        custom: {
          kind: "openai-compatible",
          name: "Meu Gateway",
          options: { baseURL: "https://gw.test/v1", headers: { "X-Org": "acme" } },
          models: {
            "manual-a": { name: "Manual A" },
            "manual-b": { name: "Manual B", limit: { context: 4096 } },
          },
        },
        other: { kind: "openai-compatible", name: "Outro", models: { x: { name: "X" } } },
      },
      { small_model: "custom/manual-a", mcp: [{ id: "docs" }] },
    );
    const after = withProviderSelection(before, "custom", "escolhido");
    expect(entries(after).custom).toEqual({
      kind: "openai-compatible",
      name: "Meu Gateway",
      options: { baseURL: "https://gw.test/v1", headers: { "X-Org": "acme" } },
      models: {
        "manual-a": { name: "Manual A" },
        "manual-b": { name: "Manual B", limit: { context: 4096 } },
        escolhido: { name: "escolhido" },
      },
    });
    // Sibling sections and providers are untouched.
    expect(entries(after).other).toEqual({
      kind: "openai-compatible",
      name: "Outro",
      models: { x: { name: "X" } },
    });
    expect(field(after, "small_model")).toBe("custom/manual-a");
    expect(field(after, "mcp")).toEqual([{ id: "docs" }]);
    expect(after.model).toBe("custom/escolhido");
  });

  it("modelo já existente mantém a definição (nome, limite, reasoning)", () => {
    const before = user({
      p: {
        kind: "openai-compatible",
        name: "P",
        options: { baseURL: "https://p.test/v1" },
        models: { m: { name: "Nome Bonito", limit: { context: 200000 }, reasoning: ["high"] } },
      },
    });
    const after = withProviderSelection(before, "p", "m");
    expect(entries(after).p).toEqual({
      kind: "openai-compatible",
      name: "P",
      options: { baseURL: "https://p.test/v1" },
      models: { m: { name: "Nome Bonito", limit: { context: 200000 }, reasoning: ["high"] } },
    });
    expect(after.model).toBe("p/m");
  });

  it("provider sem entrada no ai.json vira só o modelo escolhido", () => {
    const after = withProviderSelection(user({}), "anthropic", "claude-haiku-5-5");
    expect(entries(after)).toEqual({
      anthropic: { models: { "claude-haiku-5-5": { name: "claude-haiku-5-5" } } },
    });
    expect(after.model).toBe("anthropic/claude-haiku-5-5");
  });

  it("entrada sem modelos e config sem provider", () => {
    const withEntry = withProviderSelection(
      user({ anthropic: { kind: "anthropic", name: "Anthropic" } }),
      "anthropic",
      "m",
    );
    expect(field(withEntry, "provider")).toEqual({
      anthropic: { kind: "anthropic", name: "Anthropic", models: { m: { name: "m" } } },
    });
    expect(withEntry.model).toBe("anthropic/m");
    expect(withProviderSelection({} as UserAIConfig, "p", "m")).toEqual({
      model: "p/m",
      provider: { p: { models: { m: { name: "m" } } } },
    });
  });

  it("hostil: campos que chegam ao helper fora do formulário ficam como estão (o parse do ai.json já descartou os desconhecidos)", () => {
    const before = user(
      {
        p: {
          kind: "openai-compatible",
          name: "P",
          options: { baseURL: "https://p.test/v1" },
          futureField: { nested: [1, 2] },
          models: { m: { name: "M", futureModelField: "keep" } },
        },
      },
      { schemaVersion: 7, extra: null },
    );
    const after = withProviderSelection(before, "p", "novo");
    expect(entries(after).p).toEqual({
      kind: "openai-compatible",
      name: "P",
      options: { baseURL: "https://p.test/v1" },
      futureField: { nested: [1, 2] },
      models: { m: { name: "M", futureModelField: "keep" }, novo: { name: "novo" } },
    });
    expect(field(after, "schemaVersion")).toBe(7);
    expect(field(after, "extra")).toBeNull();
  });

  it("hostil: models de tipo errado no objeto recebido não quebram a mescla", () => {
    const before = user({
      p: { kind: "openai-compatible", name: "P", options: { baseURL: "https://p.test/v1" }, models: "lixo" },
      q: { kind: "openai-compatible", name: "Q", options: { baseURL: "https://q.test/v1" }, models: ["a"] },
    });
    const after = withProviderSelection(before, "p", "m");
    expect(entries(after).p).toEqual({
      kind: "openai-compatible",
      name: "P",
      options: { baseURL: "https://p.test/v1" },
      models: { m: { name: "m" } },
    });
    // A segunda gravação também converge.
    const again = withProviderSelection(after, "q", "m");
    expect(entries(again).q).toEqual({
      kind: "openai-compatible",
      name: "Q",
      options: { baseURL: "https://q.test/v1" },
      models: { m: { name: "m" } },
    });
  });

  it("idempotente: salvar o mesmo modelo duas vezes dá o mesmo JSON", () => {
    const before = user({
      p: {
        kind: "openai-compatible",
        name: "P",
        options: { baseURL: "https://p.test/v1" },
        models: { manual: { name: "Manual" } },
      },
    });
    const once = withProviderSelection(before, "p", "m");
    const twice = withProviderSelection(once, "p", "m");
    expect(twice).toEqual(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("não muta a config recebida", () => {
    const before = user({
      p: {
        kind: "openai-compatible",
        name: "P",
        options: { baseURL: "https://p.test/v1" },
        models: { manual: { name: "Manual" } },
      },
    });
    const snapshot = JSON.parse(JSON.stringify(before)) as unknown;
    withProviderSelection(before, "p", "novo");
    expect(before as unknown).toEqual(snapshot);
  });
});
