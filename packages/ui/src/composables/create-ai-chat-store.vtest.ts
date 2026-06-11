import { describe, expect, it } from "vitest";
import type { AIMessage, AIProvider, AIStreamPart } from "@asciimark/ai/types.ts";
import { createAiChatStore } from "./create-ai-chat-store.ts";

/** A controllable provider that replays a fixed list of stream parts. */
function stubProvider(parts: AIStreamPart[]): AIProvider {
  return {
    async *chat() {
      for (const part of parts) yield part;
    },
    async complete() {
      return "";
    },
    async embed() {
      return [];
    },
  };
}

/** A provider that pauses mid-stream so a test can abort between chunks. */
function pausingProvider(): AIProvider {
  return {
    async *chat(_messages, opts) {
      yield { type: "text-delta", text: "par" };
      await new Promise((r) => setTimeout(r, 5));
      if (opts?.signal?.aborted) {
        yield { type: "error", code: "aborted", message: "aborted" };
        return;
      }
      yield { type: "text-delta", text: "tial" };
      yield { type: "done" };
    },
    async complete() {
      return "";
    },
    async embed() {
      return [];
    },
  };
}

describe("createAiChatStore", () => {
  it("accumulates text-delta and consolidates into a message on done", async () => {
    const store = createAiChatStore({
      getProvider: () =>
        stubProvider([
          { type: "text-delta", text: "Hello " },
          { type: "text-delta", text: "world" },
          { type: "done" },
        ]),
    });
    await store.sendMessage("hi");
    expect(store.messages()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello world" },
    ]);
    expect(store.streamingText()).toBe("");
    expect(store.streaming()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it("surfaces a non-aborted error", async () => {
    const store = createAiChatStore({
      getProvider: () =>
        stubProvider([
          { type: "text-delta", text: "partial" },
          { type: "error", code: "network", message: "offline" },
        ]),
    });
    await store.sendMessage("hi");
    expect(store.error()).toEqual({ code: "network", message: "offline" });
    expect(store.streaming()).toBe(false);
  });

  it("does nothing and reports a friendly error when no provider is configured", async () => {
    const store = createAiChatStore({ getProvider: () => null });
    expect(store.providerReady()).toBe(false);
    await store.sendMessage("hi");
    expect(store.messages()).toEqual([]);
    expect(store.error()?.message).toBe("No AI provider configured");
  });

  it("ignores blank input and re-entrant sends", async () => {
    const store = createAiChatStore({
      getProvider: () => stubProvider([{ type: "done" }]),
    });
    await store.sendMessage("   ");
    expect(store.messages()).toEqual([]);
  });

  it("keeps the partial reply on cancel and surfaces no error", async () => {
    const store = createAiChatStore({ getProvider: () => pausingProvider() });
    const pending = store.sendMessage("hi");
    store.cancel();
    await pending;
    expect(store.messages()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "par" },
    ]);
    expect(store.error()).toBeNull();
    expect(store.streaming()).toBe(false);
  });

  it("steering: a message sent while streaming queues, then auto-sends", async () => {
    const store = createAiChatStore({ getProvider: () => pausingProvider() });
    const pending = store.sendMessage("first");
    // Mid-stream: the second send must queue, not interleave a turn.
    await store.sendMessage("second");
    expect(store.queued()).toBe("second");
    await pending;
    // The queue drained into a full second turn after the first settled.
    expect(store.queued()).toBeNull();
    expect(store.messages().map((t) => t.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(store.messages()[2]).toEqual({ role: "user", content: "second" });
  });

  it("steering: cancelQueued drops the pending message; Stop clears it too", async () => {
    const store = createAiChatStore({ getProvider: () => pausingProvider() });
    const pending = store.sendMessage("first");
    await store.sendMessage("queued-then-dropped");
    store.cancelQueued();
    expect(store.queued()).toBeNull();
    await pending;
    expect(store.messages()).toHaveLength(2);

    const second = store.sendMessage("again");
    await store.sendMessage("queued-then-stopped");
    expect(store.queued()).toBe("queued-then-stopped");
    store.cancel(); // Stop aborts the turn AND the queue
    await second;
    expect(store.queued()).toBeNull();
  });

  it("clear() resets history and error", async () => {
    const store = createAiChatStore({
      getProvider: () => stubProvider([{ type: "text-delta", text: "x" }, { type: "done" }]),
    });
    await store.sendMessage("hi");
    store.clear();
    expect(store.messages()).toEqual([]);
    expect(store.error()).toBeNull();
  });

  it("records tool activity and attaches it to the assistant turn", async () => {
    const store = createAiChatStore({
      getProvider: () =>
        stubProvider([
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "ai-memory__memory_query",
            source: "ai-memory",
            args: { q: "x" },
          },
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "ai-memory__memory_query",
            result: { content: [{ type: "text", text: "hit" }] },
          },
          { type: "text-delta", text: "Found it" },
          { type: "done" },
        ]),
    });
    await store.sendMessage("hi");
    const last = store.messages().at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("Found it");
    expect(last.tools).toEqual([
      {
        toolCallId: "c1",
        toolName: "ai-memory__memory_query",
        source: "ai-memory",
        args: { q: "x" },
        status: "done",
        result: { content: [{ type: "text", text: "hit" }] },
      },
    ]);
    // The live signal is cleared once the turn finalizes.
    expect(store.toolActivity()).toEqual([]);
  });

  it("captures the usage part and attaches it to the finalized assistant turn", async () => {
    const store = createAiChatStore({
      getProvider: () =>
        stubProvider([
          { type: "text-delta", text: "hi" },
          { type: "usage", inputTokens: 12, outputTokens: 34, toolCalls: 2 },
          { type: "done" },
        ]),
    });
    await store.sendMessage("q");
    expect(store.messages().at(-1)).toEqual({
      role: "assistant",
      content: "hi",
      usage: { inputTokens: 12, outputTokens: 34, toolCalls: 2 },
    });
  });

  it("attaches no usage key when the stream carries no usage part", async () => {
    const store = createAiChatStore({
      getProvider: () => stubProvider([{ type: "text-delta", text: "hi" }, { type: "done" }]),
    });
    await store.sendMessage("q");
    expect(store.messages().at(-1)).not.toHaveProperty("usage");
  });

  it("marks a tool result carrying isError as error status", async () => {
    const store = createAiChatStore({
      getProvider: () =>
        stubProvider([
          { type: "tool-call", toolCallId: "c1", toolName: "fs__read", args: {} },
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "fs__read",
            result: { isError: true, content: [] },
          },
          { type: "done" },
        ]),
    });
    await store.sendMessage("hi");
    expect(store.messages().at(-1)!.tools?.[0]?.status).toBe("error");
  });

  it("injects getContext into the SENT message but keeps the displayed turn clean", async () => {
    let received: AIMessage[] | undefined;
    const provider: AIProvider = {
      async *chat(messages) {
        received = messages as AIMessage[];
        yield { type: "done" };
      },
      async complete() {
        return "";
      },
      async embed() {
        return [];
      },
    };
    const store = createAiChatStore({ getProvider: () => provider, getContext: () => "CTX-BLOCK" });
    await store.sendMessage("hi");
    // The model receives the context prepended to the last user message…
    expect(received?.at(-1)?.content).toBe("CTX-BLOCK\n\nhi");
    // …but the stored/displayed turn stays clean (no raw context dump).
    expect(store.messages()[0]).toEqual({ role: "user", content: "hi" });
  });

  it("retryLast drops the last assistant turn and streams a fresh reply without duplicating the user turn", async () => {
    // Reply differs per call so the test proves a fresh turn really ran.
    let calls = 0;
    const provider: AIProvider = {
      async *chat() {
        calls += 1;
        yield { type: "text-delta", text: calls === 1 ? "first" : "second" };
        yield { type: "done" };
      },
      async complete() {
        return "";
      },
      async embed() {
        return [];
      },
    };
    const store = createAiChatStore({ getProvider: () => provider });
    await store.sendMessage("hi");
    expect(store.messages()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "first" },
    ]);
    await store.retryLast();
    expect(store.messages()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "second" },
    ]);
    expect(store.messages().filter((t) => t.role === "user")).toHaveLength(1);
    expect(store.streaming()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it("retryLast is a no-op when there are no messages", async () => {
    let calls = 0;
    const provider: AIProvider = {
      async *chat() {
        calls += 1;
        yield { type: "done" };
      },
      async complete() {
        return "";
      },
      async embed() {
        return [];
      },
    };
    const store = createAiChatStore({ getProvider: () => provider });
    await store.retryLast();
    expect(store.messages()).toEqual([]);
    expect(calls).toBe(0);
    expect(store.streaming()).toBe(false);
  });

  it("editAndResend edits a middle user turn: later turns drop and a fresh reply streams", async () => {
    let calls = 0;
    const provider: AIProvider = {
      async *chat() {
        calls += 1;
        yield { type: "text-delta", text: `reply-${calls}` };
        yield { type: "done" };
      },
      async complete() {
        return "";
      },
      async embed() {
        return [];
      },
    };
    const store = createAiChatStore({
      getProvider: () => provider,
      initialMessages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "a2" },
      ],
    });
    await store.editAndResend(2, "q2-edited");
    expect(store.messages()).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2-edited" },
      { role: "assistant", content: "reply-1" },
    ]);
    expect(calls).toBe(1);
    expect(store.streaming()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it("editAndResend guards: an assistant index and blank text are no-ops", async () => {
    let calls = 0;
    const provider: AIProvider = {
      async *chat() {
        calls += 1;
        yield { type: "done" };
      },
      async complete() {
        return "";
      },
      async embed() {
        return [];
      },
    };
    const store = createAiChatStore({
      getProvider: () => provider,
      initialMessages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
      ],
    });
    await store.editAndResend(1, "not a user turn");
    await store.editAndResend(5, "out of range");
    await store.editAndResend(0, "   ");
    expect(store.messages()).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
    expect(calls).toBe(0);
    expect(store.error()).toBeNull();
  });

  it("editAndResend is a no-op while a turn is streaming", async () => {
    const store = createAiChatStore({ getProvider: () => pausingProvider() });
    const pending = store.sendMessage("first");
    expect(store.streaming()).toBe(true);
    await store.editAndResend(0, "edited mid-stream");
    // The in-flight turn is untouched — the original user turn stays put.
    expect(store.messages()[0]).toEqual({ role: "user", content: "first" });
    await pending;
    expect(store.messages()).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "partial" },
    ]);
  });

  it("editAndResend with no provider leaves the history intact (checked BEFORE truncating)", async () => {
    const store = createAiChatStore({
      getProvider: () => null,
      initialMessages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "a2" },
      ],
    });
    await store.editAndResend(0, "edited");
    expect(store.messages()).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ]);
    expect(store.error()?.message).toBe("No AI provider configured");
  });

  it("resolves and forwards tools to the provider chat opts", async () => {
    let receivedTools: unknown;
    const provider: AIProvider = {
      async *chat(_messages, opts) {
        receivedTools = opts?.tools;
        yield { type: "done" };
      },
      async complete() {
        return "";
      },
      async embed() {
        return [];
      },
    };
    const tool = {
      name: "app__noop",
      inputSchema: { type: "object" as const },
      execute: async () => null,
    };
    const store = createAiChatStore({
      getProvider: () => provider,
      getTools: () => [tool],
    });
    await store.sendMessage("hi");
    expect(Array.isArray(receivedTools)).toBe(true);
    expect((receivedTools as Array<{ name: string }>)[0]?.name).toBe("app__noop");
  });
});
