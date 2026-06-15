import { describe, expect, it } from "bun:test";
import type { CliStreamEvent } from "./cli-bridge.ts";
import { antigravityCliEngine, claudeCliEngine, grokCliEngine } from "./cli-bridge.ts";
import type { ResolvedModel } from "../resolve-model.ts";

const resolved: ResolvedModel = {
  id: "claude-sub/claude-sonnet-4-6",
  providerId: "claude-sub",
  modelId: "claude-sonnet-4-6",
  provider: {
    kind: "claude-cli",
    name: "Claude (subscription)",
    models: { "claude-sonnet-4-6": { name: "Claude Sonnet 4.6" } },
  },
  model: { name: "Claude Sonnet 4.6" },
};

describe("cli-bridge", () => {
  it("parses Claude assistant JSONL into text deltas", async () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello" }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    ];
    const provider = claudeCliEngine.createProvider(resolved, async () => undefined, {
      cliHost: {
        streamChat: async (_req, onEvent) => {
          for (const line of lines) {
            onEvent({ type: "line", line });
          }
          onEvent({ type: "done" });
        },
      },
    });

    const parts = [];
    for await (const part of provider.chat([{ role: "user", content: "hi" }])) {
      parts.push(part);
    }
    expect(parts.some((p) => p.type === "text-delta" && p.text === "Hello")).toBe(true);
    expect(parts.some((p) => p.type === "done")).toBe(true);
  });

  it("surfaces CLI transport errors", async () => {
    const provider = claudeCliEngine.createProvider(resolved, async () => undefined, {
      cliHost: {
        streamChat: async (_req, onEvent) => {
          onEvent({ type: "error", message: "CLI exited" } satisfies CliStreamEvent);
        },
      },
    });
    const parts = [];
    for await (const part of provider.chat([{ role: "user", content: "hi" }])) {
      parts.push(part);
    }
    expect(parts.some((p) => p.type === "error" && p.message === "CLI exited")).toBe(true);
  });

  it("parses Grok streaming-json chunks into incremental text deltas", async () => {
    const grokResolved: ResolvedModel = {
      id: "grok-sub/grok-composer-2.5-fast",
      providerId: "grok-sub",
      modelId: "grok-composer-2.5-fast",
      provider: {
        kind: "grok-cli",
        name: "Grok (subscription)",
        models: { "grok-composer-2.5-fast": { name: "Grok Composer 2.5 Fast" } },
      },
      model: { name: "Grok Composer 2.5 Fast" },
    };
    const lines = [
      JSON.stringify({ type: "text", data: "Hello" }),
      JSON.stringify({ type: "thought", data: "thinking..." }),
      JSON.stringify({ type: "text", data: " world" }),
      JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "abc123" }),
    ];
    const provider = grokCliEngine.createProvider(grokResolved, async () => undefined, {
      cliHost: {
        streamChat: async (_req, onEvent) => {
          for (const line of lines) onEvent({ type: "line", line });
          onEvent({ type: "done" });
        },
      },
    });

    const text = await provider.complete("hi");
    expect(text).toBe("Hello world");
  });

  it("parses Antigravity plain-text stdout lines into the response", async () => {
    const agyResolved: ResolvedModel = {
      id: "antigravity-sub/Gemini 3.5 Flash (Medium)",
      providerId: "antigravity-sub",
      modelId: "Gemini 3.5 Flash (Medium)",
      provider: {
        kind: "antigravity-cli",
        name: "Antigravity (subscription)",
        models: { "Gemini 3.5 Flash (Medium)": { name: "Gemini 3.5 Flash (Medium)" } },
      },
      model: { name: "Gemini 3.5 Flash (Medium)" },
    };
    // agy --print emits PLAIN text (not JSON) — each stdout line is response text.
    const lines = ["Hello,", "world."];
    const provider = antigravityCliEngine.createProvider(agyResolved, async () => undefined, {
      cliHost: {
        streamChat: async (_req, onEvent) => {
          for (const line of lines) onEvent({ type: "line", line });
          onEvent({ type: "done" });
        },
      },
    });

    const text = await provider.complete("hi");
    expect(text).toBe("Hello,\nworld.\n");
  });
});