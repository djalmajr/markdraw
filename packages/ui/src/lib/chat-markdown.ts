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
import { isSupportedFile } from "@markdraw/core/utils.ts";

const md = new MarkdownIt({
  html: false, // escape raw HTML — never inject model/tool markup verbatim
  linkify: true, // turn bare URLs into links
  breaks: true, // treat single newlines as <br> (chat-friendly)
});

const DOC_PATH_RE =
  /(?:\.{1,2}\/|\/)?(?:[\w@~.-]+\/)+[\w@~.-]+\.(?:adoc\.txt|asciidoc|markdown|mdown|adoc|asc|ad|md)(?::\d+(?::\d+)?)?(?:#[\w%.-]+)?/gi;

function stripDocumentLocationSuffix(path: string): string {
  const hashIdx = path.indexOf("#");
  const base = hashIdx >= 0 ? path.slice(0, hashIdx) : path;
  const fragment = hashIdx >= 0 ? path.slice(hashIdx) : "";
  return base.replace(
    /(\.(?:adoc\.txt|asciidoc|markdown|mdown|adoc|asc|ad|md)):\d+(?::\d+)?$/i,
    "$1",
  ) + fragment;
}

function isDocumentPathCandidate(path: string): boolean {
  if (!path.includes("/")) return false;
  const noFragment = stripDocumentLocationSuffix(path).split("#")[0] ?? "";
  return isSupportedFile(noFragment);
}

function linkDocumentPaths(state: any): void {
  for (const blockToken of state.tokens) {
    const children = blockToken.children;
    if (!children) continue;
    const nextChildren: any[] = [];
    let linkDepth = 0;

    for (const child of children) {
      if (child.type === "link_open") linkDepth += 1;
      if (child.type === "link_close") linkDepth = Math.max(0, linkDepth - 1);
      if (child.type !== "text" || linkDepth > 0) {
        nextChildren.push(child);
        continue;
      }

      const text = child.content ?? "";
      DOC_PATH_RE.lastIndex = 0;
      let lastIdx = 0;
      let match: RegExpExecArray | null;
      let changed = false;

      while ((match = DOC_PATH_RE.exec(text))) {
        const candidate = match[0];
        if (!isDocumentPathCandidate(candidate)) continue;
        changed = true;
        if (match.index > lastIdx) {
          const t = new state.Token("text", "", 0);
          t.content = text.slice(lastIdx, match.index);
          nextChildren.push(t);
        }
        const open = new state.Token("link_open", "a", 1);
        open.attrSet("href", candidate);
        nextChildren.push(open);
        const label = new state.Token("text", "", 0);
        label.content = candidate;
        nextChildren.push(label);
        nextChildren.push(new state.Token("link_close", "a", -1));
        lastIdx = match.index + candidate.length;
      }

      if (!changed) {
        nextChildren.push(child);
        continue;
      }
      if (lastIdx < text.length) {
        const t = new state.Token("text", "", 0);
        t.content = text.slice(lastIdx);
        nextChildren.push(t);
      }
    }

    blockToken.children = nextChildren;
  }
}

// Fuzzy linkify treats anything shaped like a domain as a URL — and `.md` is
// Moldova's TLD, so plain file names like `README.md` became live links to
// parked spam domains. Require an explicit scheme (https://…) instead.
md.linkify.set({ fuzzyLink: false });
md.core.ruler.after("inline", "markdraw_document_path_links", linkDocumentPaths);

const originalCodeInline =
  md.renderer.rules.code_inline
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
  const content = tokens[idx]?.content ?? "";
  DOC_PATH_RE.lastIndex = 0;
  if (DOC_PATH_RE.test(content) && isDocumentPathCandidate(content)) {
    const escaped = md.utils.escapeHtml(content);
    const href = md.utils.escapeHtml(content);
    return `<a href="${href}"><code>${escaped}</code></a>`;
  }
  return originalCodeInline(tokens, idx, options, env, self);
};

/** Render assistant markdown to a safe HTML string. */
export function renderChatMarkdown(source: string): string {
  return md.render(source ?? "");
}
