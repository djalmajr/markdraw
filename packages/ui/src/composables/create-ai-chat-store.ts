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
import type { PersistedAdvisorNote, PersistedToolActivity } from "@markdraw/core/ai-chat-sessions.ts";

const TOOL_RESULT_ARTIFACT_THRESHOLD = 8_000;
const TOOL_RESULT_PREVIEW_CHARS = 2_000;
const AUTO_COMPACT_MESSAGE_THRESHOLD = 120;
const COMPACT_KEEP_MESSAGES = 40;

type ChatArtifactRef = NonNullable<PersistedToolActivity["resultArtifact"]>;

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
  resultArtifact?: ChatArtifactRef;
}

/** Per-run telemetry captured from the provider's terminal `usage` stream
 *  part (token totals + tool-call count, all optional). */
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
}

export interface ChatTurnContextItem {
  id?: string;
  kind: "file" | "folder" | "mcp-resource" | "selection";
  label: string;
  path?: string;
  rootId?: string;
  rootPath?: string;
  absolutePath?: string;
}

export interface ChatContextResolution {
  preamble?: string;
  items?: ChatTurnContextItem[];
}

export type ChatContextResult = ChatContextResolution | string | undefined;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  kind?: "normal" | "compaction";
  /** Read-only advisor/watchdog notes attached to this assistant turn. */
  advisorNotes?: PersistedAdvisorNote[];
  /** Context metadata used for this user turn. The raw context text is not
   *  stored; this is only the small display/debug snapshot shown in chat. */
  context?: ChatTurnContextItem[];
  /** Tool calls the assistant made on this turn (assistant turns only). */
  tools?: ToolActivity[];
  /** Per-run telemetry, attached when the provider reported it (assistant
   *  turns only). */
  usage?: TurnUsage;
}

export interface TurnValidationResult {
  message: string;
  reminder?: string;
  signature?: string;
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
  /** Replace older turns with a visible summary while preserving recent turns. */
  compactHistory(): void;
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
  getContext?: (request: { history: ChatTurn[]; userMessage: string }) => ChatContextResult;
  /** Snapshot of the host chat mode captured when a turn STARTS. Forwarded to
   *  the finalization hooks below so a mode switch while a background turn
   *  streams doesn't misroute validation/advice/plan-write. */
  getMode?: () => string | undefined;
  /** Called when an assistant turn finalizes with non-empty text (used by Plan
   *  mode to persist the produced plan). Receives the mode the turn ran under. */
  onAssistantTurn?: (content: string, mode?: string) => void;
  /** Optional host guard run after a turn finalizes, before the turn is accepted
   *  as successful. Return a message to surface an error while keeping the
   *  assistant text visible for debugging. */
  validateAssistantTurn?: (request: {
    assistantText: string;
    history: ChatTurn[];
    mode?: string;
    tools: ToolActivity[];
    userMessage: string;
  }) => string | TurnValidationResult | undefined;
  /** Optional read-only second-pass advisor. Runs after the primary turn has
   *  produced text/tools; errors are swallowed by the store. */
  adviseAssistantTurn?: (request: {
    assistantText: string;
    history: ChatTurn[];
    mode?: string;
    tools: ToolActivity[];
    userMessage: string;
  }) => Promise<PersistedAdvisorNote[]>;
  /** Optional large-result artifact store. Hosts that cannot persist artifacts
   *  omit it and keep the current inline preview behavior. */
  writeArtifact?: (input: {
    content: string;
    kind: ChatArtifactRef["kind"];
    mime: string;
    title: string;
    toolCallId?: string;
  }) => Promise<ChatArtifactRef>;
  /** Engine-level Accept/Reject gate for prompt-tier tools, forwarded into
   *  ChatOptions. When set, pass UNWRAPPED tools (the engine enforces). */
  onApprovalRequest?: (req: {
    args: unknown;
    signal?: AbortSignal;
    source?: string;
    toolName: string;
  }) => Promise<boolean>;
}

