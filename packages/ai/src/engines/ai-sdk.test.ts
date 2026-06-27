import { describe, expect, it } from "bun:test";
import {
  MAX_CONTEXT_MESSAGES,
  aiSdkEngine,
  mapFullStream,
  reasoningProviderOptions,
} from "./ai-sdk.ts";
import type { FetchImpl } from "../engine.ts";
import type { ResolvedModel } from "../resolve-model.ts";
import type { AIMessage, AITool, AIStreamPart, ToolApprovalRequest } from "../types.ts";

type Part = { type: string } & Record<string, unknown>;

async function* gen(parts: Part[]): AsyncIterable<Part> {
  for (const p of parts) yield p;
}

async function collect(stream: AsyncIterable<AIStreamPart>): Promise<AIStreamPart[]> {
  const out: AIStreamPart[] = [];
  for await (const part of stream) out.push(part);
  return out;
}

describe("mapFullStream", () => {
  it("maps text-delta parts and ends with a done carrying usage", async () => {
    const out = await collect(
      mapFullStream(
        gen([
          { type: "text-delta", text: "Hel" },
          { type: "text-delta", text: "lo" },
          { type: "finish", totalUsage: { inputTokens: 3, outputTokens: 5 } },
        ]),
      ),
    );
    expect(out).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "usage", inputTokens: 3, outputTokens: 5 },
      { type: "done", usage: { inputTokens: 3, outputTokens: 5 } },
    ]);
  });

  it("supports the legacy textDelta field", async () => {
    const out = await collect(mapFullStream(gen([{ type: "text-delta", textDelta: "x" }])));
    expect(out[0]).toEqual({ type: "text-delta", text: "x" });
  });

  it("maps tool-call (with source) and tool-result", async () => {
    const out = await collect(
      mapFullStream(
        gen([
          { type: "tool-call", toolCallId: "c1", toolName: "ai-memory__q", input: { a: 1 } },
          { type: "tool-result", toolCallId: "c1", toolName: "ai-memory__q", output: { ok: true } },
          { type: "finish" },
        ]),
        new Map([["ai-memory__q", "ai-memory"]]),
      ),
    );
    expect(out[0]).toEqual({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "ai-memory__q",
      source: "ai-memory",
      args: { a: 1 },
    });
    expect(out[1]).toEqual({
      type: "tool-result",
      toolCallId: "c1",
      toolName: "ai-memory__q",
      result: { ok: true },
    });
  });

  it("maps tool-error to a tool-result with isError", async () => {
    const out = await collect(
      mapFullStream(gen([{ type: "tool-error", toolCallId: "c1", toolName: "t", error: "boom" }])),
    );
    expect(out[0]).toEqual({
      type: "tool-result",
      toolCallId: "c1",
      toolName: "t",
      result: "boom",
      isError: true,
    });
  });

  it("emits a classified error and STOPS (no trailing done)", async () => {
    const out = await collect(
      mapFullStream(
        gen([
          { type: "text-delta", text: "partial" },
          { type: "error", error: { statusCode: 401, message: "nope" } },
          { type: "finish" }, // must be ignored — stream already terminated
        ]),
      ),
    );
    expect(out).toEqual([
      { type: "text-delta", text: "partial" },
      { type: "error", code: "auth", message: "nope" },
    ]);
  });

  it("maps tool-output-denied to a tool-result with isError", async () => {
    const out = await collect(
      mapFullStream(gen([{ type: "tool-output-denied", toolCallId: "c1", toolName: "t" }, { type: "finish" }])),
    );
    expect(out[0]).toEqual({
      type: "tool-result",
      toolCallId: "c1",
      toolName: "t",
      result: { rejected: true },
      isError: true,
    });
  });

  it("maps an abort part to an aborted error and stops", async () => {
    const out = await collect(
      mapFullStream(gen([{ type: "abort" }, { type: "finish" }])),
    );
    expect(out).toEqual([{ type: "error", code: "aborted", message: "Request aborted" }]);
  });

  it("ignores non-mapped part types", async () => {
    const out = await collect(
      mapFullStream(
        gen([
          { type: "start" },
          { type: "start-step" },
          { type: "reasoning-delta", text: "thinking" },
          { type: "tool-input-delta", delta: "{" },
          { type: "text-delta", text: "hi" },
          { type: "finish-step" },
          { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } },
        ]),
      ),
    );
    expect(out).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "usage", inputTokens: 1, outputTokens: 1 },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
  });

  it("emits a done with zero usage when finish carries none", async () => {
    const out = await collect(mapFullStream(gen([{ type: "text-delta", text: "x" }])));
    expect(out[out.length - 1]).toEqual({
      type: "done",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    // No usage telemetry either — nothing finite was reported and no tool ran.
    expect(out.find((p) => p.type === "usage")).toBeUndefined();
  });

  it("emits a usage part counting tool calls before the done", async () => {
    const out = await collect(
      mapFullStream(
        gen([
          { type: "tool-call", toolCallId: "c1", toolName: "t", input: {} },
          { type: "tool-result", toolCallId: "c1", toolName: "t", output: 1 },
          { type: "finish", totalUsage: { inputTokens: 10, outputTokens: 20 } },
        ]),
      ),
    );
    expect(out[out.length - 2]).toEqual({
      type: "usage",
      inputTokens: 10,
      outputTokens: 20,
      toolCalls: 1,
    });
    expect(out[out.length - 1]?.type).toBe("done");
  });

  it("emits no usage part after a terminal error", async () => {
    const out = await collect(
      mapFullStream(gen([{ type: "error", error: { statusCode: 401, message: "nope" } }])),
    );
    expect(out).toEqual([{ type: "error", code: "auth", message: "nope" }]);
  });
});

