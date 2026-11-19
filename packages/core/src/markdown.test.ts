import { describe, expect, it } from "bun:test";
import {
  convertMarkdown,
  getMarkdownIncludePaths,
  scanMarkdownIncludes,
} from "./markdown.ts";

const noopRead = async () => null;

describe("scanMarkdownIncludes", () => {
  it("returns include targets in order of appearance", () => {
    const source = `
# Doc
<!-- include: a.md -->
<!-- include: b/c.md -->
text
<!-- include:./d.md -->
`;
    expect(scanMarkdownIncludes(source)).toEqual(["a.md", "b/c.md", "./d.md"]);
  });

  it("returns empty array when there are no includes", () => {
    expect(scanMarkdownIncludes("# just a heading")).toEqual([]);
  });
});

describe("getMarkdownIncludePaths", () => {
  it("resolves relative include targets against the doc's directory", () => {
    const paths = getMarkdownIncludePaths(
      `<!-- include: ../shared/header.md -->
<!-- include: notes/foot.md -->`,
      "docs/guide",
    );
    expect(paths).toEqual(["docs/shared/header.md", "docs/guide/notes/foot.md"]);
  });

  it("treats targets starting with / as workspace-absolute", () => {
    const paths = getMarkdownIncludePaths(`<!-- include: /shared/x.md -->`, "deep/nested");
    expect(paths).toEqual(["shared/x.md"]);
  });
});

