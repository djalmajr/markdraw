import { describe, expect, it } from "bun:test";
import { extractFrontmatter, parseWikiLink } from "./frontmatter.ts";

describe("extractFrontmatter", () => {
  it("parses a typical YAML header and strips it from the body", () => {
    const source = `---
title: Notes
tags:
  - one
  - two
---
# Heading
body text`;
    const { frontmatter, body } = extractFrontmatter(source);
    expect(frontmatter).toEqual({ title: "Notes", tags: ["one", "two"] });
    expect(body).toBe("# Heading\nbody text");
  });

  it("returns null and untouched body when no frontmatter is present", () => {
    const source = "just body text";
    expect(extractFrontmatter(source)).toEqual({ frontmatter: null, body: source });
  });

  it("does not consume markdown horizontal rules that appear later", () => {
    const source = `# Title\n\n---\n\nmore`;
    const { frontmatter, body } = extractFrontmatter(source);
    expect(frontmatter).toBeNull();
    expect(body).toBe(source);
  });

  it("treats malformed YAML as no frontmatter (degrades gracefully)", () => {
    const source = `---\n: : not yaml :\n---\nbody`;
    const { frontmatter, body } = extractFrontmatter(source);
    expect(frontmatter).toBeNull();
    expect(body).toBe(source);
  });

  it("rejects YAML that is not an object (string, array, number)", () => {
    const arrSrc = `---\n- 1\n- 2\n---\nbody`;
    expect(extractFrontmatter(arrSrc).frontmatter).toBeNull();

    const strSrc = `---\nhello\n---\nbody`;
    expect(extractFrontmatter(strSrc).frontmatter).toBeNull();
  });

  it("supports CRLF line endings", () => {
    const source = "---\r\ntitle: x\r\n---\r\nbody";
    const { frontmatter, body } = extractFrontmatter(source);
    expect(frontmatter).toEqual({ title: "x" });
    expect(body).toBe("body");
  });
});

describe("parseWikiLink", () => {
  it("extracts the inner name from [[name]]", () => {
    expect(parseWikiLink("[[Some Note]]")).toBe("Some Note");
  });

  it("trims whitespace inside and outside the brackets", () => {
    expect(parseWikiLink("  [[  Note  ]]  ")).toBe("Note");
  });

  it("returns null for non-wiki-link strings", () => {
    expect(parseWikiLink("plain")).toBeNull();
    expect(parseWikiLink("[single]")).toBeNull();
    expect(parseWikiLink("[[broken]")).toBeNull();
  });
});
