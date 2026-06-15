// Provider/model configuration, opencode-style:
//   provider.<id> = { kind, name, options:{baseURL,apiKey,headers}, models:{<id>:{name,limit}} }
//
// Engine-neutral by design (see engine.ts). opencode uses a per-provider `npm`
// field because it is mono-engine (Vercel AI SDK). We support interchangeable
// engines (ai-sdk | tanstack), so the discriminator is `kind` (the API family)
// — each engine resolves its own package from `kind` ("@ai-sdk/anthropic" vs
// "@tanstack/ai-anthropic"). `npm` remains as an optional advanced override.
// API keys NEVER live in this config (they live in the OS keychain);
// `options.apiKey` may only hold a `{env:VAR}` / `{file:path}` reference — see
// resolve-credential.ts.

import * as v from "valibot";
import { safeJsonParse } from "@asciimark/core/schemas.ts";

/** API family a provider speaks — engines map this to their concrete SDK. */
const ProviderKindSchema = v.picklist([
  "anthropic",
  "openai",
  "openai-compatible",
  "claude-cli",
  "codex-cli",
] as const);

const ModelLimitSchema = v.object({
  context: v.number(),
  output: v.number(),
});

const ModelConfigSchema = v.object({
  name: v.string(),
  limit: v.optional(ModelLimitSchema),
});

/** An embedding model a provider exposes. `dim` (vector dimension) is load-bearing:
 *  the workspace index stores it with every vector and forces a reindex when it
 *  changes (a 1536-d query can't be scored against 768-d stored vectors). */
const EmbeddingModelConfigSchema = v.object({
  name: v.string(),
  dim: v.number(),
});

const ProviderOptionsSchema = v.object({
  baseURL: v.optional(v.string()),
  apiKey: v.optional(v.string()),
  headers: v.optional(v.record(v.string(), v.string())),
});

/** A fully-resolved provider (after merging user config over the built-in catalog). */
const ProviderConfigSchema = v.object({
  kind: ProviderKindSchema,
  name: v.string(),
  /** Optional advanced override of the SDK package; engines normally derive it
   *  from `kind`. Kept for opencode compatibility. */
  npm: v.optional(v.string()),
  options: v.optional(ProviderOptionsSchema),
  models: v.record(v.string(), ModelConfigSchema),
  /** Embedding models this provider exposes (for the "Full" workspace index).
   *  Absent/empty ⇒ the provider can't embed (see `providerCanEmbed`). */
  embeddingModels: v.optional(v.record(v.string(), EmbeddingModelConfigSchema)),
  /** Settings "Connect" catalog grouping. Providers sharing a `connectGroup`
   *  (e.g. the Anthropic API + the Claude subscription, both "Claude") render as
   *  ONE connect card offering each id's mode. Catalog-only — the model picker
   *  still groups by provider name, so the same model isn't listed twice. */
  connectGroup: v.optional(v.string()),
});

/** What the user may write in ai.json for a provider — every field optional, so
 *  they can override just `options.apiKey` or add a model to a built-in provider.
 *  A *custom* provider must supply at least `kind` + `name`. */
const UserProviderConfigSchema = v.object({
  kind: v.optional(ProviderKindSchema),
  name: v.optional(v.string()),
  npm: v.optional(v.string()),
  options: v.optional(ProviderOptionsSchema),
  models: v.optional(v.record(v.string(), ModelConfigSchema)),
  embeddingModels: v.optional(v.record(v.string(), EmbeddingModelConfigSchema)),
  connectGroup: v.optional(v.string()),
});

/** Transport a configured MCP server speaks. stdio spawns a child process
 *  (handled in Rust — the webview can't); http is Streamable HTTP. */
const MCPTransportSchema = v.picklist(["stdio", "http"] as const);

/** One MCP (Model Context Protocol) server the assistant may use as a tool
 *  source. The Rust manager (ai_mcp.rs) owns the connection for both
 *  transports; this is just the persisted definition. Secret tokens in
 *  `headers`/`env` should use `{env:VAR}` / `{file:path}` / `{keychain:id}`
 *  references — resolved in memory at connect time (desktop: ai-mcp.ts via
 *  resolve-credential `expandRecord`), so plaintext secrets never touch
 *  `ai.json`. Embedded refs like `Bearer {env:TOKEN}` are supported; a key
 *  whose ref can't be resolved is dropped rather than sent literally.
 *  Trust note: `{file:path}` reads any path the app can and the contents are
 *  sent to the server (including remote HTTP MCP servers) — only reference
 *  files you intend to transmit; prefer `{keychain:id}` for real secrets. */
