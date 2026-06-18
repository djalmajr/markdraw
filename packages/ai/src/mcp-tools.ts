// Turns the Rust MCP manager's tool list into engine-neutral `AITool[]` for the
// chat tool-calling loop. The `MCPBridge` is injected by the host (desktop wires
// it to the `ai_mcp_list_tools` / `ai_mcp_call_tool` Tauri commands), so this
// module stays free of Tauri and is unit-testable with a fake bridge.

import { sanitizeJsonSchema } from "./sanitize-schema.ts";
import type { AITool } from "./types.ts";

/** One tool as reported by the Rust manager (`ai_mcp_list_tools`). */
export interface MCPToolDescriptor {
  server: string;
  name: string;
  description?: string;
  /** Raw JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
  /** Optional JSON Schema for the tool's structured output (MCP `outputSchema`). */
  outputSchema?: Record<string, unknown>;
}

/** Options forwarded to a bridge tool call (e.g. an abort signal). */
export interface CallToolOptions {
  signal?: AbortSignal;
}

/** The seam the host implements over Tauri IPC. */
export interface MCPBridge {
  listTools(): Promise<MCPToolDescriptor[]>;
  callTool(
    server: string,
    name: string,
    args: unknown,
    opts?: CallToolOptions,
  ): Promise<unknown>;
}

export interface BuildMcpToolsOptions {
  /** Spill constraints stripped by `strictSchema` (format/pattern/default/...)
   *  into each schema node's `description` so the model still sees them even
   *  though the provider schema can't carry the keywords. Default false. */
  spillConstraints?: boolean;
  /** Apply OpenAI strict-mode schema tightening. Default false: Markdraw does
   *  not enable the SDK's strict tool mode, so the broad (semantics-preserving)
   *  sanitization is enough and required-fill would force optional params. */
  strictSchema?: boolean;
}

/** Max function-name length most providers accept. */
const MAX_TOOL_NAME = 64;

/** djb2 → base36; deterministic, used as a dedup suffix on truncated names. */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Tool name shown to the model: `<server>__<tool>`, sanitized to the provider
 *  name grammar (`^[a-zA-Z0-9_-]+$`) and capped to {@link MAX_TOOL_NAME}.
 *  Namespacing avoids collisions across servers; the source server is recovered
 *  via the `execute` closure, not by parsing this name, so sanitization is safe. */
export function namespacedToolName(server: string, name: string): string {
  const raw = `${server}__${name}`;
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (safe.length <= MAX_TOOL_NAME) return safe;
  const suffix = `_${shortHash(raw)}`;
  return safe.slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
}

/** Build `AITool[]` from the manager's tool list. Each tool's `execute` routes
 *  back through the bridge (Tauri IPC → Rust → the MCP server). Input schemas
 *  are sanitized so non-trivial MCP schemas don't 400 a provider turn. */
export async function buildMcpTools(
  bridge: MCPBridge,
  options: BuildMcpToolsOptions = {},
): Promise<AITool[]> {
  const descriptors = await bridge.listTools();
  return descriptors.map((d) => ({
    name: namespacedToolName(d.server, d.name),
    description: d.description,
    inputSchema: sanitizeJsonSchema(d.inputSchema, {
      spillToDescription: options.spillConstraints,
      strict: options.strictSchema,
    }),
    source: d.server,
    execute: (args: unknown, opts) => bridge.callTool(d.server, d.name, args, opts),
  }));
}
