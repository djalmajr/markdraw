import { describe, expect, it } from "bun:test";
import { needsApproval, resolveApprovalTier, withApproval } from "./approval-policy.ts";
import type { AITool } from "./types.ts";

const tool = (over: Partial<AITool>): AITool => ({
  name: "t",
  inputSchema: { type: "object" },
  execute: async () => null,
  ...over,
});

describe("resolveApprovalTier", () => {
  it("honors an explicit approval tier", () => {
    expect(resolveApprovalTier(tool({ approval: "prompt", source: "app" }))).toBe("prompt");
    expect(resolveApprovalTier(tool({ approval: "auto", source: "some-mcp" }))).toBe("auto");
  });

  it("auto-runs in-process app tools", () => {
    expect(resolveApprovalTier(tool({ source: "app" }))).toBe("auto");
  });

  it("prompts for MCP / unknown-source tools by default", () => {
    expect(resolveApprovalTier(tool({ source: "ai-memory" }))).toBe("prompt");
    expect(resolveApprovalTier(tool({}))).toBe("prompt"); // no source -> prompt
  });
});

describe("needsApproval", () => {
  it("is true exactly when the tier is prompt", () => {
    expect(needsApproval(tool({ source: "ai-memory" }))).toBe(true);
    expect(needsApproval(tool({ source: "app" }))).toBe(false);
    expect(needsApproval(tool({ source: "app", approval: "prompt" }))).toBe(true);
  });
});

describe("withApproval", () => {
  it("returns auto-tier tools unchanged (no wrapper)", () => {
    const t = tool({ source: "app" });
    expect(withApproval(t, async () => true)).toBe(t);
  });

  it("executes a prompt-tier tool when approved, threading opts", async () => {
    let executedWith: unknown;
    const t = tool({
      source: "ai-memory",
      execute: async (args) => {
        executedWith = args;
        return { ok: true };
      },
    });
    const wrapped = withApproval(t, async () => true);
    const result = await wrapped.execute({ q: 1 });
    expect(result).toEqual({ ok: true });
    expect(executedWith).toEqual({ q: 1 });
  });

  it("skips execution and returns a rejection result when denied", async () => {
    let ran = false;
    const t = tool({
      source: "ai-memory",
      execute: async () => {
        ran = true;
        return "should-not-run";
      },
    });
    const wrapped = withApproval(t, async () => false);
    const result = await wrapped.execute({});
    expect(ran).toBe(false);
    expect(result).toEqual({ rejected: true, error: 'User rejected the "t" tool call.' });
  });

  it("passes the request details to the approver", async () => {
    let seen: unknown;
    const t = tool({ name: "ai-memory__q", source: "ai-memory" });
    const wrapped = withApproval(t, async (req) => {
      seen = req;
      return true;
    });
    await wrapped.execute({ a: 1 });
    expect(seen).toEqual({ toolName: "ai-memory__q", source: "ai-memory", args: { a: 1 } });
  });
});
