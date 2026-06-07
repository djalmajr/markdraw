// Provider abstraction contract for the AI assistant (DJA-11).
//
// This is the single seam every AI surface depends on — the sidebar chat
// (DJA-12), inline actions (DJA-13) and diagram-from-text (DJA-14) all talk
// to an `AIProvider`. It is intentionally runtime-agnostic: no SolidJS, no
// Tauri, and no `@ai-sdk/*` imports leak into the contract. The real adapter
// (adapter.ts) maps this onto the Vercel AI SDK; `MockProvider` satisfies it
// with canned streams so the UI can be built before any key/LLM exists.

export type AIRole = "system" | "user" | "assistant";

export interface AIMessage {
  role: AIRole;
  content: string;
}

/** Error taxonomy so the UI can show a dedicated message per failure mode.
 *  ADR-004 makes Ollama first-class, and its most common failure is a
 *  refused localhost connection — hence a distinct `network` code. */
export type AIErrorCode =
  | "auth" // 401 / missing or invalid key
  | "network" // connection refused / DNS / offline (e.g. Ollama not running)
  | "rate_limit" // 429
  | "not_found" // model or provider not found (404)
  | "cors" // browser blocked the cross-origin request
  | "aborted" // user cancelled via AbortSignal
  | "unknown";

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
}

/** One chunk of a streamed completion. The stream ends with exactly one
 *  terminal part — `done` on success or `error` on failure.
 *  `citation` is reserved for M2 (RAG / file:line grounding) and is never
 *  emitted in M1. `tool-call`/`tool-result` surface the model's use of MCP
 *  (and in-process app) tools during a tool-calling loop (M2). */
export type AIStreamPart =
  | { type: "text-delta"; text: string }
  | { type: "citation"; file: string; line: number }
  | { type: "tool-call"; toolCallId: string; toolName: string; source?: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
  | { type: "error"; code: AIErrorCode; message: string }
  | { type: "done"; usage?: AIUsage };

/** A tool the model can call during a chat (M2). Engine-neutral: the host
 *  builds these from MCP servers (via the Rust manager) and from in-process
 *  app capabilities (read/search/edit the active document). The ai-sdk engine
 *  maps each onto an AI SDK `dynamicTool`; a TanStack engine could map it too. */
export interface AITool {
  /** Name shown to the model. The host namespaces MCP tools as
   *  `"<serverId>__<toolName>"` to avoid collisions across servers. */
  name: string;
  description?: string;
  /** JSON Schema for the tool input (fed to the AI SDK's `jsonSchema()`). */
  inputSchema: Record<string, unknown>;
  /** Invoked when the model calls the tool. Returns a JSON-serializable
   *  result. May await user approval (e.g. an Accept/Reject for an edit).
   *  `opts.signal` is the run's abort signal, threaded so a long-running tool
   *  (e.g. an MCP call) can be cancelled when the user stops the turn. */
  execute: (args: unknown, opts?: ToolExecuteOptions) => Promise<unknown>;
  /** Origin label for the UI (the MCP server id, or `"app"` for in-process). */
  source?: string;
  /** Human-in-the-loop gating. `"auto"` runs without asking; `"prompt"` asks
   *  the user to Accept/Reject before executing. When omitted, the host derives
   *  a default via {@link resolveApprovalTier} (MCP/unknown tools prompt). */
  approval?: ApprovalTier;
}

/** Approval tier for a tool call. */
export type ApprovalTier = "auto" | "prompt";

/** Options the engine passes to {@link AITool.execute}. */
export interface ToolExecuteOptions {
  /** Aborts the in-flight tool call (threaded from the chat run's signal). */
  signal?: AbortSignal;
}

export interface ChatOptions {
  /** System prompt prepended to the conversation. */
  system?: string;
  /** Model id in "provider/model" form. Defaults to the configured model. */
  model?: string;
  /** Cancels the in-flight request and stops the stream (maps to the AI
   *  SDK `abortSignal`). */
  signal?: AbortSignal;
  temperature?: number;
  /** Tools the model may call (MCP + in-process). When present, the engine
   *  runs a multi-step tool-calling loop. */
  tools?: AITool[];
  /** Max steps in the tool-calling loop (AI SDK `stopWhen: stepCountIs`).
   *  Defaults to 8. Ignored when `tools` is empty. */
  maxSteps?: number;
}

export type CompleteOptions = ChatOptions;

/** The unified provider interface every adapter implements (opencode-style,
 *  backed by the Vercel AI SDK in the real adapter). */
export interface AIProvider {
  /** Streaming chat completion — yields parts until a terminal `done` or
   *  `error`. Consumers `for await` over it and append `text-delta`s. */
  chat(messages: AIMessage[], opts?: ChatOptions): AsyncIterable<AIStreamPart>;
  /** One-shot completion; collects the stream into a single string. */
  complete(prompt: string, opts?: CompleteOptions): Promise<string>;
  /** Text embeddings. M1 adapters may throw `NotSupportedError` — RAG is M2. */
  embed(text: string | string[]): Promise<number[][]>;
}

/** Thrown by `embed()` (and any other M2-only capability) on providers that
 *  do not implement it in M1. */
export class NotSupportedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not supported by this provider`);
    this.name = "NotSupportedError";
  }
}