// ── Fake-model harness: drives the real engine (buffered generateText path)
// through an injected fetch that replays canned OpenAI-compatible chat
// completions and records every request body the SDK sends.

interface RequestBody {
  messages: Array<{ content: unknown; role: string }>;
  reasoning_effort?: string;
}

function resolvedModel(): ResolvedModel {
  return {
    id: "test/m",
    providerId: "test",
    modelId: "m",
    provider: {
      kind: "openai-compatible",
      name: "Test",
      options: { baseURL: "http://fake.test/v1" },
      models: { m: { name: "m" } },
    },
    model: { name: "m" },
  };
}

/** Replays `payloads` in order (last one repeats) and captures request bodies. */
function createFakeFetch(payloads: Array<Record<string, unknown>>): {
  fetchImpl: FetchImpl;
  requests: RequestBody[];
} {
  const requests: RequestBody[] = [];
  let call = 0;
  const impl = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    requests.push(JSON.parse(String(init?.body)) as RequestBody);
    const payload = payloads[Math.min(call, payloads.length - 1)];
    call++;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  // Bun's fetch type carries a `preconnect` member — provide a no-op so the
  // fake satisfies FetchImpl structurally.
  const fetchImpl: FetchImpl = Object.assign(impl, { preconnect: () => {} });
  return { fetchImpl, requests };
}

function completionResponse(
  content: string,
  usage: { completion_tokens: number; prompt_tokens: number } = { completion_tokens: 1, prompt_tokens: 1 },
): Record<string, unknown> {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.prompt_tokens + usage.completion_tokens,
    },
  };
}

function toolCallResponse(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function chatThrough(
  fetchImpl: FetchImpl,
  messages: AIMessage[],
  opts?: Parameters<ReturnType<typeof aiSdkEngine.createProvider>["chat"]>[1],
): Promise<AIStreamPart[]> {
  const provider = aiSdkEngine.createProvider(resolvedModel(), async () => "key", {
    fetch: fetchImpl,
  });
  return collect(provider.chat(messages, opts));
}

function turns(count: number): AIMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `turn ${i}`,
  }));
}