const MCPServerConfigSchema = v.pipe(
  v.object({
    /** Stable id — also namespaces the server's tools as `<id>__<tool>`. */
    id: v.string(),
    /** Friendly label for the settings UI; falls back to `id`. */
    name: v.optional(v.string()),
    transport: MCPTransportSchema,
    /** Defaults to true at the use site when omitted. */
    enabled: v.optional(v.boolean()),
    // stdio transport
    command: v.optional(v.string()),
    args: v.optional(v.array(v.string())),
    env: v.optional(v.record(v.string(), v.string())),
    cwd: v.optional(v.string()),
    // http transport
    url: v.optional(v.string()),
    headers: v.optional(v.record(v.string(), v.string())),
  }),
  // Cross-field transport rule, forwarded so the issue lands on the missing
  // field: "stdio" has nothing to spawn without a `command`; "http" has
  // nothing to reach without a `url`. An entry violating this FAILS the
  // schema — the resolved AIConfigSchema uses it as-is; the lenient user
  // config filters invalid entries one by one instead (see UserMCPListSchema).
  v.forward(
    v.check(
      (server) => server.transport !== "stdio" || (server.command ?? "").trim() !== "",
      'transport "stdio" requires a non-empty `command`',
    ),
    ["command"],
  ),
  v.forward(
    v.check(
      (server) => server.transport !== "http" || (server.url ?? "").trim() !== "",
      'transport "http" requires a non-empty `url`',
    ),
    ["url"],
  ),
);

/** Fully-resolved AI config (after merge). Model ids are in "provider/model" form. */
const AIConfigSchema = v.object({
  model: v.optional(v.string()),
  small_model: v.optional(v.string()),
  provider: v.record(v.string(), ProviderConfigSchema),
  mcp: v.optional(v.array(MCPServerConfigSchema)),
});

/** Per-entry lenient `mcp` list for ai.json. Each entry is validated against
 *  the full MCPServerConfigSchema (shape + transport rule) on its own, and
 *  entries that fail are DROPPED rather than failing the whole config — one
 *  typo'd server must not make parseUserConfig return null and wipe the
 *  user's model/provider settings. Mirrors how mergeConfigs ignores an
 *  incomplete custom provider. A non-array `mcp` is still a whole-config
 *  schema mismatch (null), and the resolved AIConfigSchema stays strict. */
const UserMCPListSchema = v.pipe(
  v.array(v.unknown()),
  v.transform((entries) =>
    entries.flatMap((entry) => {
      const parsed = v.safeParse(MCPServerConfigSchema, entry);
      return parsed.success ? [parsed.output] : [];
    }),
  ),
);

/** Lenient shape parsed from ai.json before merge-with-builtins. */
const UserAIConfigSchema = v.object({
  model: v.optional(v.string()),
  small_model: v.optional(v.string()),
  provider: v.optional(v.record(v.string(), UserProviderConfigSchema)),
  mcp: v.optional(UserMCPListSchema),
});

type ProviderKind = v.InferOutput<typeof ProviderKindSchema>;
type ModelLimit = v.InferOutput<typeof ModelLimitSchema>;
type ModelConfig = v.InferOutput<typeof ModelConfigSchema>;
type EmbeddingModelConfig = v.InferOutput<typeof EmbeddingModelConfigSchema>;
type ProviderOptions = v.InferOutput<typeof ProviderOptionsSchema>;
type ProviderConfig = v.InferOutput<typeof ProviderConfigSchema>;
type UserProviderConfig = v.InferOutput<typeof UserProviderConfigSchema>;
type MCPTransport = v.InferOutput<typeof MCPTransportSchema>;
type MCPServerConfig = v.InferOutput<typeof MCPServerConfigSchema>;
type AIConfig = v.InferOutput<typeof AIConfigSchema>;
type UserAIConfig = v.InferOutput<typeof UserAIConfigSchema>;

/** Parse ai.json text into a lenient `UserAIConfig`, or null on bad JSON /
 *  schema mismatch (mirrors the core `safeJsonParse` storage-boundary pattern). */
