// Desktop wrapper for reading/writing ai.json via IPC and merging it with the
// built-in provider catalog (DJA-11E). The config holds the provider catalog
// WITHOUT keys (keys live in the keychain — see ai-credentials.ts).

import * as m from "@markdraw/i18n";
import { invoke } from "./chaos-invoke.ts";
import type {
  AIConfig,
  MCPServerConfig,
  UserAIConfig,
} from "@markdraw/ai/config-schema.ts";
import {
  mergeConfigs,
  parseUserConfig,
  parseUserConfigForWrite,
} from "@markdraw/ai/config-schema.ts";
import { BUILTIN_PROVIDERS } from "@markdraw/ai/builtin-providers.ts";
import { readModelCache, saveFetchedModels } from "./model-cache.ts";

export { saveFetchedModels };

/** Load the effective config: builtins → localStorage cache → ai.json (manual).
 *  `previous` + `selected` keep a chosen model that a refresh dropped from the
 *  cache resolvable with its old definition. Tolerant on purpose: an unreadable
 *  ai.json must never stop the app from loading (the built-ins still work). */
export async function loadAIConfig(
  previous?: AIConfig,
  selected: string[] = [],
): Promise<AIConfig> {
  const raw = await invoke<string | null>("ai_read_config");
  const user = parseUserConfig(raw) ?? {};
  return mergeConfigs(BUILTIN_PROVIDERS, user, readModelCache(), { previous, selected });
}

/** Load the RAW user config (pre-merge) so callers can read-modify-write ai.json
 *  without clobbering sibling sections (e.g. updating `mcp` keeps `provider`). */
export async function loadUserAIConfig(): Promise<UserAIConfig> {
  const raw = await invoke<string | null>("ai_read_config");
  return parseUserConfig(raw) ?? {};
}

/** Raised by {@link loadUserAIConfigForWrite} when ai.json HAS content that is
 *  not a config we can merge. A read-modify-write built on `{}` would silently
 *  drop every sibling section (other providers, `mcp`, `small_model`), so the
 *  write paths refuse instead. `message` is the short user-facing i18n text. */
export class AIUserConfigInvalidError extends Error {
  constructor() {
    super(m.settings_ai_config_invalid());
    this.name = "AIUserConfigInvalidError";
  }
}

/** Read ai.json for a read-modify-WRITE. An absent file, or one with only
 *  whitespace, is an empty config (`{}`) and may be written. Content that fails
 *  to parse as JSON or does not match the schema throws
 *  {@link AIUserConfigInvalidError} BEFORE the caller mutates anything, so
 *  nothing is written over the user's file. Loading models keeps using the
 *  tolerant {@link loadAIConfig}.
 *
 *  The schema here is the write one: every `mcp` entry must survive, because a
 *  merge-based write built on a config whose entries were filtered would erase
 *  the entries the loader dropped (the lenient read stays for loading). */
export async function loadUserAIConfigForWrite(): Promise<UserAIConfig> {
  const raw = await invoke<string | null>("ai_read_config");
  if (raw === null) return {};
  const text = raw.trim();
  if (text === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new AIUserConfigInvalidError();
  }
  // `{}` is an empty config. Any OTHER JSON shape (an array, a string, a
  // number, `null`) is not a config we can merge: the valibot object schema
  // would accept an array as `{}` and the write would silently rewrite the
  // user's file, so a non-object is refused here too.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AIUserConfigInvalidError();
  }
  const user = parseUserConfigForWrite(text);
  if (user === null) throw new AIUserConfigInvalidError();
  return user;
}

/** Persist the raw user config JSON (the catalog, never keys). */
export async function saveAIConfig(json: string): Promise<void> {
  await invoke<void>("ai_write_config", { contents: json });
}

/** Tail of the in-process write chain: every {@link mutateUserAIConfig} waits
 *  for the previous one to settle, so two saves cannot interleave their read
 *  and write. */
let writeChain: Promise<unknown> = Promise.resolve();

function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** One change to the `mcp` list of ai.json, named by what it does to an id
 *  instead of by the list it produces. The list is computed from the config
 *  {@link mutateUserAIConfig} re-reads INSIDE the write queue (see
 *  {@link applyMcpServerChange}), so two changes queued while a keychain write
 *  is pending both land instead of the second overwriting the first. */
export type McpServerChange =
  /** Add the server, or edit it in place. Headers the edit does not re-supply
   *  are preserved from the entry already in the file. */
  | { kind: "upsert"; input: McpServerInput }
  | { kind: "remove"; id: string }
  | { kind: "setEnabled"; id: string; enabled: boolean };

