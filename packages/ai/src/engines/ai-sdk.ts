// Vercel AI SDK engine (DJA-11F). Maps the AIProvider contract onto the AI SDK
// `streamText`, lazily importing the SDK + the per-`kind` adapter so nothing is
// bundled until this engine is actually used. Runs in the webview; the API key
// is resolved just-in-time via `getApiKey` and never held longer than a request.
//
// CORS: WKWebView blocks direct cross-origin fetches to provider APIs, so the
// host injects a `fetch` that routes through Rust (Tauri HTTP plugin).
//
// Errors: `streamText` does NOT throw on the `textStream` — failures surface on
// the full event `stream` as `{type:"error"}`. We iterate that stream so auth /
// network / rate-limit errors reach the UI instead of a silent empty reply.

import type { EmbeddingModel, LanguageModel } from "ai";
import { withApproval } from "../approval-policy.ts";
import { compactMessages } from "../compaction.ts";
import type { AIEngine, AIEngineOptions, CredentialResolver } from "../engine.ts";
import type { ResolvedModel } from "../resolve-model.ts";
import type {
  AIErrorCode,
  AIMessage,
  AIProvider,
  AIStreamPart,
  ChatOptions,
  CompleteOptions,
} from "../types.ts";
import { NotSupportedError } from "../types.ts";

/**
 * Context compaction threshold, in MESSAGES. Before each provider call the
 * history is capped at this many messages, dropping the oldest at a
 * `safeCutIndex` boundary (leading system messages are always kept).
 *
 * Why a message count and not a char/token budget: the engine receives plain
 * `AIMessage[]` turns (one string per user/assistant turn, built by the chat
 * store), so a count is cheap, deterministic and model-agnostic — a real token
 * budget would need a per-model tokenizer this package deliberately avoids.
 * 200 messages ≈ 100 turns, generous enough that compaction only kicks in on
 * truly long sessions. The SDK's `pruneMessages` was evaluated and does not
 * fit: it prunes message CONTENT by kind (reasoning / tool parts), not the
 * oldest N turns (see compaction.ts).
 */
export const MAX_CONTEXT_MESSAGES = 200;

async function buildModel(
  resolved: ResolvedModel,
  apiKey: string | undefined,
  fetchImpl: AIEngineOptions["fetch"],
): Promise<LanguageModel> {
  const { modelId, providerId, provider } = resolved;
  const baseURL = provider.options?.baseURL;
  const headers = provider.options?.headers;
  // The AI SDK's FetchFunction is structurally the global fetch; the Tauri HTTP
  // plugin fetch is compatible at runtime.
  const fetch = fetchImpl as Parameters<typeof import("@ai-sdk/openai-compatible").createOpenAICompatible>[0]["fetch"];
  const fetchOpt = fetchImpl ? { fetch } : {};

  switch (provider.kind) {
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({
        apiKey,
        ...(baseURL ? { baseURL } : {}),
        ...fetchOpt,
        // Required for direct browser/webview calls to the Anthropic API.
        headers: {
          "anthropic-dangerous-direct-browser-access": "true",
          ...(headers ?? {}),
        },
      })(modelId);
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({
        apiKey,
        ...(baseURL ? { baseURL } : {}),
        ...(headers ? { headers } : {}),
        ...fetchOpt,
      })(modelId);
    }
    case "openai-compatible": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      return createOpenAICompatible({
        name: providerId,
        baseURL: baseURL ?? "",
        ...(apiKey ? { apiKey } : {}),
        ...(headers ? { headers } : {}),
        ...fetchOpt,
      })(modelId);
    }
    default:
      throw new Error(`ai-sdk engine does not support provider kind: ${provider.kind}`);
  }
}

/** Build a text-embedding model for the "Full" workspace index. Only OpenAI and
 *  OpenAI-compatible providers expose embeddings; Anthropic (and the CLI kinds,
 *  which never reach this engine) have no embeddings API — they throw
 *  NotSupportedError so the indexer degrades to keyword-only. Same lazy-import +
 *  injected-fetch (CORS) pattern as buildModel. */
