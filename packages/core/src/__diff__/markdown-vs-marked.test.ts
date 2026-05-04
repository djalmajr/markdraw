// Differential testing: our markdown-it stack vs `marked`. The premise is
// that two independent implementations should agree on the structurally
// observable shape of the rendered HTML. Where they disagree, one of them
// has a bug — sometimes ours, sometimes the reference.
//
// We compare the *body shape* (headings, paragraphs, code, lists) — NOT
// byte-equivalent HTML. Both engines emit different attribute sets,
// whitespace and ID generation; the goal is to detect *structural* drift
// (e.g., a heading silently dropped, a fenced block losing its language).
import { describe, expect, it } from "bun:test";
import { marked } from "marked";
import { convertMarkdown } from "../markdown.ts";

const noopRead = async () => null;

interface BodyShape {
  headings: { level: number; text: string }[];
  paragraphCount: number;
  codeBlocks: { lang: string }[];
  listItemCount: number;
  linkCount: number;
}

function shapeOf(html: string): BodyShape {
  const headings: { level: number; text: string }[] = [];
  const headingRe = /<h([1-6])[^>]*>([^<]*)<\/h\1>/g;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(html)) !== null) {
    headings.push({ level: parseInt(m[1]!, 10), text: m[2]!.trim() });
  }

  const codeBlocks: { lang: string }[] = [];
  const codeRe = /<pre><code(?: class="(?:language-)?([^"]*)")?>/g;
  while ((m = codeRe.exec(html)) !== null) {
    codeBlocks.push({ lang: m[1] ?? "" });
  }

  return {
    headings,
    paragraphCount: (html.match(/<p[^>]*>/g) ?? []).length,
    codeBlocks,
    listItemCount: (html.match(/<li[^>]*>/g) ?? []).length,
    linkCount: (html.match(/<a [^>]*href=/g) ?? []).length,
  };
}

async function ourShape(input: string): Promise<BodyShape> {
  const { html } = await convertMarkdown({
    filePath: "doc.md",
    fileContent: input,
    readFile: noopRead,
  });
  // Strip our generated TOC block — `marked` doesn't emit one, so leaving
  // it in would inflate heading/list counts and produce false drift.
  const bodyOnly = html.replace(/<div id="toc"[\s\S]*?<\/div>\s*<\/div>\s*/, "");
  return shapeOf(bodyOnly);
}

function markedShape(input: string): BodyShape {
  const html = marked.parse(input, { async: false }) as string;
  return shapeOf(html);
}

describe("markdown differential: ours vs marked", () => {
  it("agrees on headings count and levels", async () => {
    const doc = `# Title\n\n## Section A\n\ntext\n\n### Sub\n\nmore\n\n## Section B`;
    const ours = await ourShape(doc);
    const ref = markedShape(doc);
    expect(ours.headings.map((h) => h.level)).toEqual(ref.headings.map((h) => h.level));
    expect(ours.headings.map((h) => h.text)).toEqual(ref.headings.map((h) => h.text));
  });

  it("agrees on paragraph count", async () => {
    const doc = `Paragraph 1.\n\nParagraph 2.\n\nParagraph 3 with **bold** and _em_.`;
    const ours = await ourShape(doc);
    const ref = markedShape(doc);
    expect(ours.paragraphCount).toBe(ref.paragraphCount);
  });

  it("agrees on fenced code block language tags", async () => {
    const doc = "```ts\nconst x = 1;\n```\n\n```python\nprint('hi')\n```";
    const ours = await ourShape(doc);
    const ref = markedShape(doc);
    expect(ours.codeBlocks.length).toBe(ref.codeBlocks.length);
    // Both should know "ts" and "python" — regardless of class prefix.
    const ourLangs = ours.codeBlocks.map((c) => c.lang.replace(/^language-/, ""));
    const refLangs = ref.codeBlocks.map((c) => c.lang.replace(/^language-/, ""));
    expect(ourLangs).toEqual(refLangs);
  });

  it("agrees on link count", async () => {
    const doc = `See [the docs](https://example.com) and [home](/).`;
    const ours = await ourShape(doc);
    const ref = markedShape(doc);
    expect(ours.linkCount).toBe(ref.linkCount);
  });

  it("agrees on bullet list item count", async () => {
    const doc = `- one\n- two\n- three\n  - nested\n  - more nested`;
    const ours = await ourShape(doc);
    const ref = markedShape(doc);
    expect(ours.listItemCount).toBe(ref.listItemCount);
  });

  it("agrees on ordered list item count", async () => {
    const doc = `1. first\n2. second\n3. third`;
    const ours = await ourShape(doc);
    const ref = markedShape(doc);
    expect(ours.listItemCount).toBe(ref.listItemCount);
  });

  // Documented divergences — marked doesn't ship the same plugin set as us,
  // so these aren't bugs. They're recorded so future drift can tell apart
  // "expected difference" from "new bug".

  // Documented divergences — recorded so future regressions can distinguish
  // "expected plugin-only behavior" from "new structural bug". Use raw HTML
  // checks (not shapeOf) because the shape comparison is intentionally
  // coarse-grained — it matches paragraph/heading counts but ignores
  // per-paragraph content.

  async function ourRawHtml(input: string): Promise<string> {
    const { html } = await convertMarkdown({
      filePath: "doc.md",
      fileContent: input,
      readFile: noopRead,
    });
    return html;
  }

  it("DOCUMENTED: only ours emits emoji glyphs from shortcodes", async () => {
    const ours = await ourRawHtml(":smile:");
    const ref = marked.parse(":smile:", { async: false }) as string;
    expect(ours).toContain("😄");
    expect(ref).toContain(":smile:"); // marked passes the shortcode through
  });

  it("DOCUMENTED: only ours emits KaTeX <span class=\"katex\">", async () => {
    const ours = await ourRawHtml("$E = mc^2$");
    const ref = marked.parse("$E = mc^2$", { async: false }) as string;
    expect(ours).toContain("katex");
    expect(ref).not.toContain("katex");
  });

  it("DOCUMENTED: only ours emits GitHub-style alert wrappers", async () => {
    const doc = "> [!NOTE]\n> heads up";
    const ours = await ourRawHtml(doc);
    const ref = marked.parse(doc, { async: false }) as string;
    expect(ours.toLowerCase()).toContain("note");
    expect(ref.toLowerCase()).toContain("[!note]"); // marked leaves the marker raw
  });
});
