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
] as const);

const ModelLimitSchema = v.object({
  context: v.number(),
  output: v.number(),
});

const ModelConfigSchema = v.object({
  name: v.string(),
  limit: v.optional(ModelLimitSchema),
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
 *  whose ref can't be resolved is dropped rather than sent literally. */
const MCPServerConfigSchema = v.object({
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
});

/** Fully-resolved AI config (after merge). Model ids are in "provider/model" form. */
const AIConfigSchema = v.object({
  model: v.optional(v.string()),
  small_model: v.optional(v.string()),
  provider: v.record(v.string(), ProviderConfigSchema),
  mcp: v.optional(v.array(MCPServerConfigSchema)),
});

/** Lenient shape parsed from ai.json before merge-with-builtins. */
const UserAIConfigSchema = v.object({
  model: v.optional(v.string()),
  small_model: v.optional(v.string()),
  provider: v.optional(v.record(v.string(), UserProviderConfigSchema)),
  mcp: v.optional(v.array(MCPServerConfigSchema)),
});

type ProviderKind = v.InferOutput<typeof ProviderKindSchema>;
type ModelLimit = v.InferOutput<typeof ModelLimitSchema>;
type ModelConfig = v.InferOutput<typeof ModelConfigSchema>;
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
      };
    } else if (up.kind && up.name) {
      provider[id] = {
        kind: up.kind,
        name: up.name,
        npm: up.npm,
        options: up.options,
        models: up.models ?? {},
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

export {
  type AIConfig,
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
};
