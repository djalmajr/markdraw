import { describe, expect, it } from "bun:test";
import {
  collectIncludes,
  convertAdoc,
  getIncludePaths,
  scanIncludes,
} from "./asciidoc.ts";

const noopRead = async () => null;

describe("scanIncludes", () => {
  it("matches include:: only at the start of a line", () => {
    const source = `= Doc\n\ninclude::a.adoc[]\n\nincluded prose include::b.adoc[]\n\ninclude::c.adoc[lines=1..10]`;
    expect(scanIncludes(source)).toEqual(["a.adoc", "c.adoc"]);
  });
});

describe("getIncludePaths", () => {
  it("resolves relative includes against the doc's directory", () => {
    const paths = getIncludePaths(
      `include::../shared/header.adoc[]\ninclude::sub/foot.adoc[]`,
      "guides/intro",
    );
    expect(paths).toEqual(["guides/shared/header.adoc", "guides/intro/sub/foot.adoc"]);
  });

  it("treats /-prefixed targets as workspace-absolute", () => {
    expect(getIncludePaths(`include::/x.adoc[]`, "deep/nested")).toEqual(["x.adoc"]);
  });
});

describe("collectIncludes", () => {
  it("recursively walks nested includes and returns a path -> content map", async () => {
    const files: Record<string, string> = {
      "shared/header.adoc": "= Header\ninclude::sub.adoc[]",
      "shared/sub.adoc": "Sub content",
    };

    const cache = await collectIncludes(
      `include::shared/header.adoc[]`,
      "",
      async (p) => files[p] ?? null,
    );

    expect(cache.has("shared/header.adoc")).toBe(true);
    expect(cache.has("shared/sub.adoc")).toBe(true);
  });

  it("does not infinite-loop on circular includes (visited guard)", async () => {
    const files: Record<string, string> = {
      "a.adoc": "include::b.adoc[]",
      "b.adoc": "include::a.adoc[]",
    };
    const cache = await collectIncludes(
      `include::a.adoc[]`,
      "",
      async (p) => files[p] ?? null,
    );
    expect(cache.size).toBeGreaterThanOrEqual(1);
    expect(cache.size).toBeLessThanOrEqual(2);
  });
});

describe("convertAdoc", () => {
  it("renders a basic document and surfaces frontmatter", async () => {
    const { html, frontmatter } = await convertAdoc({
      filePath: "doc.adoc",
      fileContent: `---\ntitle: T\n---\n= Hello\n\n== Section\n\nbody paragraph`,
      readFile: noopRead,
    });

    expect(frontmatter).toEqual({ title: "T" });
    expect(html).toContain("Hello");
    expect(html).toContain("body paragraph");
    expect(html).toContain('id="toc"');
  });

  it("inlines a referenced include::", async () => {
    const files: Record<string, string> = {
      "shared/intro.adoc": "I am from a partial.",
    };
    const { html } = await convertAdoc({
      filePath: "main.adoc",
      fileContent: `= Main\n\ninclude::shared/intro.adoc[]`,
      readFile: async (p) => files[p] ?? null,
    });
    expect(html).toContain("I am from a partial.");
  });

  it("does not throw when an include target cannot be resolved (degrades gracefully)", async () => {
    const { html } = await convertAdoc({
      filePath: "main.adoc",
      fileContent: `= Main\n\n== Section\n\ninclude::missing.adoc[]`,
      readFile: noopRead,
    });
    // Either a warning marker or just the surrounding content survives;
    // the key invariant is the call completes and produces the rest of the document.
    expect(html).toContain("Main");
    expect(html).toContain("Section");
  });

  it("rewrites xref:file.adoc[label] into an inter-document HTML link", async () => {
    const { html } = await convertAdoc({
      filePath: "doc.adoc",
      fileContent: `= Doc\n\nSee xref:other.adoc[Other Doc].`,
      readFile: noopRead,
    });
    expect(html).toContain('href="other.html"');
    expect(html).toContain("Other Doc");
  });

  it("rewrites <<file.adoc#anchor,label>> shorthand into HTML link with fragment", async () => {
    const { html } = await convertAdoc({
      filePath: "doc.adoc",
      fileContent: `= Doc\n\nSee <<other.adoc#section,Section>>.`,
      readFile: noopRead,
    });
    expect(html).toContain('href="other.html#section"');
    expect(html).toContain(">Section<");
  });

  it("rewrites <<file.adoc>> shorthand without label using the file basename", async () => {
    const { html } = await convertAdoc({
      filePath: "doc.adoc",
      fileContent: `= Doc\n\nSee <<other.adoc>>.`,
      readFile: noopRead,
    });
    expect(html).toContain('href="other.html"');
    expect(html).toContain(">other<");
  });

  it("renders [mermaid] blocks as <div class=\"mermaid\">", async () => {
    const { html } = await convertAdoc({
      filePath: "doc.adoc",
      fileContent: `= Doc\n\n[mermaid]\n----\ngraph TD; A-->B\n----`,
      readFile: noopRead,
    });
    expect(html).toContain('<div class="mermaid">');
  });

  it("renders [plantuml] blocks as <div class=\"kroki\" data-type=\"plantuml\">", async () => {
    const { html } = await convertAdoc({
      filePath: "doc.adoc",
      fileContent: `= Doc\n\n[plantuml]\n----\n@startuml\nA -> B\n@enduml\n----`,
      readFile: noopRead,
    });
    expect(html).toContain('data-type="plantuml"');
  });

  it("supports nested includes resolved relative to the included file", async () => {
    const files: Record<string, string> = {
      "a/outer.adoc": `Outer line.\n\ninclude::sub/inner.adoc[]`,
      "a/sub/inner.adoc": "Inner content",
    };
    const { html } = await convertAdoc({
      filePath: "doc.adoc",
      fileContent: `= Doc\n\n== Section\n\ninclude::a/outer.adoc[]`,
      readFile: async (p) => files[p] ?? null,
    });
    expect(html).toContain("Inner content");
    expect(html).toContain("Outer line");
  });
});
