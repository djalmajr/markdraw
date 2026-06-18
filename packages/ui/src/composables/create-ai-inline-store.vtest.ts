import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, AIStreamPart } from "@markdraw/ai/types.ts";
import { createAiInlineStore } from "./create-ai-inline-store.ts";

// The store lazy-imports mermaid only to validate generated DSL — mock it like
// other heavy deps (pdfjs in media-viewer.vtest) so the suite stays light.
const mermaidParse = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({ default: { parse: mermaidParse } }));

function stubProvider(parts: AIStreamPart[]): AIProvider {
  return {
    async *chat() {
      for (const p of parts) yield p;
    },
    async complete() {
      return "";
    },
    async embed() {
      return [];
    },
  };
}

const SEL = { from: 5, to: 16, text: "hello world" };

describe("createAiInlineStore", () => {
  it("opens in the menu state with the captured selection", () => {
    const store = createAiInlineStore({ getProvider: () => stubProvider([]) });
    store.openFor(SEL, { left: 10, top: 20, bottom: 30 }, () => {});
    expect(store.open()).toBe(true);
    expect(store.status()).toBe("menu");
    expect(store.selection()).toEqual(SEL);
    expect(store.anchor()).toEqual({ left: 10, top: 20, bottom: 30 });
  });

  it("streams an action result and reaches done", async () => {
    const store = createAiInlineStore({
      getProvider: () =>
        stubProvider([
          { type: "text-delta", text: "Hello " },
          { type: "text-delta", text: "World" },
          { type: "done" },
        ]),
    });
    store.openFor(SEL, null, () => {});
    await store.run("rewrite");
    expect(store.result()).toBe("Hello World");
    expect(store.status()).toBe("done");
    expect(store.action()).toBe("rewrite");
  });

  it("accept() replaces the selection range for a replace-mode action", async () => {
    const replace = vi.fn();
    const store = createAiInlineStore({
      getProvider: () => stubProvider([{ type: "text-delta", text: "Olá mundo" }, { type: "done" }]),
    });
    store.openFor(SEL, null, replace);
    await store.run("translate", "pt-BR");
    store.accept();
    expect(replace).toHaveBeenCalledWith(5, 16, "Olá mundo");
    expect(store.open()).toBe(false);
  });

  it("accept() inserts after the selection for summarize (insert mode)", async () => {
    const replace = vi.fn();
    const store = createAiInlineStore({
      getProvider: () => stubProvider([{ type: "text-delta", text: "A summary" }, { type: "done" }]),
    });
    store.openFor(SEL, null, replace);
    await store.run("summarize");
    store.accept();
    expect(replace).toHaveBeenCalledWith(16, 16, "\n\nA summary");
  });

  it("surfaces a provider error", async () => {
    const store = createAiInlineStore({
      getProvider: () => stubProvider([{ type: "error", code: "auth", message: "bad key" }]),
    });
    store.openFor(SEL, null, () => {});
    await store.run("rewrite");
    expect(store.status()).toBe("error");
    expect(store.error()).toBe("bad key");
  });

  it("reports a friendly error when no provider is configured", async () => {
    const store = createAiInlineStore({ getProvider: () => null });
    store.openFor(SEL, null, () => {});
    await store.run("rewrite");
    expect(store.status()).toBe("error");
    expect(store.error()).toContain("No AI provider");
  });

  it("close() resets everything", async () => {
    const store = createAiInlineStore({
      getProvider: () => stubProvider([{ type: "text-delta", text: "x" }, { type: "done" }]),
    });
    store.openFor(SEL, null, () => {});
    await store.run("rewrite");
    store.close();
    expect(store.open()).toBe(false);
    expect(store.result()).toBe("");
    expect(store.selection()).toBeNull();
  });
});

describe("createAiInlineStore diagram validation", () => {
  const TARGET = { contentFrom: 4, contentTo: 4, isEmpty: true, existingSource: "" };

  beforeEach(() => {
    mermaidParse.mockReset();
  });

  it("valid DSL passes mermaid.parse and accept() inserts it", async () => {
    mermaidParse.mockResolvedValue({ diagramType: "flowchart" });
    const replace = vi.fn();
    const store = createAiInlineStore({
      getProvider: () =>
        stubProvider([
          { type: "text-delta", text: "```mermaid\nflowchart TD\n  A-->B\n```" },
          { type: "done" },
        ]),
    });
    store.openForDiagram(TARGET, null, replace);
    await store.runDiagram("two boxes");
    expect(store.status()).toBe("done");
    expect(mermaidParse).toHaveBeenCalledWith("flowchart TD\n  A-->B");
    store.accept();
    expect(replace).toHaveBeenCalledWith(4, 4, "flowchart TD\n  A-->B\n");
    expect(store.open()).toBe(false);
  });

  it("invalid DSL is never inserted and surfaces the generic error", async () => {
    mermaidParse.mockRejectedValue(new Error("Parse error on line 2"));
    const replace = vi.fn();
    const store = createAiInlineStore({
      getProvider: () =>
        stubProvider([{ type: "text-delta", text: "flowchart TD\n  A--" }, { type: "done" }]),
    });
    store.openForDiagram(TARGET, null, replace);
    await store.runDiagram("two boxes");
    expect(store.status()).toBe("error");
    expect(store.error()).toContain("Something went wrong");
    store.accept();
    expect(replace).not.toHaveBeenCalled();
  });

  it("a response with no extractable diagram is treated as invalid", async () => {
    const replace = vi.fn();
    const store = createAiInlineStore({
      getProvider: () =>
        stubProvider([{ type: "text-delta", text: "Sorry, I cannot help." }, { type: "done" }]),
    });
    store.openForDiagram(TARGET, null, replace);
    await store.runDiagram("two boxes");
    expect(store.status()).toBe("error");
    expect(mermaidParse).not.toHaveBeenCalled();
    store.accept();
    expect(replace).not.toHaveBeenCalled();
  });
});