/** A server as the settings UI submits it (the add/edit form). */
export interface McpServerInput {
  id: string;
  name?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface McpServerChangeResult {
  /** Config to write: `mcp` replaced, every sibling section preserved. */
  config: UserAIConfig;
  /** The server as it stands after the change (`undefined` when it is gone).
   *  The caller uses THIS to decide the connection effect, not the value it
   *  passed in. */
  server?: MCPServerConfig;
}

/** Apply one {@link McpServerChange} to `current.mcp`, the list as it is at the
 *  moment the queued write runs. Returns `null` when the change no longer
 *  applies — an id that the file no longer has (removed or hand-edited away in
 *  the meantime) — so nothing is written and the caller's connection effect is
 *  skipped. */
export function applyMcpServerChange(
  current: UserAIConfig,
  change: McpServerChange,
): McpServerChangeResult | null {
  const servers = current.mcp ?? [];
  switch (change.kind) {
    case "upsert": {
      const input = change.input;
      const idx = servers.findIndex((s) => s.id === input.id);
      // Cabeçalhos já gravados (um token, por exemplo) sobrevivem a uma edição
      // que não os reenvia — lidos do arquivo relido, não de um snapshot.
      const headers = input.headers ?? (idx >= 0 ? servers[idx].headers : undefined);
      // Editar não liga nem desliga: o estado vem do arquivo relido (um toggle
      // ainda na fila à frente desta edição vence o que o formulário viu). Só um
      // servidor novo usa o `enabled` do formulário.
      const enabled = idx >= 0 ? (servers[idx].enabled ?? true) : input.enabled;
      const server: MCPServerConfig = {
        id: input.id,
        transport: input.transport,
        enabled,
        ...(input.name ? { name: input.name } : {}),
        ...(input.command ? { command: input.command } : {}),
        ...(input.args && input.args.length ? { args: input.args } : {}),
        ...(input.url ? { url: input.url } : {}),
        ...(headers && Object.keys(headers).length ? { headers } : {}),
      };
      const next = [...servers];
      if (idx >= 0) next[idx] = server;
      else next.push(server);
      return { config: { ...current, mcp: next }, server };
    }
    case "remove": {
      const next = servers.filter((s) => s.id !== change.id);
      if (next.length === servers.length) return null;
      return { config: { ...current, mcp: next } };
    }
    case "setEnabled": {
      if (!servers.some((s) => s.id === change.id)) return null;
      // Todas as entradas com o id mudam: a conexão no início do app lê cada
      // entrada habilitada, então uma duplicata esquecida reconectaria.
      const next = servers.map((s) => (s.id === change.id ? { ...s, enabled: change.enabled } : s));
      const server = next.find((s) => s.id === change.id);
      return { config: { ...current, mcp: next }, server };
    }
  }
}

/** Side effects a write path runs between the guard and the merge — the keychain
 *  writes, which must only happen once the file is known to be writable. */
export interface AIConfigWriteOptions {
  afterValidate?: () => Promise<void> | void;
}

/** One serialized read-modify-write of ai.json, shared by every path that
 *  reads, changes and saves the file (provider selection, custom provider,
 *  provider removal, MCP list):
 *
 *   1. read + validate for writing ({@link loadUserAIConfigForWrite}); an
 *      unreadable file throws {@link AIUserConfigInvalidError} and nothing runs;
 *   2. `afterValidate` (keychain etc.);
 *   3. READ THE FILE AGAIN — an edit made while step 2 was pending (another
 *      save, a hand edit) is the base of the merge, not the pre-await snapshot;
 *   4. `mutate` returns the config to write, or `null` for "nothing to change".
 *
 *  Writes are serialized in-process, so two of these never interleave. The
 *  window this cannot close: an edit landing between the second read and the
 *  write (a hand edit, or a save from another process) is still overwritten —
 *  the app has no lock on the user's file. Returns whether anything was
 *  written. */
export async function mutateUserAIConfig(
  mutate: (current: UserAIConfig) => UserAIConfig | null,
  options: AIConfigWriteOptions = {},
): Promise<boolean> {
  return serializeWrite(async () => {
    await loadUserAIConfigForWrite();
    if (options.afterValidate) await options.afterValidate();
    const current = await loadUserAIConfigForWrite();
    const next = mutate(current);
    if (next === null) return false;
    await saveAIConfig(JSON.stringify(next));
    return true;
  });
}
