import { describe, expect, it } from "bun:test";
import type { ProviderConfig } from "./config-schema.ts";
import { expandRecord, expandRefs, resolveCredential } from "./resolve-credential.ts";

const anthropic: ProviderConfig = {
  kind: "anthropic",
  name: "Anthropic",
  models: { "claude-sonnet-4-6": { name: "Claude Sonnet 4.6" } },
};

describe("resolveCredential precedence", () => {
  it("conventional env var wins over keychain and config", async () => {
    const key = await resolveCredential(
      "anthropic",
      { ...anthropic, options: { apiKey: "literal-config" } },
      {
        env: (n) => (n === "ANTHROPIC_API_KEY" ? "from-env" : undefined),
        keychain: () => "from-keychain",
      },
    );
    expect(key).toBe("from-env");
  });

  it("keychain wins over config when no env var", async () => {
    const key = await resolveCredential(
      "anthropic",
      { ...anthropic, options: { apiKey: "literal-config" } },
      { env: () => undefined, keychain: () => "from-keychain" },
    );
    expect(key).toBe("from-keychain");
  });

  it("falls back to a literal config apiKey", async () => {
    const key = await resolveCredential(
      "anthropic",
      { ...anthropic, options: { apiKey: "literal-config" } },
      { keychain: () => undefined },
    );
    expect(key).toBe("literal-config");
  });

  it("returns undefined (no throw) when nothing resolves", async () => {
    const key = await resolveCredential("anthropic", anthropic, {});
    expect(key).toBeUndefined();
  });
});

describe("resolveCredential substitution", () => {
  it("expands {env:VAR} in config apiKey", async () => {
    const key = await resolveCredential(
      "custom",
      { ...anthropic, options: { apiKey: "{env:MY_KEY}" } },
      { env: (n) => (n === "MY_KEY" ? "secret" : undefined) },
    );
    expect(key).toBe("secret");
  });

  it("expands {file:path} in config apiKey and trims it", async () => {
    const key = await resolveCredential(
      "custom",
      { ...anthropic, options: { apiKey: "{file:/keys/openai.txt}" } },
      { file: (p) => (p === "/keys/openai.txt" ? "  sk-from-file\n" : undefined) },
    );
    expect(key).toBe("sk-from-file");
  });

  it("returns undefined when an {env:VAR} reference is unset", async () => {
    const key = await resolveCredential(
      "custom",
      { ...anthropic, options: { apiKey: "{env:MISSING}" } },
      { env: () => undefined },
    );
    expect(key).toBeUndefined();
  });

  it("uses a provider with no conventional env mapping via keychain", async () => {
    const key = await resolveCredential("ollama", { ...anthropic, name: "Ollama" }, {
      keychain: (id) => (id === "ollama" ? "ollama-key" : undefined),
    });
    expect(key).toBe("ollama-key");
  });
});

describe("expandRefs (MCP headers/env)", () => {
  const resolvers = {
    env: (n: string) => (n === "TOKEN" ? "t0k3n" : undefined),
    file: (p: string) => (p === "/k" ? "  filekey\n" : undefined),
    keychain: (id: string) => (id === "mcp-linear" ? "kc-secret" : undefined),
  };

  it("returns a literal unchanged when there are no refs", async () => {
    expect(await expandRefs("application/json", resolvers)).toBe("application/json");
  });

  it("expands an embedded {env:} ref (Bearer token)", async () => {
    expect(await expandRefs("Bearer {env:TOKEN}", resolvers)).toBe("Bearer t0k3n");
  });

  it("expands {file:} (trimmed) and {keychain:}", async () => {
    expect(await expandRefs("{file:/k}", resolvers)).toBe("filekey");
    expect(await expandRefs("{keychain:mcp-linear}", resolvers)).toBe("kc-secret");
  });

  it("expands multiple refs in one value", async () => {
    expect(await expandRefs("{env:TOKEN}:{keychain:mcp-linear}", resolvers)).toBe("t0k3n:kc-secret");
  });

  it("returns undefined when any ref is unresolvable", async () => {
    expect(await expandRefs("Bearer {env:MISSING}", resolvers)).toBeUndefined();
    expect(await expandRefs("{keychain:nope}", resolvers)).toBeUndefined();
  });
});

describe("expandRecord (MCP headers/env)", () => {
  const resolvers = {
    env: (n: string) => (n === "TOKEN" ? "t0k3n" : undefined),
  };

  it("expands resolvable values and drops keys with unresolvable refs", async () => {
    const out = await expandRecord(
      {
        Authorization: "Bearer {env:TOKEN}",
        "Content-Type": "application/json",
        "X-Missing": "{env:NOPE}",
      },
      resolvers,
    );
    expect(out).toEqual({
      Authorization: "Bearer t0k3n",
      "Content-Type": "application/json",
    });
  });

  it("returns an empty record for an empty input", async () => {
    expect(await expandRecord({}, resolvers)).toEqual({});
  });
});
