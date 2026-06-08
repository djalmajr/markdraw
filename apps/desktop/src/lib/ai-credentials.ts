// Desktop wrapper over the keychain IPC commands (DJA-11E). API keys live only
// in the OS secure store — this module is the only path the frontend uses to
// read/write them, and it never persists a key anywhere else.
//
// Session cache: the provider is rebuilt per send, so a naive `getApiKey` hit
// the OS keychain on EVERY message — and on macOS an unsigned/rebuilt dev
// binary re-prompts for permission each time (terrible UX). We cache the
// resolved value in module memory (process-lifetime only, never written to
// disk) so the keychain is touched at most once per provider per launch. The
// cache is invalidated on set/delete so Settings changes take effect at once.

import { invoke } from "./chaos-invoke.ts";

const keyCache = new Map<string, string | null>();

export async function setApiKey(providerId: string, key: string): Promise<void> {
  await invoke<void>("ai_set_api_key", { providerId, key });
  keyCache.set(providerId, key);
}

export async function getApiKey(providerId: string): Promise<string | null> {
  const cached = keyCache.get(providerId);
  if (cached !== undefined) return cached;
  const key = (await invoke<string | null>("ai_get_api_key", { providerId })) ?? null;
  keyCache.set(providerId, key);
  return key;
}

export async function deleteApiKey(providerId: string): Promise<void> {
  await invoke<void>("ai_delete_api_key", { providerId });
  keyCache.delete(providerId);
}

/** Whether a key is stored for the provider (drives the Settings "Saved"/"Not
 *  set" badge) — without returning the secret itself. */
export async function hasApiKey(providerId: string): Promise<boolean> {
  return (await getApiKey(providerId)) !== null;
}
