// Shared chat session store for every AI surface. Built ONCE inside
// createAppState (DJA-11D) and consumed by the sidebar chat (DJA-12), inline
// actions (DJA-13) and diagram-from-text (DJA-14) so streaming, cancellation
// and history live in a single place.
//
// Engine-agnostic: it only talks to the injected `AIProvider` (the MockProvider
// in M1; a real engine in DJA-11F). It owns the AbortController, the partial
// streaming buffer, and the message list.

import { createSignal } from "solid-js";
import * as m from "@markdraw/i18n";
import type { AIErrorCode, AIMessage, AIProvider, AITool } from "@markdraw/ai/types.ts";

/** One tool invocation surfaced during a turn (MCP server or in-process app
 *  tool). With the non-streaming engine these arrive after the loop resolves,
 *  so `status` is usually terminal by the time the UI renders it. */
export interface ToolActivity {
  toolCallId: string;
  toolName: string;
  /** Origin server id, or "app" for in-process tools. */
  source?: string;
  args?: unknown;
  status: "running" | "done" | "error";
  result?: unknown;
}

/** Per-run telemetry captured from the provider's terminal `usage` stream
 *  part (token totals + tool-call count, all optional). */
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  /** Tool calls the assistant made on this turn (assistant turns only). */
  tools?: ToolActivity[];
  /** Per-run telemetry, attached when the provider reported it (assistant
   *  turns only). */
  usage?: TurnUsage;
}

export interface AiChatError {
  code: AIErrorCode;
  message: string;
}

export interface AiChatStore {
  /** Completed turns (user + assistant). */
  messages: () => ChatTurn[];
  /** The assistant text accumulated for the in-flight turn (empty when idle). */
  streamingText: () => string;
  /** Tool activity for the in-flight turn (cleared when it finalizes). */
  toolActivity: () => ToolActivity[];
  /** True while a turn is streaming. */
  streaming: () => boolean;
  /** Last non-aborted error, or null. */
  error: () => AiChatError | null;
  /** Whether a provider is configured (drives the empty-state vs ready UI). */
  providerReady: () => boolean;
  /** Steering: the message queued while a turn streams (one slot), or null. */
  queued: () => string | null;
  /** Drop the queued steering message without sending it. */
  cancelQueued(): void;
  /** Edit a PAST user turn and re-run from it: truncates the history to the
   *  turns before `index`, pushes the edited text as the new user turn and
   *  streams a fresh reply — everything after the edited turn is dropped.
   *  No-op while streaming, when `index` isn't a user turn, or when the text
   *  is blank. */
  editAndResend(index: number, text: string): Promise<void>;
  /** Re-run the trailing user turn: drops the last assistant reply (when one is
   *  trailing) and streams a fresh one in its place. No-op while streaming or
   *  when there is no trailing conversation to retry. */
  retryLast(): Promise<void>;
  /** Send a user message and stream the reply. While a turn streams the text
   *  QUEUES instead (steering) and the returned promise settles only when the
   *  queued turn actually completes — or when the queued slot dies (Stop, the
   *  queued bar's ×, or replacement by a newer steering send). No-op when the
   *  text is blank. */
  sendMessage(text: string, opts?: { system?: string }): Promise<void>;
  /** Abort the in-flight turn. The partial reply (if any) is kept as history. */
  cancel(): void;
  /** Clear history, error and any in-flight turn. */
  clear(): void;
  /** The default system prompt applied to turns, if the host configured one
   *  (used by the context-usage display). */
  systemPrompt(): string | undefined;
  /** Resolve the tools the assistant may call — for the context-usage display.
   *  Swallows errors (returns []), like the send path. */
  listTools(): Promise<AITool[]>;
}

export interface AiChatStoreConfig {
  /** Returns the active provider, or null when none is configured. */
  getProvider: () => AIProvider | null;
  /** Optional default system prompt applied to every turn. */
  system?: () => string | undefined;
  /** Tools the assistant may call this turn (MCP servers + in-process app
   *  tools). Resolved lazily per send so newly-connected MCP servers are
   *  picked up. Errors here are swallowed — the turn proceeds tool-less. */
  getTools?: () => AITool[] | Promise<AITool[]>;
  /** Max tool-calling steps, forwarded to the engine (default 8). */
  maxSteps?: number;
  /** Restored turns to seed history on construction (multi-chat hydration).
   *  Omitted for the single-session and inline stores. */
  initialMessages?: ChatTurn[];
  /** Explicit context preamble (attached files/selections) injected into the
   *  message SENT to the model. The displayed turn stays clean — only the
   *  outgoing copy carries it. Resolved per send so it reflects the current
   *  context chips. */
  getContext?: () => string | undefined;
  /** Called when an assistant turn finalizes with non-empty text (used by Plan
   *  mode to persist the produced plan). */
  onAssistantTurn?: (content: string) => void;
  /** Engine-level Accept/Reject gate for prompt-tier tools, forwarded into
   *  ChatOptions. When set, pass UNWRAPPED tools (the engine enforces). */
  onApprovalRequest?: (req: {
    args: unknown;
    signal?: AbortSignal;
    source?: string;
    toolName: string;
  }) => Promise<boolean>;
}

