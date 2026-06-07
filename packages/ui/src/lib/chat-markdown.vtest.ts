import { describe, expect, it } from "vitest";
import { renderChatMarkdown } from "./chat-markdown.ts";

describe("renderChatMarkdown", () => {
  it("renders basic markdown to HTML", () => {
    const html = renderChatMarkdown("# Title\n\nSome **bold** and `code`.");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("renders lists", () => {
    const html = renderChatMarkdown("- a\n- b");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>a</li>");
  });

  it("escapes raw HTML (no injection from model/tool output)", () => {
    const html = renderChatMarkdown('Hi <img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("does not emit a javascript: href (markdown-it rejects the URL)", () => {
    const html = renderChatMarkdown("[click](javascript:alert(1))");
    expect(html).not.toMatch(/href=["']?javascript:/i);
  });

  it("handles empty / nullish input", () => {
    expect(renderChatMarkdown("")).toBe("");
    expect(renderChatMarkdown(undefined as unknown as string)).toBe("");
  });
});