function parseUserConfig(raw: string | null): UserAIConfig | null {
  return safeJsonParse(raw, UserAIConfigSchema);
}

function mergeOptions(
  base: ProviderOptions | undefined,
  override: ProviderOptions | undefined,
): ProviderOptions | undefined {
  if (!base && !override) return undefined;
  const merged: ProviderOptions = { ...(base ?? {}), ...(override ?? {}) };
  const headers = { ...(base?.headers ?? {}), ...(override?.headers ?? {}) };
  if (Object.keys(headers).length > 0) merged.headers = headers;
  else delete merged.headers;
  return merged;
}

/** Merge embedding-model maps (user over builtin), omitting the field entirely
 *  when neither side declares any — so `providerCanEmbed` stays a clean check. */
function mergeEmbeddingModels(
  base: Record<string, EmbeddingModelConfig> | undefined,
  override: Record<string, EmbeddingModelConfig> | undefined,
): { embeddingModels?: Record<string, EmbeddingModelConfig> } {
  const merged = { ...(base ?? {}), ...(override ?? {}) };
  return Object.keys(merged).length > 0 ? { embeddingModels: merged } : {};
}

/**
 * Deep-merge a user config over the built-in provider catalog, producing a
 * fully-resolved `AIConfig`. Known providers inherit `npm`/`name`/`models`
 * from the builtin and let the user override `options` (e.g. baseURL) and add
 * models. Unknown ("custom") providers must supply at least `npm` + `name`,
 * otherwise they are dropped (an incomplete custom provider can't build an
 * adapter). Engine-agnostic: pass whichever builtin catalog the chosen engine
 * defines.
 */
function mergeConfigs(
  builtins: Record<string, ProviderConfig>,
  user: UserAIConfig,
): AIConfig {
  const provider: Record<string, ProviderConfig> = structuredClone(builtins);
  for (const [id, up] of Object.entries(user.provider ?? {})) {
    const base = provider[id];
    if (base) {
      provider[id] = {
        kind: up.kind ?? base.kind,
        name: up.name ?? base.name,
        npm: up.npm ?? base.npm,
        options: mergeOptions(base.options, up.options),
        models: { ...base.models, ...(up.models ?? {}) },
        ...mergeEmbeddingModels(base.embeddingModels, up.embeddingModels),
        ...(up.connectGroup ?? base.connectGroup
          ? { connectGroup: up.connectGroup ?? base.connectGroup }
          : {}),
      };
    } else if (up.kind && up.name) {
      provider[id] = {
        kind: up.kind,
        name: up.name,
        npm: up.npm,
        options: up.options,
        models: up.models ?? {},
        ...mergeEmbeddingModels(undefined, up.embeddingModels),
        ...(up.connectGroup ? { connectGroup: up.connectGroup } : {}),
      };
    }
    // else: incomplete custom provider — ignored
  }
  return {
    model: user.model,
    small_model: user.small_model,
    provider,
    // Built-ins ship no MCP servers; the user's list passes through verbatim.
    ...(user.mcp ? { mcp: user.mcp } : {}),
  };
}

/** Whether a provider can produce embeddings for the "Full" workspace index.
 *  Subscription CLIs (claude-cli/codex-cli) are chat-only and Anthropic has no
 *  embeddings API; every other kind needs at least one declared embedding model. */
function providerCanEmbed(p: ProviderConfig): boolean {
  if (p.kind === "claude-cli" || p.kind === "codex-cli" || p.kind === "anthropic") return false;
  return Object.keys(p.embeddingModels ?? {}).length > 0;
}

export {
  type AIConfig,
  type EmbeddingModelConfig,
  type MCPServerConfig,
  type MCPTransport,
  type ModelConfig,
  type ModelLimit,
  type ProviderConfig,
  type ProviderKind,
  type ProviderOptions,
  type UserAIConfig,
  type UserProviderConfig,
  AIConfigSchema,
  EmbeddingModelConfigSchema,
  MCPServerConfigSchema,
  MCPTransportSchema,
  ModelConfigSchema,
  ProviderConfigSchema,
  ProviderKindSchema,
  ProviderOptionsSchema,
  UserAIConfigSchema,
  UserProviderConfigSchema,
  mergeConfigs,
  parseUserConfig,
  providerCanEmbed,
};
