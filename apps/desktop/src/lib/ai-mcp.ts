// Desktop bridge to the Rust MCP manager (src-tauri/src/ai_mcp.rs). Wraps the
// Tauri commands so the engine-neutral packages/ai and the settings UI can talk
// to MCP servers without importing Tauri directly.

import { invoke } from "./chaos-invoke.ts";
import { getApiKey } from "./ai-credentials.ts";
import { createReconnectBreaker } from "./reconnect-breaker.ts";
import type { MCPBridge, MCPToolDescriptor } from "@markdraw/ai/mcp-tools.ts";
import type { MCPServerConfig } from "@markdraw/ai/config-schema.ts";
import { expandRecord, type HostResolvers } from "@markdraw/ai/resolve-credential.ts";

export interface McpServerStatus {
  id: string;
  connected: boolean;
  promptCount?: number;
  resourceCount?: number;
  toolCount: number;
  /** OAuth-gated HTTP server with no usable stored tokens — the UI offers an
   *  "Authorize" action wired to {@link authorizeMcpServer}. */
  requiresAuth?: boolean;
}

export interface McpPromptArgumentInfo {
  description?: string;
  name: string;
  required?: boolean;
  title?: string;
}

export interface McpPromptContent {
  description?: string;
  name: string;
  server: string;
  text: string;
}

export interface McpPromptInfo {
  arguments?: McpPromptArgumentInfo[];
  description?: string;
  name: string;
  server: string;
  title?: string;
}

export interface McpResourceContent {
  mimeType?: string;
  server: string;
  text: string;
  uri: string;
}

export interface McpResourceInfo {
  description?: string;
  mimeType?: string;
  name: string;
  server: string;
  size?: number;
  title?: string;
  uri: string;
}

/** Last-known config per server id — what auto-reconnect replays. Captured on
 *  every (re)connect, so secrets are the already-resolved values. */
const knownConfigs = new Map<string, MCPServerConfig>();

/** Reconnects are capped (5 per 30s sliding window, exponential backoff): a
 *  crash-looping stdio server must not become a spawn loop (the omp project's
 *  issue #1592). */
const reconnectBreaker = createReconnectBreaker();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One reconnect-and-retry pass for a call that failed with "not connected".
 *  Returns null when the breaker is open or no config is known (caller
 *  rethrows the original error). */
async function tryReconnect(server: string): Promise<boolean> {
  const config = knownConfigs.get(server);
  if (!config) return false;
  const delay = reconnectBreaker.nextDelay(server);
  if (delay === null) return false;
  await sleep(delay);
  try {
    await invoke<McpServerStatus>("ai_mcp_connect", { config });
    reconnectBreaker.reset(server);
    return true;
  } catch {
    return false;
  }
}

function isNotConnectedError(e: unknown): boolean {
  return /not connected/i.test(e instanceof Error ? e.message : String(e));
}

/** Invoke one MCP tool, threading the run's abort signal: a `callId` lets Rust
 *  cancel the in-flight call when the user stops the turn. A call that fails
 *  because the server dropped gets ONE reconnect-and-retry pass, guarded by
 *  the circuit breaker. */
async function callMcpTool(
  server: string,
  name: string,
  args: unknown,
  opts?: { signal?: AbortSignal },
): Promise<unknown> {
  try {
    return await callMcpToolOnce(server, name, args, opts);
  } catch (e) {
    if (!isNotConnectedError(e) || opts?.signal?.aborted) throw e;
    if (!(await tryReconnect(server))) throw e;
    return callMcpToolOnce(server, name, args, opts);
  }
}

async function callMcpToolOnce(
  server: string,
  name: string,
  args: unknown,
  opts?: { signal?: AbortSignal },
): Promise<unknown> {
  const signal = opts?.signal;
  if (!signal) return invoke<unknown>("ai_mcp_call_tool", { server, name, args });
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const callId = crypto.randomUUID();
  const onAbort = () => {
    void invoke("ai_mcp_cancel_call", { callId }).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await invoke<unknown>("ai_mcp_call_tool", { server, name, args, callId });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** The bridge the chat engine uses to discover + invoke MCP tools. */
export function createMcpBridge(): MCPBridge {
  return {
    listTools: () => invoke<MCPToolDescriptor[]>("ai_mcp_list_tools"),
    callTool: (server, name, args, opts) => callMcpTool(server, name, args, opts),
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
  // Remember the resolved config so a dropped server can be transparently
  // reconnected by the tool-call retry path (breaker-guarded).
  knownConfigs.set(config.id, resolved);
  const status = await invoke<McpServerStatus>("ai_mcp_connect", { config: resolved });
  reconnectBreaker.reset(config.id);
  return status;
}

/** Run the interactive OAuth flow for an OAuth-gated HTTP server: Rust opens the
 *  browser, captures the loopback redirect, stores the tokens, then reconnects.
 *  Resolves to the post-auth status (connected, with its tools). */
export async function authorizeMcpServer(config: MCPServerConfig): Promise<McpServerStatus> {
  const resolved = await resolveServerSecrets(config);
  knownConfigs.set(config.id, resolved);
  const status = await invoke<McpServerStatus>("ai_mcp_authorize", { config: resolved });
  reconnectBreaker.reset(config.id);
  return status;
}

export function disconnectMcpServer(id: string): Promise<void> {
  // Deliberate disconnects (toggle off / remove) must not auto-reconnect.
  knownConfigs.delete(id);
  return invoke<void>("ai_mcp_disconnect", { id });
}

export function listMcpServers(): Promise<McpServerStatus[]> {
  return invoke<McpServerStatus[]>("ai_mcp_list_servers");
}

export function listMcpResources(): Promise<McpResourceInfo[]> {
  return invoke<McpResourceInfo[]>("ai_mcp_list_resources");
}

export function readMcpResource(server: string, uri: string): Promise<McpResourceContent> {
  return invoke<McpResourceContent>("ai_mcp_read_resource", { server, uri });
}

export function listMcpPrompts(): Promise<McpPromptInfo[]> {
  return invoke<McpPromptInfo[]>("ai_mcp_list_prompts");
}

export function getMcpPrompt(
  server: string,
  name: string,
  argumentsValue: Record<string, unknown> = {},
): Promise<McpPromptContent> {
  return invoke<McpPromptContent>("ai_mcp_get_prompt", {
    server,
    name,
    arguments: argumentsValue,
  });
}

/** Connect every enabled server in parallel (Promise.allSettled — a slow or
 *  bad server must not block the others). Each entry still resolves its
 *  secrets and connects independently; per-server failures are logged and
 *  swallowed. Returns the ids that connected, in input order. */
export async function connectEnabledServers(
  servers: MCPServerConfig[] | undefined,
): Promise<string[]> {
  const enabled = (servers ?? []).filter((server) => server.enabled !== false);
  const results = await Promise.allSettled(
    enabled.map((server) => connectMcpServer(server)),
  );
  const connected: string[] = [];
  results.forEach((result, index) => {
    const server = enabled[index];
    if (!server) return;
    if (result.status === "fulfilled") connected.push(server.id);
    else console.warn(`[mcp] connect failed for "${server.id}":`, result.reason);
  });
  return connected;
}
