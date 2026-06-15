import { describe, expect, it } from "bun:test";
import type { CliStreamEvent } from "./cli-bridge.ts";
import { claudeCliEngine } from "./cli-bridge.ts";
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
});