// CLI subscription providers — Claude Code / Codex / Grok use the official local
// CLI binaries (OAuth in ~/.claude / ~/.codex / ~/.grok), not API keys in the
// keychain. Spawning happens in Rust (webview can't); the engines parse JSONL.

import type { ProviderKind } from "./config-schema.ts";

export const CLAUDE_SUB_PROVIDER_ID = "claude-sub";
export const CODEX_SUB_PROVIDER_ID = "codex-sub";
export const GROK_SUB_PROVIDER_ID = "grok-sub";

export const CLI_SUBSCRIPTION_PROVIDER_IDS = new Set([
  CLAUDE_SUB_PROVIDER_ID,
  CODEX_SUB_PROVIDER_ID,
  GROK_SUB_PROVIDER_ID,
]);

export type CliProviderKind = "claude-cli" | "codex-cli" | "grok-cli";

export function isCliProviderKind(kind: ProviderKind): kind is CliProviderKind {
  return kind === "claude-cli" || kind === "codex-cli" || kind === "grok-cli";
}

export function isCliSubscriptionProviderId(id: string): boolean {
  return CLI_SUBSCRIPTION_PROVIDER_IDS.has(id);
}

/** Engine id for a provider `kind` — CLI kinds bypass the user's ai-sdk/tanstack pref. */
export function resolveEngineIdForKind(kind: ProviderKind): "ai-sdk" | "tanstack" | CliProviderKind {
  if (kind === "claude-cli") return "claude-cli";
  if (kind === "codex-cli") return "codex-cli";
  if (kind === "grok-cli") return "grok-cli";
  return "ai-sdk";
}

/** Default CLI binary name per provider kind. */
export function cliBinaryName(kind: CliProviderKind): string {
  if (kind === "codex-cli") return "codex";
  if (kind === "grok-cli") return "grok";
  return "claude";
}