// Desktop bridge to the Rust MCP manager (src-tauri/src/ai_mcp.rs). Wraps the
// Tauri commands so the engine-neutral packages/ai and the settings UI can talk
// to MCP servers without importing Tauri directly.

import { invoke } from "./chaos-invoke.ts";
import { getApiKey } from "./ai-credentials.ts";
import type { MCPBridge, MCPToolDescriptor } from "@asciimark/ai/mcp-tools.ts";
import type { MCPServerConfig } from "@asciimark/ai/config-schema.ts";
import { expandRecord, type HostResolvers } from "@asciimark/ai/resolve-credential.ts";

export interface McpServerStatus {
  id: string;
  connected: boolean;
  toolCount: number;
}

/** The bridge the chat engine uses to discover + invoke MCP tools. */
export function createMcpBridge(): MCPBridge {
  return {
    listTools: () => invoke<MCPToolDescriptor[]>("ai_mcp_list_tools"),
    callTool: (server, name, args) =>
      invoke<unknown>("ai_mcp_call_tool", { server, name, args }),
  };
}

/** Resolvers for `{env:VAR}` / `{file:path}` / `{keychain:id}` references in MCP
 *  `env` / `headers`. Secrets resolve here (in memory, at connect time) and the
 *  resolved values go straight to Rust — `ai.json` only ever holds the refs. */
function mcpSecretResolvers(): HostResolvers {
  return {
    env: (name) => invoke<string | null>("ai_read_env", { name }).then((v) => v ?? undefined),
    file: async (path) => {
      try {
        return await invoke<string>("read_file", { path });
      } catch {
        return undefined; // missing/unreadable file -> ref unresolved -> key dropped
      }
    },
    keychain: (id) => getApiKey(id).then((k) => k ?? undefined),
  };
}

/** Resolve secret references in a server's `env`/`headers` before it crosses the
 *  IPC boundary. Keys whose refs can't be resolved are dropped (never sent as a
 *  literal `{env:...}` placeholder). */
async function resolveServerSecrets(config: MCPServerConfig): Promise<MCPServerConfig> {
  if (!config.env && !config.headers) return config;
  const resolvers = mcpSecretResolvers();
  return {
    ...config,
    ...(config.env ? { env: await expandRecord(config.env, resolvers) } : {}),
    ...(config.headers ? { headers: await expandRecord(config.headers, resolvers) } : {}),
  };
}

/** Connect (or reconnect) one server. The Rust manager spawns the stdio child
 *  process or opens the Streamable-HTTP connection, then lists + caches tools.
 *  `env`/`headers` secret references are resolved first (see config-schema). */
export async function connectMcpServer(config: MCPServerConfig): Promise<McpServerStatus> {
  const resolved = await resolveServerSecrets(config);
  return invoke<McpServerStatus>("ai_mcp_connect", { config: resolved });
}

export function disconnectMcpServer(id: string): Promise<void> {
  return invoke<void>("ai_mcp_disconnect", { id });
}

export function listMcpServers(): Promise<McpServerStatus[]> {
  return invoke<McpServerStatus[]>("ai_mcp_list_servers");
}

/** Connect every enabled server, swallowing per-server failures so one bad
 *  server doesn't block the others. Returns the ids that connected. */
export async function connectEnabledServers(
  servers: MCPServerConfig[] | undefined,
): Promise<string[]> {
  const connected: string[] = [];
  for (const server of servers ?? []) {
    if (server.enabled === false) continue;
    try {
      await connectMcpServer(server);
      connected.push(server.id);
    } catch (e) {
      console.warn(`[mcp] connect failed for "${server.id}":`, e);
    }
  }
  return connected;
}
