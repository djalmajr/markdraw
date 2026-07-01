// Bridge + logic for MCP servers that OTHER agent tools (Claude Code, Codex,
// OpenCode) already configure. Rust (`mcp_discover`) reads + normalizes the raw
// configs; this module decides WHICH tools to read (gated on a connected
// Markdraw provider), dedupes across tools/scopes, and gates project-scoped
// servers behind explicit approval (remembered per root + config hash, TOFU).

import { invoke } from "./chaos-invoke.ts";
import type { MCPServerConfig } from "@markdraw/ai/config-schema.ts";
import { djb2 } from "@markdraw/core/hash.ts";

/** One server as normalized by the Rust `mcp_discover` command. */
export interface DiscoveredMcpServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  tool: "claude" | "codex" | "opencode";
  scope: "global" | "project";
  root?: string;
  sourcePath: string;
}

/** A deduped server ready to surface/connect, with every place it was found. */
export interface DiscoveredEntry {
  /** Stable connection id (`discovered:<hash>`), derived from the identity. */
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** "global" if found in ANY tool's global config (auto-connect); else
   *  "project" (needs approval before it spawns). */
  scope: "global" | "project";
  /** The project root, for a project-only server (approval is keyed on it). */
  root?: string;
  sources: Array<{ tool: string; scope: string; path: string }>;
  /** SHA-256 of the executable + secret surface — the TOFU approval key. Filled
   *  by {@link withConfigHashes}; "" until then. */
  configHash: string;
}

/** Read + normalize the requested tools' MCP configs (global + per root). */
export function discoverMcpServers(
  roots: string[],
  tools: string[],
): Promise<DiscoveredMcpServer[]> {
  if (tools.length === 0) return Promise.resolve([]);
  return invoke<DiscoveredMcpServer[]>("mcp_discover", { roots, tools });
}

/** The connection target — what makes two configs "the same server" for dedup.
 *  Deliberately excludes env/headers: the same command/url is one server even if
 *  two tools pass different env (TOFU still tracks env via the config hash). */
export function serverIdentity(s: {
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
}): string {
  return s.transport === "http"
    ? `http:${s.url ?? ""}`
    : `stdio:${s.command ?? ""} ${(s.args ?? []).join(" ")}`;
}

/** Which tools may be read, gated on a CONNECTED provider of the matching kind
 *  (OpenCode has no first-class provider, so it rides a dedicated toggle). */
export function discoveryToolsFor(opts: {
  connected: Record<string, boolean>;
  providerKinds: Record<string, string>;
  importOpenCode: boolean;
}): string[] {
  const tools: string[] = [];
  const anyConnected = (kinds: string[]): boolean =>
    Object.entries(opts.providerKinds).some(
      ([id, kind]) => opts.connected[id] && kinds.includes(kind),
    );
  if (anyConnected(["claude-cli", "anthropic"])) tools.push("claude");
  if (anyConnected(["codex-cli"])) tools.push("codex");
  if (opts.importOpenCode) tools.push("opencode");
  return tools;
}

/** Collapse servers found under multiple tools/scopes into one entry each,
 *  dropping any whose identity already appears as an explicit ai.json server
 *  (`existingIdentities`). A server seen globally anywhere is "global" — the
 *  user already trusts it outside this project, so it auto-connects. */
export function dedupeDiscovered(
  servers: DiscoveredMcpServer[],
  existingIdentities: Set<string>,
): DiscoveredEntry[] {
  const byIdentity = new Map<string, DiscoveredEntry>();
  for (const s of servers) {
    const identity = serverIdentity(s);
    if (existingIdentities.has(identity)) continue;
    const existing = byIdentity.get(identity);
    if (existing) {
      existing.sources.push({ tool: s.tool, scope: s.scope, path: s.sourcePath });
      if (s.scope === "global") existing.scope = "global";
      if (s.scope === "project" && !existing.root) existing.root = s.root;
      continue;
    }
    byIdentity.set(identity, {
      id: `discovered:${djb2(identity)}`,
      name: s.name,
      transport: s.transport,
      command: s.command,
      args: s.args,
      env: s.env,
      url: s.url,
      headers: s.headers,
      scope: s.scope,
      root: s.scope === "project" ? s.root : undefined,
      sources: [{ tool: s.tool, scope: s.scope, path: s.sourcePath }],
      configHash: "",
    });
  }
  return [...byIdentity.values()];
}

/** SHA-256 (first 16 hex) of the executable + secret surface — the part whose
 *  change must re-trigger approval (a project flipping its command to something
 *  malicious). */
export async function configHashOf(e: DiscoveredEntry): Promise<string> {
  const canon = JSON.stringify({
    t: e.transport,
    c: e.command ?? null,
    a: e.args ?? null,
    e: e.env ?? null,
    u: e.url ?? null,
    h: e.headers ?? null,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** Fill each entry's `configHash` (mutates + returns the same array). */
export async function withConfigHashes(entries: DiscoveredEntry[]): Promise<DiscoveredEntry[]> {
  await Promise.all(
    entries.map(async (e) => {
      e.configHash = await configHashOf(e);
    }),
  );
  return entries;
}

/** Build the MCPServerConfig used to connect a discovered entry. Env/header
 *  `{env:VAR}` refs are resolved in memory at connect time by the existing
 *  secret resolver — never persisted. */
export function toMcpServerConfig(e: DiscoveredEntry): MCPServerConfig {
  return {
    id: e.id,
    name: e.name,
    transport: e.transport,
    enabled: true,
    ...(e.command ? { command: e.command } : {}),
    ...(e.args && e.args.length ? { args: e.args } : {}),
    ...(e.env ? { env: e.env } : {}),
    ...(e.url ? { url: e.url } : {}),
    ...(e.headers ? { headers: e.headers } : {}),
  };
}

// ── Trust store (localStorage): per-machine approvals + the OpenCode toggle ──

const APPROVALS_KEY = "markdraw-mcp-approvals";
const IMPORT_OPENCODE_KEY = "markdraw-import-opencode-mcps";

function loadApprovals(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(APPROVALS_KEY) ?? "{}") as Record<string, true>;
  } catch {
    return {};
  }
}

const approvalKey = (root: string, configHash: string): string => `${root} ${configHash}`;

/** Whether a project-scoped server (at this root + exact config) was approved.
 *  A changed config → new hash → not approved → re-prompt (TOFU). */
export function isApproved(root: string, configHash: string): boolean {
  return loadApprovals()[approvalKey(root, configHash)] === true;
}

export function approveDiscovered(root: string, configHash: string): void {
  const approvals = loadApprovals();
  approvals[approvalKey(root, configHash)] = true;
  localStorage.setItem(APPROVALS_KEY, JSON.stringify(approvals));
}

export function getImportOpenCodeMcps(): boolean {
  return localStorage.getItem(IMPORT_OPENCODE_KEY) === "true";
}

export function setImportOpenCodeMcps(on: boolean): void {
  localStorage.setItem(IMPORT_OPENCODE_KEY, String(on));
}