export function createAiChatStore(config: AiChatStoreConfig): AiChatStore {
  const [messages, setMessages] = createSignal<ChatTurn[]>(config.initialMessages ?? []);
  const [streamingText, setStreamingText] = createSignal("");
  const [toolActivity, setToolActivity] = createSignal<ToolActivity[]>([]);
  const [streaming, setStreaming] = createSignal(false);
  const [error, setError] = createSignal<AiChatError | null>(null);
  const [queued, setQueued] = createSignal<string | null>(null);
  let controller: AbortController | null = null;
  // Resolves the steering sender's promise. A send made while a turn streams
  // must NOT settle at queue time: callers (the composer's mention
  // consumption) release the message's context on settlement, and the context
  // preamble is only read when the queued turn actually RUNS.
  let settleQueued: (() => void) | null = null;

  /** Settle the current queued sender's promise — used when the slot dies
   *  without running (Stop, the queued bar's ×, replacement). */
  function settleQueuedSlot(): void {
    const settle = settleQueued;
    settleQueued = null;
    settle?.();
  }

  function providerReady(): boolean {
    return config.getProvider() !== null;
  }

  /** Dispatch the steering queue once the current turn settled. One slot:
   *  sending again while streaming replaces the pending message. The queued
   *  sender's promise settles AFTER its turn completes (finally — even a
   *  failed turn must release the sender). */
  async function drainQueue(): Promise<void> {
    const next = queued();
    if (next === null || streaming()) return;
    const settle = settleQueued;
    settleQueued = null;
    setQueued(null);
    try {
      await sendMessage(next);
    } finally {
      settle?.();
    }
  }

  async function sendMessage(
    text: string,
    opts?: { system?: string },
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Steering: typing during a turn queues the message instead of dropping
    // it — it auto-sends when the in-flight turn finishes. The returned
    // promise settles when the queued turn actually runs (drainQueue) or the
    // slot dies, NOT at queue time; one slot, so a replacement settles the
    // sender it displaces.
    if (streaming()) {
      settleQueuedSlot();
      setQueued(trimmed);
      return new Promise<void>((resolve) => {
        settleQueued = resolve;
      });
    }

    // The no-provider check lives here (not only in runTurn) so the typed
    // message is NOT pushed into history when nothing can answer it.
    if (!providerReady()) {
      setError({ code: "unknown", message: m.ai_error_no_provider() });
      return;
    }

    setError(null);
    const history: ChatTurn[] = [...messages(), { role: "user", content: trimmed }];
    setMessages(history);
    await runTurn(history, opts);
    await drainQueue();
  }

  /** Re-run the trailing user turn: drops the last assistant reply (when one is
   *  trailing) and streams a fresh one. The user turn stays in place — no new
   *  turn is pushed. */
  async function retryLast(): Promise<void> {
    if (streaming()) return;
    // Check the provider BEFORE truncating: the slice below persists through
    // the sessions effect, so a no-provider retry would otherwise permanently
    // delete the old reply and leave only an error behind.
    if (!providerReady()) {
      setError({ code: "unknown", message: m.ai_error_no_provider() });
      return;
    }
    const turns = messages();
    if (turns.length === 0) return;
    const history = turns.at(-1)?.role === "assistant" ? turns.slice(0, -1) : [...turns];
    // Without a trailing user turn there is nothing to re-ask.
    if (history.at(-1)?.role !== "user") return;
    setError(null);
    setMessages(history);
    await runTurn(history);
    await drainQueue();
  }

  /** Edit a past user turn and re-run the conversation from it: drops the
   *  edited turn and everything after it, pushes the edited text as the new
   *  user turn and streams a fresh reply. */
  async function editAndResend(index: number, text: string): Promise<void> {
    if (streaming()) return;
    // Check the provider BEFORE truncating: the slice below persists through
    // the sessions effect, so a no-provider edit would otherwise permanently
    // delete the later turns and leave only an error behind (same reasoning
    // as retryLast).
    if (!providerReady()) {
      setError({ code: "unknown", message: m.ai_error_no_provider() });
      return;
    }
    if (messages()[index]?.role !== "user") return;
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    const history: ChatTurn[] = [
      ...messages().slice(0, index),
      { role: "user", content: trimmed },
    ];
    setMessages(history);
    await runTurn(history);
    await drainQueue();
  }

  /** Streams one assistant turn for `history` (which must end with the user
   *  turn being answered): provider resolution, the streaming buffer, tool
   *  activity, and the finally-append of the consolidated reply. Shared by
   *  sendMessage and retryLast. */
  async function runTurn(history: ChatTurn[], opts?: { system?: string }): Promise<void> {
    const provider = config.getProvider();
    if (!provider) {
      setError({ code: "unknown", message: m.ai_error_no_provider() });
      return;
    }

    setStreamingText("");
    setToolActivity([]);
    setStreaming(true);
    controller = new AbortController();
    // Per-run telemetry (the `usage` part precedes `done`); attached to the
    // finalized assistant turn in the finally-append below.
    let turnUsage: TurnUsage | undefined;

    // Inject the explicit context (attached files/selections) into the latest
    // user message that's SENT to the model — the stored/displayed turn above
    // stays clean so the chat doesn't show the raw context dump.
    const context = config.getContext?.();
    const lastIndex = history.length - 1;
    const aiMessages: AIMessage[] = history.map((t, i) => ({
      role: t.role,
      content: i === lastIndex && context ? `${context}\n\n${t.content}` : t.content,
    }));

    // Resolve tools lazily so newly-connected MCP servers are picked up. A
    // failure to list tools must not block the chat — proceed tool-less.
    let tools: AITool[] | undefined;
    try {
      tools = config.getTools ? await config.getTools() : undefined;
    } catch {
      tools = undefined;
    }

    try {
      const stream = provider.chat(aiMessages, {
        system: opts?.system ?? config.system?.(),
        signal: controller.signal,
        ...(tools && tools.length
          ? {
              tools,
              ...(config.maxSteps != null ? { maxSteps: config.maxSteps } : {}),
              // Engine-level approval gate (F3): tools arrive unwrapped and
              // the engine asks before running prompt-tier ones.
              ...(config.onApprovalRequest
                ? { onApprovalRequest: config.onApprovalRequest }
                : {}),
            }
          : {}),
      });
      for await (const part of stream) {
        if (part.type === "text-delta") {
          setStreamingText((prev) => prev + part.text);
        } else if (part.type === "tool-call") {
          setToolActivity((prev) => [
            ...prev,
            {
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              source: part.source,
              args: part.args,
              status: "running",
            },
          ]);
        } else if (part.type === "tool-result") {
          const isError =
            part.isError === true ||
            (typeof part.result === "object" &&
              part.result !== null &&
              (part.result as { isError?: boolean }).isError === true);
          setToolActivity((prev) =>
            prev.map((a) =>
              a.toolCallId === part.toolCallId
                ? { ...a, status: isError ? "error" : "done", result: part.result }
                : a,
            ),
          );
        } else if (part.type === "usage") {
          turnUsage = {
            ...(part.inputTokens !== undefined ? { inputTokens: part.inputTokens } : {}),
            ...(part.outputTokens !== undefined ? { outputTokens: part.outputTokens } : {}),
            ...(part.toolCalls !== undefined ? { toolCalls: part.toolCalls } : {}),
          };
        } else if (part.type === "error") {
          // `aborted` is user-initiated — keep the partial reply, no error UI.
          if (part.code !== "aborted") {
            setError({ code: part.code, message: part.message });
          }
          break;
        } else if (part.type === "done") {
          break;
        }
        // `citation` parts are ignored until file:line grounding lands.
      }
    } catch (e) {
      setError({
        code: "unknown",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      const finalText = streamingText();
      const turnTools = toolActivity();
      if (finalText.length > 0 || turnTools.length > 0) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: finalText,
            ...(turnTools.length ? { tools: turnTools } : {}),
            ...(turnUsage ? { usage: turnUsage } : {}),
          },
        ]);
      }
      if (finalText.trim().length > 0) config.onAssistantTurn?.(finalText);
      setStreamingText("");
      setToolActivity([]);
      setStreaming(false);
      controller = null;
    }
  }

  function cancel(): void {
    // Stop means stop: a queued steering message must not fire right after.
    settleQueuedSlot();
    setQueued(null);
    controller?.abort();
  }

  function cancelQueued(): void {
    settleQueuedSlot();
    setQueued(null);
  }

  function clear(): void {
    cancel();
    setMessages([]);
    setStreamingText("");
    setToolActivity([]);
    setError(null);
  }

  function systemPrompt(): string | undefined {
    return config.system?.();
  }

  async function listTools(): Promise<AITool[]> {
    try {
      return config.getTools ? await config.getTools() : [];
    } catch {
      return [];
    }
  }

  return {
    messages,
    streamingText,
    toolActivity,
    streaming,
    error,
    providerReady,
    queued,
    cancelQueued,
    editAndResend,
    retryLast,
    sendMessage,
    cancel,
    clear,
    systemPrompt,
    listTools,
  };
}