describe("convertMarkdown — linkify policy", () => {
  const render = async (fileContent: string) =>
    (await convertMarkdown({ filePath: "d.md", fileContent, readFile: noopRead })).html;

  it("keeps bare domains linked", async () => {
    const html = await render("Bare: example.com and www.example.org");
    expect(html).toContain('<a href="http://example.com">example.com</a>');
    expect(html).toContain('<a href="http://www.example.org">www.example.org</a>');
  });

  it("does not link a bare document name (`.md` is Moldova's TLD)", async () => {
    const html = await render("Files: README.md, README.MD, notes.markdown, doc.adoc, spec.asciidoc");
    expect(html).not.toMatch(/href=["'][^"']*readme\.md/i);
    expect(html).not.toMatch(/href=["'][^"']*notes\.markdown/i);
    expect(html).not.toMatch(/href=["'][^"']*doc\.adoc/i);
    expect(html).not.toMatch(/href=["'][^"']*spec\.asciidoc/i);
    expect(html).toContain("README.md");
  });

  it("keeps the surrounding text intact when it drops a file-name match", async () => {
    const html = await render("Read README.md first, then example.com and doc.adoc last");
    expect(html).toContain("Read README.md first, then <a href=\"http://example.com\">example.com</a> and doc.adoc last");
  });

  it("does not link a document path without a scheme", async () => {
    const html = await render("See docs/a.md and docs/notes.adoc");
    expect(html).not.toMatch(/href=["'][^"']*docs\//i);
    expect(html).toContain("docs/a.md");
  });

  it("keeps a domain followed by a document path linked", async () => {
    // The suppression is only for an isolated file name: `example.com/README.md`
    // is a domain plus a document path, not a bare `README.md`.
    const html = await render("See example.com/README.md and example.md/foo");
    expect(html).toContain('<a href="http://example.com/README.md">example.com/README.md</a>');
    expect(html).toContain('<a href="http://example.md/foo">example.md/foo</a>');
  });

  it("keeps a domain with a query or fragment that ends in a document name linked", async () => {
    const html = await render("See example.com?file=README.md and example.com#README.md");
    expect(html).toContain('<a href="http://example.com?file=README.md">example.com?file=README.md</a>');
    expect(html).toContain('<a href="http://example.com#README.md">example.com#README.md</a>');
  });

  it("does not link a document path that never matched as a fuzzy domain", async () => {
    const html = await render("A directory path docs/README.md stays text");
    expect(html).not.toContain("href");
    expect(html).toContain("docs/README.md");
  });

  it("keeps an explicit URL to a document linked", async () => {
    const html = await render("See https://example.com/docs/README.md");
    expect(html).toContain('<a href="https://example.com/docs/README.md">');
  });

  it("keeps mail addresses linked", async () => {
    const html = await render("Mail user@example.com");
    expect(html).toContain('<a href="mailto:user@example.com">user@example.com</a>');
  });

  it("keeps a URL with credentials whole (urlAuth)", async () => {
    const html = await render("Auth http://user:pass@example.com/path");
    expect(html).toContain(
      '<a href="http://user:pass@example.com/path">http://user:pass@example.com/path</a>',
    );
    expect(html).not.toContain('<a href="http://user">');
  });
});

describe("convert-worker — linkify policy", () => {
  // The worker repeats the preview filter on its own instance, so it is driven
  // through its real entry point: the `self.onmessage` handler it installs.
  type WorkerReply = { id: number; html: string | null; error: string | null };
  const scope = globalThis as { self?: unknown };
  const hadSelf = "self" in scope;
  const previousSelf = scope.self;
  let reply: WorkerReply | null = null;
  const fakeSelf = {
    onmessage: null as ((event: { data: unknown }) => Promise<void>) | null,
    postMessage: (message: WorkerReply) => {
      reply = message;
    },
  };
  let handler: ((event: { data: unknown }) => Promise<void>) | null = null;

  const renderInWorker = async (source: string): Promise<string> => {
    // The handler reads `self` when it replies, so the fake stays installed
    // until the call settles; the module is imported only once.
    scope.self = fakeSelf;
    try {
      if (!handler) {
        await import("./convert-worker.ts");
        handler = fakeSelf.onmessage;
        if (!handler) throw new Error("convert-worker installed no onmessage handler");
      }
      reply = null;
      await handler({ data: { type: "convert-md", id: 1, processedContent: source } });
    } finally {
      if (hadSelf) scope.self = previousSelf;
      else delete scope.self;
    }
    if (!reply || reply.error !== null) throw new Error(`worker failed: ${reply?.error ?? "no reply"}`);
    return reply.html ?? "";
  };

  it("does not link a bare document name", async () => {
    const html = await renderInWorker("Files: README.md and doc.adoc");
    expect(html).not.toContain("href");
    expect(html).toContain("README.md");
  });

  it("keeps a domain followed by a document path linked", async () => {
    const html = await renderInWorker("See example.com/README.md");
    expect(html).toContain('<a href="http://example.com/README.md">example.com/README.md</a>');
  });

  it("keeps a domain with a query or fragment that ends in a document name linked", async () => {
    const html = await renderInWorker("See example.com?file=README.md and example.com#README.md");
    expect(html).toContain('<a href="http://example.com?file=README.md">example.com?file=README.md</a>');
    expect(html).toContain('<a href="http://example.com#README.md">example.com#README.md</a>');
  });
});

describe("convertMarkdown", () => {
  it("renders a basic document into HTML with a TOC block", async () => {
    const { html, frontmatter } = await convertMarkdown({
      filePath: "doc.md",
      fileContent: `# Hello\n\nbody`,
      readFile: noopRead,
    });

    expect(frontmatter).toBeNull();
    expect(html).toContain('id="toc"');
    expect(html).toContain('id="hello"');
    expect(html).toContain("Hello");
    expect(html).toContain("body");
  });

  it("strips and exposes YAML frontmatter", async () => {
    const { html, frontmatter } = await convertMarkdown({
      filePath: "doc.md",
      fileContent: `---\ntitle: My Doc\ntags: [a, b]\n---\n# Body`,
      readFile: noopRead,
    });
    expect(frontmatter).toEqual({ title: "My Doc", tags: ["a", "b"] });
    expect(html).not.toContain("title: My Doc");
    expect(html).toContain("Body");
  });

  it("inlines included files relative to the parent's directory", async () => {
    const files: Record<string, string> = {
      "docs/sections/intro.md": "## Intro section",
    };
    const { html } = await convertMarkdown({
      filePath: "docs/main.md",
      fileContent: `# Main\n<!-- include: sections/intro.md -->`,
      readFile: async (path) => files[path] ?? null,
    });
    expect(html).toContain("Intro section");
  });

  it("emits a warning comment when an include target cannot be found", async () => {
    const { html } = await convertMarkdown({
      filePath: "doc.md",
      fileContent: `# X\n<!-- include: missing.md -->`,
      readFile: async () => null,
    });
    expect(html).toContain("WARNING: include file not found: missing.md");
  });

  it("breaks circular includes with a warning instead of looping forever", async () => {
    const files: Record<string, string> = {
      "a.md": `# A\n<!-- include: b.md -->`,
      "b.md": `# B\n<!-- include: a.md -->`,
    };
    const { html } = await convertMarkdown({
      filePath: "a.md",
      fileContent: files["a.md"]!,
      readFile: async (path) => files[path] ?? null,
    });
    expect(html).toContain("circular include");
  });

  it("renders mermaid fences as <div class=\"mermaid\"> for the client-side renderer", async () => {
    const { html } = await convertMarkdown({
      filePath: "d.md",
      fileContent: "```mermaid\ngraph TD; A-->B\n```",
      readFile: noopRead,
    });
    expect(html).toContain('<div class="mermaid">');
    expect(html).toContain("graph TD");
  });

  it("renders kroki fences as <div class=\"kroki\" data-type=...>", async () => {
    const { html } = await convertMarkdown({
      filePath: "d.md",
      fileContent: "```plantuml\n@startuml\nA -> B\n@enduml\n```",
      readFile: noopRead,
    });
    expect(html).toContain('<div class="kroki" data-type="plantuml">');
  });

  it("renders github-style alerts (> [!NOTE])", async () => {
    const { html } = await convertMarkdown({
      filePath: "d.md",
      fileContent: "> [!NOTE]\n> Heads up.",
      readFile: noopRead,
    });
    // markdown-it-alert wraps content in a div / blockquote with the type
    expect(html.toLowerCase()).toContain("note");
  });

  it("renders task lists with input checkboxes", async () => {
    const { html } = await convertMarkdown({
      filePath: "d.md",
      fileContent: "- [x] done\n- [ ] todo",
      readFile: noopRead,
    });
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
  });

  it("transforms emoji shortcodes via markdown-it-emoji", async () => {
    const { html } = await convertMarkdown({
      filePath: "d.md",
      fileContent: ":smile:",
      readFile: noopRead,
    });
    expect(html).toContain("😄");
  });

  // The preview imports `katex/dist/katex.min.css` from the same version range
  // this package depends on, and that stylesheet only knows the prefixed
  // internal classes (`katex-base`, `katex-strut`, `katex-sizing`, …) that KaTeX
  // 0.18 introduced. {@link "@traptitech/markdown-it-katex"} pulls its own
  // `katex` 0.16 unless it is handed one, and 0.16 renders the unprefixed
  // classes (`base`, `strut`, `sizing`), which the current CSS cannot lay out —
  // the maths would render with collapsed struts.
  it("renders maths with the KaTeX version the preview stylesheet is from", async () => {
    const inline = await convertMarkdown({
      filePath: "d.md",
      fileContent: "$E = mc^2$",
      readFile: noopRead,
    });
    expect(inline.html).toContain('<span class="katex-html" aria-hidden="true">');
    expect(inline.html).toContain('<span class="katex-strut"');
    expect(inline.html).not.toContain('<span class="strut"');
    expect(inline.html).not.toContain('<span class="base"');

    const block = await convertMarkdown({
      filePath: "d.md",
      fileContent: "$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$",
      readFile: noopRead,
    });
    expect(block.html).toContain('<span class="katex-display"');
    expect(block.html).toContain('<span class="katex-sizing');
    expect(block.html).not.toContain('<span class="sizing');
  });
});