describe("ai-sdk engine context compaction", () => {
  it("sends the full history when under MAX_CONTEXT_MESSAGES", async () => {
    const { fetchImpl, requests } = createFakeFetch([completionResponse("ok")]);
    const messages = turns(5);
    await chatThrough(fetchImpl, messages);
    expect(requests[0].messages).toHaveLength(5);
    expect(requests[0].messages[0].content).toBe("turn 0");
  });

  it("caps an oversized history at MAX_CONTEXT_MESSAGES, dropping the oldest", async () => {
    const { fetchImpl, requests } = createFakeFetch([completionResponse("ok")]);
    const total = MAX_CONTEXT_MESSAGES + 50;
    const messages = turns(total);
    await chatThrough(fetchImpl, messages);
    const sent = requests[0].messages;
    expect(sent).toHaveLength(MAX_CONTEXT_MESSAGES);
    expect(sent[0].content).toBe("turn 50"); // oldest 50 dropped
    expect(sent[sent.length - 1].content).toBe(`turn ${total - 1}`); // latest kept
  });

  it("always keeps a leading system message when compacting", async () => {
    const { fetchImpl, requests } = createFakeFetch([completionResponse("ok")]);
    const messages: AIMessage[] = [
      { role: "system", content: "rules" },
      ...turns(MAX_CONTEXT_MESSAGES + 29),
    ];
    await chatThrough(fetchImpl, messages);
    const sent = requests[0].messages;
    expect(sent).toHaveLength(MAX_CONTEXT_MESSAGES);
    expect(sent[0]).toEqual({ role: "system", content: "rules" });
    // The tail is the newest 199 turns of the 229 supplied.
    expect(sent[1].content).toBe("turn 30");
    expect(sent[sent.length - 1].content).toBe("turn 228");
  });
});

describe("ai-sdk engine reasoning effort", () => {
  it("forwards reasoningEffort as reasoning_effort in an openai-compatible request body", async () => {
    const { fetchImpl, requests } = createFakeFetch([completionResponse("ok")]);
    const provider = aiSdkEngine.createProvider(resolvedModel(), async () => "key", {
      fetch: fetchImpl,
      reasoningEffort: "medium",
    });
    await collect(provider.chat([{ role: "user", content: "hi" }]));
    expect(requests[0].reasoning_effort).toBe("medium");
  });

  it("leaves the request body untouched when the option is omitted (off)", async () => {
    const { fetchImpl, requests } = createFakeFetch([completionResponse("ok")]);
    await chatThrough(fetchImpl, [{ role: "user", content: "hi" }]);
    expect(requests[0].reasoning_effort).toBeUndefined();
  });
});

describe("ai-sdk engine per-run usage telemetry (buffered path)", () => {
  it("emits a usage part from the SDK totalUsage right before the done", async () => {
    const { fetchImpl } = createFakeFetch([
      completionResponse("ok", { completion_tokens: 9, prompt_tokens: 7 }),
    ]);
    const parts = await chatThrough(fetchImpl, [{ role: "user", content: "hi" }]);
    const usageIdx = parts.findIndex((p) => p.type === "usage");
    expect(parts[usageIdx]).toEqual({ type: "usage", inputTokens: 7, outputTokens: 9 });
    expect(parts[usageIdx + 1]?.type).toBe("done");
  });

  it("counts tool calls across steps and sums token usage over the loop", async () => {
    const { fetchImpl } = createFakeFetch([
      toolCallResponse("app__read", {}),
      completionResponse("read it", { completion_tokens: 3, prompt_tokens: 2 }),
    ]);
    const tool: AITool = {
      name: "app__read",
      inputSchema: { type: "object" },
      execute: async () => "contents",
      source: "app",
    };
    const parts = await chatThrough(fetchImpl, [{ role: "user", content: "go" }], { tools: [tool] });
    // totalUsage sums both steps: 1+2 prompt, 1+3 completion (toolCallResponse uses 1/1).
    expect(parts.find((p) => p.type === "usage")).toEqual({
      type: "usage",
      inputTokens: 3,
      outputTokens: 4,
      toolCalls: 1,
    });
  });
});

