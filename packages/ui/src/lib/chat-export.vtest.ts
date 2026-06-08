import { describe, expect, it } from "vitest";
import { formatChatTranscript, slugifyTitle } from "./chat-export.ts";
import type { ChatTurn } from "../composables/create-ai-chat-store.ts";

describe("formatChatTranscript", () => {
  it("renders a titled transcript with role headings", () => {
    const turns: ChatTurn[] = [
      { role: "user", content: "How do I do X?" },
      { role: "assistant", content: "Like this." },
    ];
    const md = formatChatTranscript("My chat", turns);
    expect(md.startsWith("# My chat\n")).toBe(true);
    expect(md).toContain("## You");
    expect(md).toContain("How do I do X?");
    expect(md).toContain("## Assistant");
    expect(md).toContain("Like this.");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("notes tool calls under the assistant turn", () => {
    const turns: ChatTurn[] = [
      {
        role: "assistant",
        content: "",
        tools: [{ toolCallId: "t1", toolName: "search_docs", source: "memory", status: "done" }],
      },
    ];
    const md = formatChatTranscript("T", turns);
    expect(md).toContain("`search_docs`");
    expect(md).toContain("memory");
    expect(md).toContain("done");
  });

  it("falls back to a default title when blank", () => {
    expect(formatChatTranscript("   ", [])).toContain("# Chat");
  });
});

describe("slugifyTitle", () => {
  it("lowercases, strips punctuation and collapses separators", () => {
    expect(slugifyTitle("My Great Chat!! (v2)")).toBe("my-great-chat-v2");
  });
  it("falls back to 'chat' for empty/symbol-only titles", () => {
    expect(slugifyTitle("   ")).toBe("chat");
    expect(slugifyTitle("***")).toBe("chat");
  });
});
