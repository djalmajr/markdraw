// Engine abstraction — the swappable implementation behind the AIProvider
// contract. The contract (types.ts) is identical regardless of engine; an
// engine only decides *how* the bytes reach the provider's API.
//
// Two engines are planned and interchangeable (the user can switch without any
// UI change):
//   - "ai-sdk"   → Vercel AI SDK (streamText) running in the webview. Maps a
//                  provider `kind` to "@ai-sdk/anthropic" | "@ai-sdk/openai" |
//                  "@ai-sdk/openai-compatible".
//   - "tanstack" → TanStack AI core (chat()) via a custom in-process transport
//                  (no server). Maps `kind` to the matching "@tanstack/ai-*".
//
// Concrete engines live in engines/ and are loaded lazily by adapter.ts.

import type { ReasoningLabel } from "./reasoning.ts";
import type { ResolvedModel } from "./resolve-model.ts";
import type { AIMessage, AIProvider } from "./types.ts";

export type AIEngineId =
  | "ai-sdk"
  | "tanstack"
  | "claude-cli"
  | "codex-cli"
  | "grok-cli"
  | "antigravity-cli";

/** Resolves the provider's API key just-in-time. Called inside `chat()` right
 *  before the request so the key is never held longer than necessary (it lives
 *  in the OS keychain; see resolve-credential.ts). Returns undefined when no
 *  credential is configured. */
export type CredentialResolver = () => Promise<string | undefined>;

/** A `fetch`-compatible implementation. On desktop the host injects the
 *  Tauri HTTP plugin's fetch (buffered) or the Rust SSE shim (streaming) so
 *  requests go through Rust and avoid the webview CORS wall; tests/extension
 *  use the global fetch. Structural on purpose: Node's `typeof fetch` carries
 *  extras like `preconnect` that no injected implementation provides and the
 *  AI SDK never calls. */
export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CliStreamEvent =
  | { type: "line"; line: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** Host-injected IPC for CLI subscription engines (desktop → cli_agent.rs). */
export interface CliHost {
  streamChat: (
    request: {
      provider: "claude-cli" | "codex-cli" | "grok-cli" | "antigravity-cli";
      model: string;
      system?: string;
      messages: AIMessage[];
      pathOverride?: string;
    },
    onEvent: (event: CliStreamEvent) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export interface AIEngineOptions {
  /** Custom fetch (e.g. Tauri HTTP plugin) to dodge webview CORS. */
  fetch?: FetchImpl;
  /** Desktop injects this for the CLI subscription engines (claude/codex/grok/agy). */
  cliHost?: CliHost;
  cliPathOverride?: string;
  /** Ask the model to spend reasoning/thinking effort, as an OpenCode-style
   *  label (see reasoning.ts). Omit or `"default"` = unchanged (the model's own
   *  default). Each engine maps it onto the provider family's native option
   *  (see engines/ai-sdk.ts: anthropic → `thinking` budget/toggle, openai →
   *  `reasoningEffort`, openai-compatible → `reasoning_effort` passthrough)
   *  and silently ignores it where the SDK has no matching option. */
  reasoningEffort?: ReasoningLabel;
  /** Use `streamText` (real incremental deltas) instead of the buffered
   *  `generateText` + fake-typing path. Default false: whether the injected
   *  fetch surfaces SSE incrementally in the WKWebView is unverified (the A0
   *  spike), so streaming stays opt-in and the buffered path is the safe
   *  default + kill-switch. */
  streaming?: boolean;
}

/** Builds a concrete `AIProvider` for a resolved model. The implementation
 *  reads `resolved.provider.kind` to pick the right SDK family and uses
 *  `resolved.provider.options` (baseURL/headers) + the resolved credential. */
export interface AIEngine {
  readonly id: AIEngineId;
  createProvider(
    resolved: ResolvedModel,
    getApiKey: CredentialResolver,
    opts?: AIEngineOptions,
  ): AIProvider;
}
