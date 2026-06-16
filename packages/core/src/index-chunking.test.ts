import { describe, expect, it } from "bun:test";
import { chunkDocument } from "./index-chunking.ts";

describe("chunkDocument", () => {
  it("splits a markdown doc into heading-delimited sections with a nested path", () => {
    const content = ["# Guide", "intro line", "", "## Auth", "oauth stuff", "", "## Database", "postgres stuff"].join(
      "\n",
    );
    const chunks = chunkDocument("guide.md", content);
    expect(chunks.map((c) => c.heading)).toEqual(["Guide", "Auth", "Database"]);
    expect(chunks.map((c) => c.headingPath)).toEqual(["Guide", "Guide > Auth", "Guide > Database"]);
    expect(chunks[0]!.index).toBe(0);
    expect(chunks[1]!.index).toBe(1);
    expect(chunks[1]!.startLine).toBe(3); // "## Auth" is line index 3
    expect(chunks[1]!.text).toContain("oauth stuff");
    expect(chunks[2]!.text).toContain("postgres stuff");
  });

  it("captures a headingless preamble before the first heading", () => {
    const content = ["preamble text", "", "# Title", "body"].join("\n");
    const chunks = chunkDocument("notes.md", content);
    expect(chunks[0]!.heading).toBe("");
    expect(chunks[0]!.headingLevel).toBe(0);
    expect(chunks[0]!.headingPath).toBe("");
    expect(chunks[0]!.text).toBe("preamble text");
    expect(chunks[1]!.heading).toBe("Title");
  });

  it("returns a single chunk for a file with no headings", () => {
    const chunks = chunkDocument("flat.md", "just some prose\nover two lines");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe("");
    expect(chunks[0]!.text).toBe("just some prose\nover two lines");
  });

  it("sub-splits an oversized section, keeping the heading and contiguous ords", () => {
    const big = Array.from({ length: 60 }, (_, i) => `line ${i} with some filler text`).join("\n");
    const content = `## Big\n${big}`;
    const chunks = chunkDocument("big.md", content, { maxChars: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.heading === "Big")).toBe(true);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i)); // contiguous 0..n
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(220);
  });

  it("handles asciidoc headings (level = count of '=')", () => {
    const content = ["= Doc", "lead", "", "== Section", "detail"].join("\n");
    const chunks = chunkDocument("doc.adoc", content);
    expect(chunks.map((c) => c.heading)).toEqual(["Doc", "Section"]);
    expect(chunks[0]!.headingLevel).toBe(1);
    expect(chunks[1]!.headingLevel).toBe(2);
    expect(chunks[1]!.headingPath).toBe("Doc > Section");
  });

  it("drops a sibling heading from the ancestor path when levels are equal", () => {
    const content = ["## A", "a", "## B", "b"].join("\n");
    const chunks = chunkDocument("x.md", content);
    expect(chunks.map((c) => c.headingPath)).toEqual(["A", "B"]); // B does not nest under A
  });
});
