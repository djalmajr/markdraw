// CLI subscription engine — Claude Code / Codex via Rust-spawned local binaries.
// Parses JSONL stdout into AIStreamPart deltas; no API key or AI SDK involved.

import type {
  AIEngine,
  AIEngineOptions,
  CliHost,
  CliStreamEvent,
  CredentialResolver,
} from "../engine.ts";
import type { CliProviderKind } from "../cli-providers.ts";
import type { ResolvedModel } from "../resolve-model.ts";
import type {
  AIMessage,
  AIProvider,
  AIStreamPart,
  ChatOptions,
  CompleteOptions,
} from "../types.ts";
import { NotSupportedError } from "../types.ts";

function extractClaudeText(obj: Record<string, unknown>): string | null {
  if (obj.type === "stream_event") {
    const event = obj.event as Record<string, unknown> | undefined;
    if (event?.type === "content_block_delta") {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        return delta.text;
      }
    }
    return null;
  }
  if (obj.type === "assistant") {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return null;
    const text = content
      .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");
    return text || null;
  }
  return null;
}

function extractCodexText(obj: Record<string, unknown>): string | null {
  if (obj.type !== "item.completed") return null;
  const item = obj.item as Record<string, unknown> | undefined;
  if (item?.type === "agent_message" && typeof item.text === "string") {
    return item.text;
  }
  return null;
}

function extractUsage(
  kind: CliProviderKind,
  obj: Record<string, unknown>,
): { inputTokens?: number; outputTokens?: number } | null {
  if (kind === "claude-cli" && obj.type === "result") {
    const usage = obj.usage as Record<string, unknown> | undefined;
    if (!usage) return null;
    return {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
    };
  }
  if (kind === "codex-cli" && obj.type === "turn.completed") {
    const usage = obj.usage as Record<string, unknown> | undefined;
    if (!usage) return null;
    return {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
    };
  }
  return null;
}

function createCliProvider(
  kind: CliProviderKind,
  resolved: ResolvedModel,
  opts?: AIEngineOptions,
): AIProvider {
  if (!opts?.cliHost) {
    throw new Error("CLI host not configured — desktop must inject cliHost");
  }
  const host = opts.cliHost;

  async function* chat(
    messages: AIMessage[],
    chatOpts?: ChatOptions,
  ): AsyncIterable<AIStreamPart> {
    const signal = chatOpts?.signal;
    let emittedLen = 0;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    const queue: AIStreamPart[] = [];
    let done = false;
    let failed: AIStreamPart | null = null;
    let resolveWait: (() => void) | null = null;

    const wake = () => {
      resolveWait?.();
      resolveWait = null;
    };

    const onEvent = (event: CliStreamEvent) => {
      if (event.type === "line") {
        try {
          const obj = JSON.parse(event.line) as Record<string, unknown>;
          const text =
            kind === "claude-cli" ? extractClaudeText(obj) : extractCodexText(obj);
          if (text) {
            if (kind === "codex-cli") {
              queue.push({ type: "text-delta", text });
            } else {
              const delta = text.slice(emittedLen);
              emittedLen = text.length;
              if (delta) queue.push({ type: "text-delta", text: delta });
            }
          }
          const u = extractUsage(kind, obj);
          if (u) usage = u;
        } catch {
          // ignore non-JSON lines (hooks, stderr leakage)
        }
      } else if (event.type === "error") {
        failed = { type: "error", code: "unknown", message: event.message };
        done = true;
      } else if (event.type === "done") {
        done = true;
      }
      wake();
    };

    const run = host.streamChat(
      {
        provider: kind,
        model: resolved.modelId,
        system: chatOpts?.system,
        messages,
        pathOverride: opts?.cliPathOverride,
      },
      onEvent,
      signal,
    );

    run.catch((e: unknown) => {
      failed = {
        type: "error",
        code: signal?.aborted ? "aborted" : "unknown",
        message: e instanceof Error ? e.message : String(e),
      };
      done = true;
      wake();
    });

    while (!done || queue.length > 0) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (done) break;
      await new Promise<void>((r) => {
        resolveWait = r;
      });
    }

    if (failed) {
      yield failed;
      return;
    }
    if (usage) {
      yield {
        type: "usage",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      };
    }
    yield {
      type: "done",
      usage:
        usage?.inputTokens != null && usage?.outputTokens != null
          ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
          : undefined,
    };
  }

  async function complete(prompt: string, completeOpts?: CompleteOptions): Promise<string> {
    let text = "";
    for await (const part of chat([{ role: "user", content: prompt }], {
      system: completeOpts?.system,
      signal: completeOpts?.signal,
    })) {
      if (part.type === "text-delta") text += part.text;
      if (part.type === "error") throw new Error(part.message);
    }
    return text;
  }

  async function embed(): Promise<number[][]> {
    throw new NotSupportedError("embed");
  }

  return { chat, complete, embed };
}

export const claudeCliEngine: AIEngine = {
  id: "claude-cli",
  createProvider(resolved, _getApiKey: CredentialResolver, opts?: AIEngineOptions) {
    return createCliProvider("claude-cli", resolved, opts);
  },
};

export const codexCliEngine: AIEngine = {
  id: "codex-cli",
  createProvider(resolved, _getApiKey: CredentialResolver, opts?: AIEngineOptions) {
    return createCliProvider("codex-cli", resolved, opts);
  },
};

export type { CliHost, CliStreamEvent };