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
    // Genuinely invalid YAML: unfenced flow sequence. js-yaml 5 parses more
    // leniently than 4 in some corners (`: : not yaml :` now yields a nested
    // map instead of throwing), so the fixture is an input both versions reject.
    const source = `---\ntitle: [unclosed\n---\nbody`;
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

describe("extractFrontmatter — js-yaml 5 default schema (CORE)", () => {
  // js-yaml 5 resolves `load()` with the YAML 1.2 CORE schema instead of v4's
  // DEFAULT_SCHEMA (which carried !!timestamp, !!binary, !!set, !!omap, !!pairs
  // and the `<<` merge tag). These pin the resulting behaviour.

  it("keeps timestamp-like values as strings (v4 resolved them to Date)", () => {
    const { frontmatter } = extractFrontmatter("---\ncreated: 2024-01-01\n---\nbody");
    expect(frontmatter).toEqual({ created: "2024-01-01" });
    expect(typeof frontmatter!.created).toBe("string");
  });

  it("leaves `<<` as a literal key instead of merging (no merge tag)", () => {
    const source = `---
base: &b
  x: 1
child:
  <<: *b
  y: 2
---
body`;
    const { frontmatter } = extractFrontmatter(source);
    expect(frontmatter!.child).toEqual({ "<<": { x: 1 }, y: 2 });
  });

  it("rejects YAML 1.1 tags the default schema does not carry (!!binary, !!set)", () => {
    for (const tag of ["!!binary aGk=", "!!set { one, two }", "!!omap [ a: 1 ]"]) {
      const source = `---\nvalue: ${tag}\n---\nbody`;
      expect(extractFrontmatter(source).frontmatter).toBeNull();
    }
  });

  it("rejects custom/unknown tags instead of constructing a value", () => {
    const source = `---\nvalue: !!python/object:foo {}\n---\nbody`;
    const { frontmatter, body } = extractFrontmatter(source);
    expect(frontmatter).toBeNull();
    expect(body).toBe(source);
  });

  it("parses recursive anchors without throwing (same as v4 — aliases are by reference)", () => {
    const { frontmatter, body } = extractFrontmatter("---\na: &x [*x]\n---\nbody");
    expect(frontmatter).not.toBeNull();
    expect(body).toBe("body");
    // The alias is a real self-reference, not a copy — JSON.stringify would throw.
    const a = frontmatter!.a as unknown[];
    expect(a[0]).toBe(a);
  });

  it("treats an empty frontmatter block as no frontmatter (load('') throws in v5)", () => {
    const source = "---\n\n---\nbody";
    const { frontmatter, body } = extractFrontmatter(source);
    expect(frontmatter).toBeNull();
    expect(body).toBe(source);
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