describe("ai-sdk engine-level tool approval", () => {
  const promptTool = (executed: unknown[]): AITool => ({
    name: "danger",
    description: "a prompt-tier tool",
    inputSchema: { type: "object", properties: { x: { type: "number" } } },
    execute: async (args) => {
      executed.push(args);
      return { ok: true };
    },
    source: "some-mcp", // MCP/unknown source -> prompt tier by default
  });

  it("executes an approved prompt-tier call and surfaces the real result", async () => {
    const executed: unknown[] = [];
    const seen: ToolApprovalRequest[] = [];
    const { fetchImpl } = createFakeFetch([
      toolCallResponse("danger", { x: 1 }),
      completionResponse("did it"),
    ]);
    const parts = await chatThrough(fetchImpl, [{ role: "user", content: "go" }], {
      tools: [promptTool(executed)],
      onApprovalRequest: async (req) => {
        seen.push(req);
        return true;
      },
    });
    expect(executed).toEqual([{ x: 1 }]);
    expect(seen).toHaveLength(1);
    expect(seen[0].toolName).toBe("danger");
    expect(seen[0].source).toBe("some-mcp");
    expect(seen[0].args).toEqual({ x: 1 });
    const result = parts.find((p) => p.type === "tool-result");
    expect(result).toMatchObject({ toolName: "danger", result: { ok: true } });
  });

  it("resolves a denied call with the rejected-marker result, without executing", async () => {
    const executed: unknown[] = [];
    const { fetchImpl, requests } = createFakeFetch([
      toolCallResponse("danger", { x: 1 }),
      completionResponse("understood"),
    ]);
    const parts = await chatThrough(fetchImpl, [{ role: "user", content: "go" }], {
      tools: [promptTool(executed)],
      onApprovalRequest: async () => false,
    });
    expect(executed).toEqual([]);
    const result = parts.find((p) => p.type === "tool-result");
    // Must match withApproval's deny shape exactly — the chat store UI keys on it.
    expect(result).toMatchObject({
      toolName: "danger",
      result: { rejected: true, error: 'User rejected the "danger" tool call.' },
    });
    // The refusal is round-tripped to the model in the follow-up request.
    expect(JSON.stringify(requests[1].messages)).toContain("rejected");
  });

  it("never asks for auto-tier tools", async () => {
    const executed: unknown[] = [];
    let asked = 0;
    const { fetchImpl } = createFakeFetch([
      toolCallResponse("app__read", {}),
      completionResponse("read it"),
    ]);
    const tool: AITool = {
      name: "app__read",
      inputSchema: { type: "object" },
      execute: async (args) => {
        executed.push(args);
        return "contents";
      },
      source: "app", // in-process app tool -> auto tier
    };
    const parts = await chatThrough(fetchImpl, [{ role: "user", content: "go" }], {
      tools: [tool],
      onApprovalRequest: async () => {
        asked++;
        return false;
      },
    });
    expect(asked).toBe(0);
    expect(executed).toHaveLength(1);
    const result = parts.find((p) => p.type === "tool-result");
    expect(result).toMatchObject({ toolName: "app__read", result: "contents" });
  });

  it("does not gate when onApprovalRequest is absent (backward compat: hosts pre-wrap)", async () => {
    const executed: unknown[] = [];
    const { fetchImpl } = createFakeFetch([
      toolCallResponse("danger", { x: 2 }),
      completionResponse("done"),
    ]);
    const parts = await chatThrough(fetchImpl, [{ role: "user", content: "go" }], {
      tools: [promptTool(executed)],
    });
    // Prompt-tier tool, but no engine gate requested -> runs exactly as given.
    expect(executed).toEqual([{ x: 2 }]);
    const result = parts.find((p) => p.type === "tool-result");
    expect(result).toMatchObject({ toolName: "danger", result: { ok: true } });
  });
});

describe("reasoningProviderOptions", () => {
  it('omits the option for unset / "default" effort', () => {
    expect(reasoningProviderOptions("anthropic", undefined)).toBeUndefined();
    expect(reasoningProviderOptions("anthropic", "default")).toBeUndefined();
    expect(reasoningProviderOptions("openai-compatible", "default")).toBeUndefined();
  });

  it("maps anthropic effort to a thinking budget, and 'none' to disabled", () => {
    expect(reasoningProviderOptions("anthropic", "high")).toEqual({
      anthropic: { thinking: { budgetTokens: 24576, type: "enabled" } },
    });
    expect(reasoningProviderOptions("anthropic", "max")).toEqual({
      anthropic: { thinking: { budgetTokens: 49152, type: "enabled" } },
    });
    expect(reasoningProviderOptions("anthropic", "none")).toEqual({
      anthropic: { thinking: { type: "disabled" } },
    });
    // The generic on-toggle ("thinking", e.g. MiniMax) falls back to the medium budget.
    expect(reasoningProviderOptions("anthropic", "thinking")).toEqual({
      anthropic: { thinking: { budgetTokens: 12288, type: "enabled" } },
    });
  });

  it("forwards the label verbatim for openai and openai-compatible", () => {
    expect(reasoningProviderOptions("openai", "xhigh")).toEqual({
      openai: { reasoningEffort: "xhigh" },
    });
    expect(reasoningProviderOptions("openai-compatible", "max")).toEqual({
      openaiCompatible: { reasoningEffort: "max" },
    });
  });
});