async function buildEmbeddingModel(
  resolved: ResolvedModel,
  apiKey: string | undefined,
  fetchImpl: AIEngineOptions["fetch"],
): Promise<EmbeddingModel> {
  const { modelId, providerId, provider } = resolved;
  const baseURL = provider.options?.baseURL;
  const headers = provider.options?.headers;
  const fetch = fetchImpl as Parameters<typeof import("@ai-sdk/openai-compatible").createOpenAICompatible>[0]["fetch"];
  const fetchOpt = fetchImpl ? { fetch } : {};

  switch (provider.kind) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({
        apiKey,
        ...(baseURL ? { baseURL } : {}),
        ...(headers ? { headers } : {}),
        ...fetchOpt,
      }).embeddingModel(modelId);
    }
    case "openai-compatible": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      return createOpenAICompatible({
        name: providerId,
        baseURL: baseURL ?? "",
        ...(apiKey ? { apiKey } : {}),
        ...(headers ? { headers } : {}),
        ...fetchOpt,
      }).embeddingModel(modelId);
    }
    default:
      throw new NotSupportedError("embed");
  }
}

/** `providerOptions` as the AI SDK call settings accept it (the `ai` package
 *  does not re-export the type, so it is derived the same way FetchFunction is
 *  above). Resolves to `Record<string, JSONObject>` (SharedV3ProviderOptions). */
type ProviderOptions = NonNullable<
  Parameters<typeof import("ai").generateText>[0]["providerOptions"]
>;

/** Anthropic has no enum effort — extended thinking takes an explicit token
 *  budget (API minimum 1024). These map each effort label onto a budget. "max"
 *  stays under a 64k output cap (the built-in Claude models' output limit); the
 *  generic "thinking" label (MiniMax-style on/off) maps to the medium budget. */
const ANTHROPIC_THINKING_BUDGETS: Record<string, number> = {
  minimal: 2048,
  low: 4096,
  medium: 12288,
  high: 24576,
  xhigh: 32768,
  max: 49152,
};

/**
 * Map `AIEngineOptions.reasoningEffort` (an OpenCode-style label) onto each
 * provider family's native option, verified against the INSTALLED SDK schemas:
 *   - anthropic (@ai-sdk/anthropic 4.0.2): `providerOptions.anthropic.thinking`
 *     takes `{ type: "enabled", budgetTokens }` — effort becomes a budget via
 *     ANTHROPIC_THINKING_BUDGETS; "none" disables thinking (`{ type: "disabled" }`).
 *   - openai (@ai-sdk/openai 4.0.3): `providerOptions.openai.reasoningEffort`
 *     — the label is forwarded verbatim (GPT-5.x accepts none/minimal/.../xhigh;
 *     the per-model picker only offers labels that model supports).
 *   - openai-compatible (@ai-sdk/openai-compatible 3.0.1): the label is
 *     serialized as `reasoning_effort`; backends ignore values they don't support.
 * Returns undefined when effort is unset or "default": the request is unchanged.
 */
export function reasoningProviderOptions(
  kind: ResolvedModel["provider"]["kind"],
  effort: AIEngineOptions["reasoningEffort"],
): ProviderOptions | undefined {
  if (!effort || effort === "default") return undefined;
  switch (kind) {
    case "anthropic":
      if (effort === "none") return { anthropic: { thinking: { type: "disabled" } } };
      return {
        anthropic: {
          thinking: {
            budgetTokens: ANTHROPIC_THINKING_BUDGETS[effort] ?? ANTHROPIC_THINKING_BUDGETS.medium,
            type: "enabled",
          },
        },
      };
    case "openai":
      return { openai: { reasoningEffort: effort } };
    case "openai-compatible":
      return { openaiCompatible: { reasoningEffort: effort } };
  }
}

/** Map an SDK / network error to the AIStreamPart error taxonomy so the UI can
 *  show a dedicated message (esp. "Ollama offline" — a refused connection). */