function appendTextDelta(current: string, delta: string): string {
  if (!delta) return current;
  if (!current) return delta;
  if (delta.startsWith(current)) return delta;
  return current + delta;
}

function normalizeValidationResult(
  result: string | TurnValidationResult | undefined,
): TurnValidationResult | undefined {
  if (!result) return undefined;
  return typeof result === "string" ? { message: result } : result;
}

function formatArtifactPreview(value: unknown): string {
  if (typeof value === "string") return value.slice(0, TOOL_RESULT_PREVIEW_CHARS);
  try {
    return JSON.stringify(value, null, 2).slice(0, TOOL_RESULT_PREVIEW_CHARS);
  } catch {
    return String(value).slice(0, TOOL_RESULT_PREVIEW_CHARS);
  }
}

async function maybeArtifactToolResult(
  config: AiChatStoreConfig,
  activity: ToolActivity,
  result: unknown,
): Promise<{ result: unknown; resultArtifact?: PersistedToolActivity["resultArtifact"] }> {
  const writeArtifact = config.writeArtifact;
  if (!writeArtifact) return { result };
  const isPlainText = typeof result === "string";
  let serialized: string;
  try {
    serialized = isPlainText ? result : JSON.stringify(result, null, 2);
  } catch {
    return { result };
  }
  if (serialized.length <= TOOL_RESULT_ARTIFACT_THRESHOLD) return { result };
  try {
    const artifact = await writeArtifact({
      content: serialized,
      kind: "tool-result",
      mime: isPlainText ? "text/plain" : "application/json",
      title: activity.toolName,
      toolCallId: activity.toolCallId,
    });
    return {
      result: {
        artifactId: artifact.id,
        byteLength: artifact.byteLength,
        preview: formatArtifactPreview(result),
        truncated: true,
      },
      resultArtifact: artifact,
    };
  } catch {
    return {
      result: {
        preview: formatArtifactPreview(result),
        truncated: true,
      },
    };
  }
}

interface RunTurnOptions {
  context?: ChatContextResolution;
  system?: string;
}

