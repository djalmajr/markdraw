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
});