function classifyError(e: unknown): { code: AIErrorCode; message: string } {
  const err = e as {
    name?: string;
    statusCode?: number;
    status?: number;
    message?: string;
  };
  const name = err?.name ?? "";
  const status = err?.statusCode ?? err?.status;
  const message = err?.message ?? String(e);
  if (name === "AbortError" || /abort/i.test(message)) {
    return { code: "aborted", message: "Request aborted" };
  }
  if (status === 401 || status === 403) return { code: "auth", message };
  if (status === 429) return { code: "rate_limit", message };
  if (status === 404) return { code: "not_found", message };
  if (/\bcors\b/i.test(message)) return { code: "cors", message };
  if (
    /fetch failed|network|econnrefused|failed to fetch|load failed|connection refused/i.test(
      message,
    )
  ) {
    return { code: "network", message };
  }
  return { code: "unknown", message };
}

/** A loosely-typed AI SDK event stream part — we read only the fields we map. */
type FullStreamPart = { type: string } & Record<string, unknown>;

/** Build the per-run telemetry `usage` part (emitted once, right before
 *  `done`): token totals from the SDK's `usage` (ai@7 reports total run usage
 *  there) plus the tool-call count across steps. Returns undefined unless at
 *  least one number is finite — a turn with no reported usage and no tool calls
 *  emits nothing. */
function buildUsagePart(
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  toolCalls: number,
): Extract<AIStreamPart, { type: "usage" }> | undefined {
  const part: Extract<AIStreamPart, { type: "usage" }> = { type: "usage" };
  if (typeof usage?.inputTokens === "number" && Number.isFinite(usage.inputTokens)) {
    part.inputTokens = usage.inputTokens;
  }
  if (typeof usage?.outputTokens === "number" && Number.isFinite(usage.outputTokens)) {
    part.outputTokens = usage.outputTokens;
  }
  if (Number.isFinite(toolCalls) && toolCalls > 0) part.toolCalls = toolCalls;
  const hasData =
    part.inputTokens !== undefined || part.outputTokens !== undefined || part.toolCalls !== undefined;
  return hasData ? part : undefined;
}

/**
 * Map an AI SDK `streamText().stream` onto our `AIStreamPart` contract,
 * owning the single terminal emission: an `error`/`abort` part yields one error
 * and STOPS the stream (no trailing `done`); otherwise a `done` is emitted after
 * the loop, carrying usage from the `finish` part. Unknown part types
 * (text-start/-end, reasoning-*, tool-input-*, source, file, step boundaries,
 * raw, ...) are intentionally ignored. Pure over the input — unit-testable.
 */
export async function* mapFullStream(
  stream: AsyncIterable<FullStreamPart>,
  sourceByName?: Map<string, string | undefined>,
): AsyncIterable<AIStreamPart> {
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let toolCalls = 0;
  for await (const part of stream) {
    switch (part.type) {
      case "text-delta": {
        const text = (part.delta ?? part.text ?? part.textDelta) as string | undefined;
        if (text) yield { type: "text-delta", text };
        break;
      }
      case "tool-call":
        toolCalls += 1;
        yield {
          type: "tool-call",
          toolCallId: part.toolCallId as string,
          toolName: part.toolName as string,
          source: sourceByName?.get(part.toolName as string),
          args: part.input,
        };
        break;
      case "tool-result":
        yield {
          type: "tool-result",
          toolCallId: part.toolCallId as string,
          toolName: part.toolName as string,
          result: part.output,
        };
        break;
      case "tool-error":
        yield {
          type: "tool-result",
          toolCallId: part.toolCallId as string,
          toolName: part.toolName as string,
          result: part.error,
          isError: true,
        };
        break;
      case "error":
        yield { type: "error", ...classifyError(part.error) };
        return; // own the terminal — no trailing done
      case "abort":
        yield { type: "error", code: "aborted", message: "Request aborted" };
        return;
      case "tool-output-denied":
        // Only emitted if a tool sets the SDK's loop-level `needsApproval`, which
        // Markdraw does NOT (approval is the execute-wrapper in approval-policy.ts,
        // applied by the engine when ChatOptions.onApprovalRequest is set — see
        // the gating note in chat() for why native needsApproval is deferred).
        // Mapped defensively so a denial is never invisible if that ever changes.
        yield {
          type: "tool-result",
          toolCallId: part.toolCallId as string,
          toolName: part.toolName as string,
          result: { rejected: true },
          isError: true,
        };
        break;
      case "finish":
        usage = (part.usage ?? part.totalUsage) as typeof usage;
        break;
      default:
        // Non-mapped parts (text-start/-end, reasoning-*, tool-input-*, source,
        // file, step boundaries, raw, and tool-approval-request — unreachable as
        // long as approval stays in the execute-wrapper) are intentionally ignored.
        break;
    }
  }
  const usagePart = buildUsagePart(usage, toolCalls);
  if (usagePart) yield usagePart;
  yield {
    type: "done",
    usage: { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 },
  };
}