function normalizeContextResult(result: ChatContextResult): ChatContextResolution {
  if (typeof result === "string") return result ? { preamble: result } : {};
  return result ?? {};
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function buildCompactionTurn(compacted: ChatTurn[], kept: number): ChatTurn {
  const firstUser = compacted.find((turn) => turn.role === "user");
  const lastUser = [...compacted].reverse().find((turn) => turn.role === "user");
  const toolNames = [
    ...new Set(
      compacted
        .flatMap((turn) => turn.tools ?? [])
        .map((tool) => tool.toolName),
    ),
  ].slice(0, 8);
  const lines = [
    `Compacted ${compacted.length} older chat turns. The last ${kept} turns remain verbatim below.`,
    firstUser ? `First user request: ${oneLine(firstUser.content)}` : undefined,
    lastUser && lastUser !== firstUser ? `Latest compacted user request: ${oneLine(lastUser.content)}` : undefined,
    toolNames.length ? `Tools used earlier: ${toolNames.join(", ")}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return {
    role: "assistant",
    kind: "compaction",
    content: lines.join("\n"),
  };
}

function compactTurns(turns: ChatTurn[]): ChatTurn[] {
  if (turns.length <= COMPACT_KEEP_MESSAGES + 1) return turns;
  const compacted = turns.slice(0, -COMPACT_KEEP_MESSAGES);
  const kept = turns.slice(-COMPACT_KEEP_MESSAGES);
  if (compacted.length === 0) return turns;
  if (compacted.length === 1 && compacted[0]?.kind === "compaction") return turns;
  return [buildCompactionTurn(compacted, kept.length), ...kept];
}

export function createAiChatStore(config: AiChatStoreConfig): AiChatStore {
  const [messages, setMessages] = createSignal<ChatTurn[]>(config.initialMessages ?? []);
  const [streamingText, setStreamingText] = createSignal("");
  const [toolActivity, setToolActivity] = createSignal<ToolActivity[]>([]);
  const [streaming, setStreaming] = createSignal(false);
  const [error, setError] = createSignal<AiChatError | null>(null);
  const [queued, setQueued] = createSignal<string | null>(null);
  let controller: AbortController | null = null;
  let pendingReminder: TurnValidationResult | null = null;
  let lastReminderSignature = "";
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

  function resolveContext(history: ChatTurn[]): ChatContextResolution {
    const lastIndex = history.length - 1;
    return normalizeContextResult(
      config.getContext?.({
        history,
        userMessage: history[lastIndex]?.content ?? "",
      }),
    );
  }

  function takePendingReminder(): string | undefined {
    const reminder = pendingReminder?.reminder;
    pendingReminder = null;
    return reminder;
  }

  function appendUserTurn(
    base: ChatTurn[],
    content: string,
  ): { context: ChatContextResolution; history: ChatTurn[] } {
    const draft: ChatTurn[] = [...base, { role: "user", content }];
    const context = resolveContext(draft);
    const userTurn: ChatTurn = {
      role: "user",
      content,
      ...(context.items && context.items.length ? { context: context.items } : {}),
    };
    return { context, history: [...base, userTurn] };
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
    // No destructive auto-compaction: the full transcript stays the durable
    // source of truth (export/search/scrollback keep every turn). Long threads
    // are compacted only in the OUTGOING copy sent to the model (see runTurn).
    const { context, history } = appendUserTurn(messages(), trimmed);
    setMessages(history);
    await runTurn(history, { ...(opts ?? {}), context });
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
    const { context, history } = appendUserTurn(messages().slice(0, index), trimmed);
    setMessages(history);
    await runTurn(history, { context });
    await drainQueue();
  }

  /** Streams one assistant turn for `history` (which must end with the user
   *  turn being answered): provider resolution, the streaming buffer, tool
   *  activity, and the finally-append of the consolidated reply. Shared by
   *  sendMessage and retryLast. */
  async function runTurn(history: ChatTurn[], opts?: RunTurnOptions): Promise<void> {
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
    let turnAborted = false;
    let turnFailed = false;
    // Set only when the stream reaches its natural `done` terminal — the signal
    // that the assistant finished producing its text (see the onAssistantTurn
    // gate in the finally block below).
    let turnCompleted = false;
    // The host chat mode captured at turn START, forwarded to the finalization
    // hooks so a mode switch while a background turn streams doesn't misroute
    // validation / advice / the plan-write (they must reflect the turn's mode).
    const turnMode = config.getMode?.();

    // Inject the explicit context (attached files/selections) into the latest
    // user message that's SENT to the model — the stored/displayed turn above
    // stays clean so the chat doesn't show the raw context dump.
    // Compact only the OUTGOING context when the thread is long — messages()
    // and persistence keep the full transcript untouched (durable source of
    // truth). Short threads are sent verbatim.
    const sentHistory =
      history.length >= AUTO_COMPACT_MESSAGE_THRESHOLD ? compactTurns(history) : history;
    const lastIndex = sentHistory.length - 1;
    const context = opts?.context ?? resolveContext(history);
    const reminder = takePendingReminder();
    const contextPreamble = [context.preamble, reminder].filter(Boolean).join("\n\n") || undefined;
    const aiMessages: AIMessage[] = sentHistory.map((t, i) => ({
      // The compaction summary is a synthetic recap of dropped turns; send it as
      // a USER turn so the outgoing history still starts with role "user"
      // (Anthropic rejects an assistant-first /messages request). Its stored
      // display turn keeps role "assistant" + kind "compaction".
      role: t.kind === "compaction" ? "user" : t.role,
      content: i === lastIndex && contextPreamble ? `${contextPreamble}\n\n${t.content}` : t.content,
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
          setStreamingText((prev) => appendTextDelta(prev, part.text));
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
          const currentActivity = toolActivity().find((a) => a.toolCallId === part.toolCallId);
          const artifacted = currentActivity
            ? await maybeArtifactToolResult(config, currentActivity, part.result)
            : { result: part.result };
          setToolActivity((prev) =>
            prev.map((a) =>
              a.toolCallId === part.toolCallId
                ? {
                    ...a,
                    status: isError ? "error" : "done",
                    result: artifacted.result,
                    ...(artifacted.resultArtifact !== undefined
                      ? { resultArtifact: artifacted.resultArtifact }
                      : {}),
                  }
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
          if (part.code === "aborted") {
            turnAborted = true;
          } else {
            turnFailed = true;
            setError({ code: part.code, message: part.message });
          }
          break;
        } else if (part.type === "done") {
          turnCompleted = true;
          break;
        }
        // `citation` parts are ignored until file:line grounding lands.
      }
    } catch (e) {
      turnFailed = true;
      setError({
        code: "unknown",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      const finalText = streamingText();
      const turnTools = toolActivity();
      const shouldValidateTurn = !turnAborted && !turnFailed;
      const validationResult = shouldValidateTurn
        ? normalizeValidationResult(config.validateAssistantTurn?.({
            assistantText: finalText,
            history,
            mode: turnMode,
            tools: turnTools,
            userMessage: history.at(-1)?.content ?? "",
          }))
        : undefined;
      if (validationResult) {
        setError({ code: "unknown", message: validationResult.message });
        const signature = validationResult.signature ?? validationResult.message;
        if (validationResult.reminder && signature !== lastReminderSignature) {
          pendingReminder = validationResult;
          lastReminderSignature = signature;
        }
      }
      // Commit the assistant turn and stop streaming BEFORE the read-only
      // advisor pass: a slow or never-resolving advisor must not strand the
      // answer or hold streaming() true. Advisor notes patch this same turn
      // once (if) they arrive.
      let committedTurn: ChatTurn | undefined;
      if (finalText.length > 0 || turnTools.length > 0) {
        committedTurn = {
          role: "assistant",
          content: finalText,
          ...(turnTools.length ? { tools: turnTools } : {}),
          ...(turnUsage ? { usage: turnUsage } : {}),
        };
        const turn = committedTurn;
        setMessages((prev) => [...prev, turn]);
      }
      // Plan mode persists the plan from a COMPLETED turn (the stream reached
      // `done`) with non-empty text — independent of the validation gate, so a
      // plan that trips a rule (or a turn that errors right after finishing) is
      // still written; aborted-early / empty turns never reach here.
      if (turnCompleted && finalText.trim().length > 0) {
        config.onAssistantTurn?.(finalText, turnMode);
      }
      setStreamingText("");
      setToolActivity([]);
      setStreaming(false);
      controller = null;
      // Second-pass advisor: after the turn is committed and streaming stopped.
      // Errors are swallowed; notes patch the just-committed turn in place.
      if (committedTurn && shouldValidateTurn && !validationResult && config.adviseAssistantTurn) {
        const target = committedTurn;
        try {
          const advisorNotes = await config.adviseAssistantTurn({
            assistantText: finalText,
            history,
            mode: turnMode,
            tools: turnTools,
            userMessage: history.at(-1)?.content ?? "",
          });
          if (advisorNotes.length) {
            setMessages((prev) => prev.map((t) => (t === target ? { ...t, advisorNotes } : t)));
          }
        } catch {
          // advisor failures never surface — the committed turn stands as-is.
        }
      }
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
    // A queued validation reminder / de-dupe signature belongs to the
    // conversation being cleared — dropping them stops a stale reminder (or a
    // suppressed genuine repeat) leaking into the next conversation.
    pendingReminder = null;
    lastReminderSignature = "";
  }

  function compactHistory(): void {
    if (streaming()) return;
    setMessages((prev) => compactTurns(prev));
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
    compactHistory,
    systemPrompt,
    listTools,
  };
}
