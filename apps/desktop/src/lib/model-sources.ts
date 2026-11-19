// Tauri IPC bridge for the model-list sources the webview can't reach itself
// (model_list.rs): a bounded GET JSON for any base URL, `grok models` /
// `agy models`, and the Codex CLI's models cache. These only transport raw or
// minimal data; each list format is parsed by the caller.

import { invoke } from "./chaos-invoke.ts";

/**
 * Stable error codes the Rust side emits (fixed strings, never secrets).
 * `busy` = the command's global concurrency budget is full (retry later);
 * `invalid_request` = the payload was not the expected shape.
 */
export type ModelSourceErrorCode =
  | "invalid_url"
  | "unsupported_scheme"
  | "blocked_host"
  | "invalid_header"
  | "invalid_request"
  | "busy"
  | "connect_failed"
  | "redirect_blocked"
  | "request_failed"
  | "timeout"
  | "too_large"
  | "unknown_provider"
  | "cli_not_found"
  | "cli_spawn_failed"
  | "cli_failed"
  | "not_found"
  | "read_failed"
  | "malformed"
  | "no_home"
  | "unknown";

/** A model-source failure: a short code plus a fixed, secret-free message. */
export class ModelSourceError extends Error {
  readonly code: ModelSourceErrorCode;
  constructor(code: ModelSourceErrorCode, message: string) {
    super(message);
    this.name = "ModelSourceError";
    this.code = code;
  }
}

function toModelSourceError(e: unknown): ModelSourceError {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    const { code, message } = e as { code: unknown; message: unknown };
    if (typeof code === "string" && typeof message === "string") {
      return new ModelSourceError(code as ModelSourceErrorCode, message);
    }
  }
  // Anything else (a string from a framework rejection, a chaos-injected
  // failure) is replaced by a fixed message, so nothing unexpected is echoed.
  return new ModelSourceError("unknown", "The model list request failed.");
}

/** Run an `invoke` and re-throw any rejection as a {@link ModelSourceError}. */
async function typed<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw toModelSourceError(e);
  }
}

export interface HttpGetJsonResult {
  status: number;
  body: string;
}

/**
 * GET `url` through Rust. Only http(s); a redirect to another origin, a
 * response over 4 MiB or one slower than `timeoutMs` (default 15 s, max 60 s)
 * rejects with a {@link ModelSourceError}. A non-2xx status is returned, not
 * thrown.
 */
export function httpGetJson(
  url: string,
  headers?: Record<string, string>,
  timeoutMs?: number,
): Promise<HttpGetJsonResult> {
  return typed(() =>
    invoke<HttpGetJsonResult>("ai_http_get_json", {
      request: { url, headers, timeoutMs },
    }),
  );
}

/** The CLI-backed subscription providers whose `models` output can be listed. */
export type CliModelsProviderId = "grok-sub" | "antigravity-sub";

/** Raw stdout of `grok models` / `agy models` (size-bounded, stderr dropped). */
export function listCliModels(provider: CliModelsProviderId): Promise<string> {
  return typed(() => invoke<string>("cli_list_models", { provider }));
}

export interface CodexCachedModel {
  slug: string;
  displayName: string | null;
  contextWindow: number | null;
  visibility: string | null;
  defaultReasoningLevel: string | null;
  reasoningEfforts: string[];
}

/** Model fields of `~/.codex/models_cache.json` (never `auth.json`). */
export function codexModelsCache(): Promise<CodexCachedModel[]> {
  return typed(() => invoke<CodexCachedModel[]>("codex_models_cache", {}));
}
