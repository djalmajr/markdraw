import { describe, expect, it } from "vitest";
import type { AIMessage, AIProvider, AIStreamPart } from "@markdraw/ai/types.ts";
import type { PersistedAdvisorNote } from "@markdraw/core/ai-chat-sessions.ts";
import { createAiChatStore, type ChatTurn } from "./create-ai-chat-store.ts";

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

  it("replaces cumulative text-delta snapshots instead of duplicating them", async () => {
    const store = createAiChatStore({
      getProvider: () =>
        stubProvider([
          { type: "text-delta", text: "Hel" },
          { type: "text-delta", text: "Hello" },
          { type: "done" },
        ]),
    });
    await store.sendMessage("hi");
    expect(store.messages().at(-1)).toEqual({ role: "assistant", content: "Hello" });
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

  it("does not replace a provider error with host validation", async () => {
    let validations = 0;
    const store = createAiChatStore({
      getProvider: () =>
        stubProvider([
          { type: "text-delta", text: "partial" },
          { type: "error", code: "network", message: "offline" },
        ]),
      validateAssistantTurn: () => {
        validations += 1;
        return "Tool call required.";
      },
    });

    await store.sendMessage("create a file");

    expect(validations).toBe(0);
    expect(store.error()).toEqual({ code: "network", message: "offline" });
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

  it("does not run host validation after a user abort", async () => {
    let validations = 0;
    const store = createAiChatStore({
      getProvider: () => pausingProvider(),
      validateAssistantTurn: () => {
        validations += 1;
        return "Tool call required.";
      },
    });

    const pending = store.sendMessage("hi");
    store.cancel();
    await pending;

    expect(validations).toBe(0);
    expect(store.error()).toBeNull();
  });

  it("steering: a message sent while streaming queues, then auto-sends; its promise settles only after its turn ran", async () => {
    const store = createAiChatStore({ getProvider: () => pausingProvider() });
    const pending = store.sendMessage("first");
    // Mid-stream: the second send must queue, not interleave a turn.
    let steeredSettled = false;
    const steered = store.sendMessage("second").then(() => {
      steeredSettled = true;
    });
    expect(store.queued()).toBe("second");
    // The steering sender must NOT settle at queue time — callers release the
    // message's context (mention chips) on settlement, and the context
    // preamble is only read when the queued turn actually runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(steeredSettled).toBe(false);
    await pending;
    // The queue drained into a full second turn after the first settled.
    expect(store.queued()).toBeNull();
    await steered;
    expect(steeredSettled).toBe(true);
    expect(store.messages().map((t) => t.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(store.messages()[2]).toEqual({ role: "user", content: "second" });
  });

  it("steering: cancelQueued drops the pending message and settles its sender; Stop clears it too", async () => {
    const store = createAiChatStore({ getProvider: () => pausingProvider() });
    const pending = store.sendMessage("first");
    const dropped = store.sendMessage("queued-then-dropped");
    store.cancelQueued();
    expect(store.queued()).toBeNull();
    // The dropped sender's promise settles on cancellation — its turn will
    // never run, and an unsettled promise would leak the caller's cleanup.
    await dropped;
    await pending;
    expect(store.messages()).toHaveLength(2);

    const second = store.sendMessage("again");
    const stopped = store.sendMessage("queued-then-stopped");
    expect(store.queued()).toBe("queued-then-stopped");
    store.cancel(); // Stop aborts the turn AND the queue
    await stopped;
    await second;
    expect(store.queued()).toBeNull();
  });

  it("steering: a replacement send settles the displaced sender; only the replacement runs", async () => {
    const store = createAiChatStore({ getProvider: () => pausingProvider() });
    const pending = store.sendMessage("first");
    const displaced = store.sendMessage("will-be-replaced");
    // One slot: the newer steering send displaces (and settles) the older one.
    const kept = store.sendMessage("replacement");
    expect(store.queued()).toBe("replacement");
    await displaced;
    await pending;
    await kept;
    expect(store.messages().map((t) => t.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(store.messages()[2]).toEqual({ role: "user", content: "replacement" });
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

  it("stores oversized tool results as artifacts with an inline preview", async () => {
    const writes: Array<{ content: string; kind: string; mime: string; title: string; toolCallId?: string }> = [];
    const hugeResult = "x".repeat(9_000);
    const store = createAiChatStore({
      getProvider: () =>
        stubProvider([
          { type: "tool-call", toolCallId: "c1", toolName: "app__search_workspace", args: {} },
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "app__search_workspace",
            result: hugeResult,
          },
          { type: "done" },
        ]),
      writeArtifact: async (input) => {
        writes.push(input);
        return {
          byteLength: input.content.length,
          id: "artifact-1",
          kind: input.kind,
          mime: input.mime,
          title: input.title,
        };
      },
    });

    await store.sendMessage("hi");

    expect(writes).toEqual([
      {
        content: hugeResult,
        kind: "tool-result",
        mime: "text/plain",
        title: "app__search_workspace",
        toolCallId: "c1",
      },
    ]);
    const tool = store.messages().at(-1)?.tools?.[0];
    expect(tool?.result).toEqual({
      artifactId: "artifact-1",
      byteLength: hugeResult.length,
      preview: hugeResult.slice(0, 2_000),
      truncated: true,
    });
    expect(tool?.resultArtifact).toEqual({
      byteLength: hugeResult.length,
      id: "artifact-1",
      kind: "tool-result",
      mime: "text/plain",
      title: "app__search_workspace",
    });
  });

  it("surfaces a host validation error while keeping the assistant text visible", async () => {
    const store = createAiChatStore({
      getProvider: () =>
        stubProvider([{ type: "text-delta", text: "Vou criar o arquivo." }, { type: "done" }]),
      validateAssistantTurn: () => "Tool call required.",
    });
    await store.sendMessage("crie um arquivo");
    expect(store.error()).toEqual({ code: "unknown", message: "Tool call required." });
    expect(store.messages().at(-1)).toEqual({
      role: "assistant",
      content: "Vou criar o arquivo.",
    });
  });

  it("attaches advisor notes after a successful assistant turn", async () => {
    const store = createAiChatStore({
      getProvider: () =>
        stubProvider([{ type: "text-delta", text: "Done" }, { type: "done" }]),
      adviseAssistantTurn: async () => [
        {
          id: "advisor-1",
          message: "Check that the file was actually written.",
          severity: "warning",
          title: "Advisor",
        },
      ],
    });

    await store.sendMessage("hi");

    expect(store.messages().at(-1)).toEqual({
      advisorNotes: [
        {
          id: "advisor-1",
          message: "Check that the file was actually written.",
          severity: "warning",
          title: "Advisor",
        },
      ],
      content: "Done",
      role: "assistant",
    });
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
    let contextRequest: { history: unknown[]; userMessage: string } | undefined;
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
    const store = createAiChatStore({
      getProvider: () => provider,
      getContext: (request) => {
        contextRequest = request;
        return "CTX-BLOCK";
      },
    });
    await store.sendMessage("hi");
    expect(contextRequest?.userMessage).toBe("hi");
    expect(contextRequest?.history).toHaveLength(1);
    // The model receives the context prepended to the last user message…
    expect(received?.at(-1)?.content).toBe("CTX-BLOCK\n\nhi");
    // …but the stored/displayed turn stays clean (no raw context dump).
    expect(store.messages()[0]).toEqual({ role: "user", content: "hi" });
  });

  it("stores context metadata for the user turn without storing raw context content", async () => {
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
    const store = createAiChatStore({
      getProvider: () => provider,
      getContext: () => ({
        preamble: "RAW CONTEXT CONTENT",
        items: [
          {
            kind: "folder",
            label: "playwright/",
            path: "output/playwright",
            rootPath: "/repo",
            absolutePath: "/repo/output/playwright",
          },
        ],
      }),
    });
    await store.sendMessage("create here");
    expect(received?.at(-1)?.content).toBe("RAW CONTEXT CONTENT\n\ncreate here");
    expect(store.messages()[0]).toEqual({
      role: "user",
      content: "create here",
      context: [
        {
          kind: "folder",
          label: "playwright/",
          path: "output/playwright",
          rootPath: "/repo",
          absolutePath: "/repo/output/playwright",
        },
      ],
    });
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

  it("compactHistory replaces older turns with a visible summary", () => {
    const initialMessages: ChatTurn[] = Array.from({ length: 45 }, (_, index) => {
      if (index === 3) {
        return {
          role: "assistant",
          content: `message-${index}`,
          tools: [
            {
              toolCallId: "tool-1",
              toolName: "app__read_file",
              status: "done",
            },
          ],
        };
      }
      return index % 2 === 0
        ? { role: "user", content: `message-${index}` }
        : { role: "assistant", content: `message-${index}` };
    });
    const store = createAiChatStore({
      getProvider: () => stubProvider([{ type: "done" }]),
      initialMessages,
    });

    store.compactHistory();

    const compacted = store.messages();
    expect(compacted).toHaveLength(41);
    expect(compacted[0]).toMatchObject({
      role: "assistant",
      kind: "compaction",
    });
    expect(compacted[0]!.content).toContain("Compacted 5 older chat turns.");
    expect(compacted[0]!.content).toContain("Tools used earlier: app__read_file");
    expect(compacted.at(-1)).toEqual({ role: "user", content: "message-44" });
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

  it("sends the compaction summary as a user turn so the outgoing history starts with role user", async () => {
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
    const store = createAiChatStore({
      getProvider: () => provider,
      initialMessages: [
        { role: "assistant", kind: "compaction", content: "Compacted 5 older chat turns." },
        { role: "assistant", content: "a1" },
      ],
    });
    await store.sendMessage("next");
    // Anthropic rejects an assistant-first /messages request — the compaction
    // recap must be SENT as a user turn.
    expect(received?.[0]).toEqual({ role: "user", content: "Compacted 5 older chat turns." });
    // The stored/displayed turn keeps its assistant role + compaction kind.
    expect(store.messages()[0]).toEqual({
      role: "assistant",
      kind: "compaction",
      content: "Compacted 5 older chat turns.",
    });
  });

  it("commits the answer and stops streaming before the advisor resolves; notes attach after", async () => {
    let resolveAdvisor: ((notes: PersistedAdvisorNote[]) => void) | undefined;
    const store = createAiChatStore({
      getProvider: () => stubProvider([{ type: "text-delta", text: "Done" }, { type: "done" }]),
      adviseAssistantTurn: () =>
        new Promise<PersistedAdvisorNote[]>((resolve) => {
          resolveAdvisor = resolve;
        }),
    });
    let settled = false;
    const pending = store.sendMessage("hi").then(() => {
      settled = true;
    });
    // Drain until the turn finalizes; the advisor promise stays pending.
    for (let i = 0; i < 20 && (store.streaming() || !resolveAdvisor); i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    // The answer is committed and streaming stopped even though the advisor has
    // not resolved (and sendMessage's promise is still pending).
    expect(store.streaming()).toBe(false);
    expect(store.messages().at(-1)).toEqual({ role: "assistant", content: "Done" });
    expect(settled).toBe(false);
    // Once the advisor resolves, its notes patch the committed turn.
    resolveAdvisor!([{ id: "n1", message: "check", severity: "info", title: "Advisor" }]);
    await pending;
    expect(settled).toBe(true);
    expect(store.messages().at(-1)).toEqual({
      role: "assistant",
      content: "Done",
      advisorNotes: [{ id: "n1", message: "check", severity: "info", title: "Advisor" }],
    });
  });

  it("fires onAssistantTurn on a completed turn even when validation reports an error", async () => {
    const seen: string[] = [];
    const store = createAiChatStore({
      getProvider: () => stubProvider([{ type: "text-delta", text: "PLAN" }, { type: "done" }]),
      validateAssistantTurn: () => "Tool call required.",
      onAssistantTurn: (content) => seen.push(content),
    });
    await store.sendMessage("design X");
    // The validation error is surfaced…
    expect(store.error()).toEqual({ code: "unknown", message: "Tool call required." });
    // …but the completed text is still handed to onAssistantTurn (the plan write
    // is decoupled from the validation gate).
    expect(seen).toEqual(["PLAN"]);
  });

  it("does not fire onAssistantTurn when the turn is aborted before completing", async () => {
    const seen: string[] = [];
    const store = createAiChatStore({
      getProvider: () => pausingProvider(),
      onAssistantTurn: (content) => seen.push(content),
    });
    const pending = store.sendMessage("hi");
    store.cancel();
    await pending;
    expect(seen).toEqual([]);
    // The partial reply is still kept as history.
    expect(store.messages().at(-1)).toEqual({ role: "assistant", content: "par" });
  });

  it("clear() drops a queued validation reminder so it does not leak into the next conversation", async () => {
    const sent: string[] = [];
    let validations = 0;
    const provider: AIProvider = {
      async *chat(messages) {
        sent.push((messages.at(-1)?.content as string) ?? "");
        yield { type: "text-delta", text: "reply" };
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
      validateAssistantTurn: () => {
        validations += 1;
        // Only the first turn queues a reminder.
        return validations === 1
          ? { message: "Tool call required.", reminder: "REMINDER-TEXT", signature: "sig" }
          : undefined;
      },
    });
    await store.sendMessage("first");
    store.clear();
    await store.sendMessage("second");
    // The reminder queued by the (cleared) first conversation must not prepend to
    // the fresh conversation's first outgoing message.
    expect(sent.at(-1)).toBe("second");
    expect(sent.at(-1)).not.toContain("REMINDER-TEXT");
  });

  it("compacts only the OUTGOING context on a long thread; the stored transcript is preserved", async () => {
    let received: AIMessage[] | undefined;
    const provider: AIProvider = {
      async *chat(messages) {
        received = messages as AIMessage[];
        yield { type: "text-delta", text: "ok" };
        yield { type: "done" };
      },
      async complete() {
        return "";
      },
      async embed() {
        return [];
      },
    };
    const initial: ChatTurn[] = Array.from({ length: 122 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `m${i}`,
    }));
    const store = createAiChatStore({ getProvider: () => provider, initialMessages: initial });
    await store.sendMessage("next");
    // The full transcript stays durable — nothing dropped from messages().
    expect(store.messages().length).toBe(124);
    expect(store.messages()[0]).toEqual({ role: "user", content: "m0" });
    expect(store.messages().at(-1)).toEqual({ role: "assistant", content: "ok" });
    // The model received a COMPACTED view (summary + last 40 turns), starting
    // with the compaction recap as a user turn.
    expect(received!.length).toBe(41);
    expect(received![0]!.role).toBe("user");
    expect(received![0]!.content).toContain("Compacted");
  });
});