/** Split completed text into ~3-token chunks (whitespace preserved) so the UI
 *  renders it with a live-typing feel even though the HTTP request was
 *  non-streaming. */
function chunkForTyping(text: string, perChunk = 3): string[] {
  const tokens = text.split(/(\s+)/).filter((t) => t.length > 0);
  const chunks: string[] = [];
  for (let i = 0; i < tokens.length; i += perChunk) {
    chunks.push(tokens.slice(i, i + perChunk).join(""));
  }
  return chunks.length > 0 ? chunks : [text];
}

function createProvider(
  resolved: ResolvedModel,
  getApiKey: CredentialResolver,
  opts?: AIEngineOptions,
): AIProvider {
  async function* chat(
    messages: AIMessage[],
    chatOpts?: ChatOptions,
  ): AsyncIterable<AIStreamPart> {
    // The HTTP request is NON-streaming: the Tauri HTTP plugin (used to dodge
    // the WKWebView CORS wall) doesn't surface SSE incrementally. We fetch the
    // full completion, then re-emit it in small chunks for a live-typing feel.
    // When tools are supplied the SDK runs a multi-step tool-calling loop; the
    // whole loop resolves before we get `result`, so tool activity is surfaced
    // from `result.steps` after the fact (in order: all tools, then final text).
    let text: string;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    // Structural type for the slice of StepResult we read — keeps the SDK out
    // of the contract while staying assignable from `result.steps`.
    type ToolStep = {
      toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
      toolResults: ReadonlyArray<{ toolCallId: string; toolName: string; output: unknown }>;
    };
    let steps: ReadonlyArray<ToolStep> = [];
    const toolList = chatOpts?.tools ?? [];
    const sourceByName = new Map(toolList.map((t) => [t.name, t.source]));
    // Engine-level human-in-the-loop (DJA F3): when the host supplies
    // `onApprovalRequest`, the engine gates every prompt-tier tool itself via
    // the same pure `withApproval` wrapper hosts used to apply — auto-tier
    // tools pass through untouched and a denial resolves to the model-visible
    // `{ rejected: true, error }` result the chat UI already renders. Without
    // the callback, tools run exactly as given (hosts that still pre-wrap keep
    // today's behavior; no double-gating).
    //
    // Why not the SDK's native tool approval flow:
    // generateText/streamText HALT the loop with a `tool-approval-request`
    // content part; execution resumes only when the caller appends a tool
    // message carrying a `tool-approval-response` part and issues a NEW
    // generate call (the UI-side `lastAssistantMessageIsCompleteWithApproval
    // Responses` helper exists precisely to drive that resubmission). Our
    // `AIProvider.chat` is a single-call contract over plain-text AIMessages —
    // approval parts cannot round-trip through the host history — and a native
    // denial surfaces as `tool-output-denied` instead of the `{ rejected }`
    // result shape the chat store expects. The in-execute gate is the smaller
    // correct step until the contract carries structured history.
    const onApprovalRequest = chatOpts?.onApprovalRequest;
    const gatedTools = onApprovalRequest
      ? toolList.map((t) => withApproval(t, onApprovalRequest))
      : toolList;
    // Compaction: cap the history BEFORE the provider call, dropping the
    // oldest messages at a boundary that never splits a tool call from its
    // result (and pinning leading system messages). See MAX_CONTEXT_MESSAGES
    // for why the budget is a message count.
    const history = compactMessages(messages, MAX_CONTEXT_MESSAGES);
    const historyInstructions = history
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const instructions = [chatOpts?.system, historyInstructions].filter(Boolean).join("\n\n");
    const modelMessages = history
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    try {
      const apiKey = await getApiKey();
      const model = await buildModel(resolved, apiKey, opts?.fetch);
      const ai = await import("ai");
      const tools = gatedTools.length
        ? Object.fromEntries(
            gatedTools.map((t) => [
              t.name,
              ai.dynamicTool({
                description: t.description ?? "",
                inputSchema: ai.jsonSchema(t.inputSchema as Parameters<typeof ai.jsonSchema>[0]),
                execute: (args: unknown, { abortSignal }: { abortSignal?: AbortSignal }) =>
                  t.execute(args, { signal: abortSignal }),
              }),
            ]),
          )
        : undefined;
      const providerOptions = reasoningProviderOptions(
        resolved.provider.kind,
        opts?.reasoningEffort,
      );
      const common = {
        model,
        ...(instructions ? { instructions } : {}),
        messages: modelMessages,
        ...(chatOpts?.signal ? { abortSignal: chatOpts.signal } : {}),
        ...(chatOpts?.temperature != null ? { temperature: chatOpts.temperature } : {}),
        ...(tools ? { tools, stopWhen: ai.isStepCount(chatOpts?.maxSteps ?? 8) } : {}),
        ...(providerOptions ? { providerOptions } : {}),
      };

      // Streaming path (opt-in): real incremental deltas via `stream`,
      // smoothed to word boundaries. `mapFullStream` owns the terminal. If the
      // injected fetch doesn't surface SSE incrementally (the A0 question),
      // smoothStream still yields a typing feel; if it hangs, the default
      // buffered path below is the kill-switch.
      if (opts?.streaming) {
        const result = ai.streamText({
          ...common,
          experimental_transform: ai.smoothStream({ chunking: "word" }),
        });
        yield* mapFullStream(result.stream as AsyncIterable<FullStreamPart>, sourceByName);
        return;
      }

      const result = await ai.generateText(common);
      text = result.text;
      // AI SDK v7 reports total run usage across every step in `usage`.
      usage = result.usage;
      steps = result.steps;
    } catch (e) {
      yield { type: "error", ...classifyError(e) };
      return;
    }

    for (const step of steps) {
      for (const call of step.toolCalls) {
        yield {
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          source: sourceByName.get(call.toolName),
          args: call.input,
        };
      }
      for (const res of step.toolResults) {
        yield {
          type: "tool-result",
          toolCallId: res.toolCallId,
          toolName: res.toolName,
          result: res.output,
        };
      }
    }

    for (const chunk of chunkForTyping(text)) {
      if (chatOpts?.signal?.aborted) {
        yield { type: "error", code: "aborted", message: "Request aborted" };
        return;
      }
      yield { type: "text-delta", text: chunk };
      await new Promise((r) => setTimeout(r, 10));
    }
    const usagePart = buildUsagePart(
      usage,
      steps.reduce((n, step) => n + step.toolCalls.length, 0),
    );
    if (usagePart) yield usagePart;
    yield {
      type: "done",
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
      },
    };
  }

  async function complete(prompt: string, completeOpts?: CompleteOptions): Promise<string> {
    let out = "";
    for await (const part of chat([{ role: "user", content: prompt }], completeOpts)) {
      if (part.type === "text-delta") out += part.text;
    }
    return out;
  }

  async function embed(text: string | string[]): Promise<number[][]> {
    const inputs = Array.isArray(text) ? text : [text];
    if (inputs.length === 0) return [];
    const apiKey = await getApiKey();
    const model = await buildEmbeddingModel(resolved, apiKey, opts?.fetch);
    const ai = await import("ai");
    const { embeddings } = await ai.embedMany({ model, values: inputs });
    return embeddings;
  }

  return { chat, complete, embed };
}

export const aiSdkEngine: AIEngine = { id: "ai-sdk", createProvider };
