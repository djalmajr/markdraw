// Renders the AI assistant's GitHub-flavored markdown for the chat bubbles.
// Deliberately a SMALL, separate markdown-it instance (not the full preview
// pipeline): chat replies are short and don't need adoc/katex/mermaid.
//
// Security: `html: false` makes markdown-it ESCAPE any raw HTML in the source
// (so a tool result or document echoed into the reply can't inject markup), and
// markdown-it's default link validator already blocks `javascript:`/`vbscript:`
// URLs. That's the standard safe config for rendering LLM output — no separate
// sanitizer pass needed.

import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false, // escape raw HTML — never inject model/tool markup verbatim
  linkify: true, // turn bare URLs into links
  breaks: true, // treat single newlines as <br> (chat-friendly)
});

/** Render assistant markdown to a safe HTML string. */
export function renderChatMarkdown(source: string): string {
  return md.render(source ?? "");
}
