// Desktop wrapper for reading/writing ai.json via IPC and merging it with the
// built-in provider catalog (DJA-11E). The config holds the provider catalog
// WITHOUT keys (keys live in the keychain — see ai-credentials.ts).

import { invoke } from "./chaos-invoke.ts";
import type { AIConfig, UserAIConfig } from "@markdraw/ai/config-schema.ts";
import { mergeConfigs, parseUserConfig } from "@markdraw/ai/config-schema.ts";
import { BUILTIN_PROVIDERS } from "@markdraw/ai/builtin-providers.ts";
import { readModelCache, saveFetchedModels } from "./model-cache.ts";

export { saveFetchedModels };

/** Load the effective config: builtins → localStorage cache → ai.json (manual).
 *  `previous` + `selected` keep a chosen model that a refresh dropped from the
 *  cache resolvable with its old definition. */
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

/** Persist the raw user config JSON (the catalog, never keys). */
export async function saveAIConfig(json: string): Promise<void> {
  await invoke<void>("ai_write_config", { contents: json });
}
