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

  it("rejects a recursive anchor instead of returning a cyclic map", () => {
    // js-yaml resolves aliases by reference, so `*x` inside `&x` is a real
    // cycle. Consumers walk the map recursively (the properties panel,
    // JSON.stringify), so it is treated like invalid YAML.
    const sources = [
      "---\na: &x [*x]\n---\nbody",
      "---\na: &x { b: *x }\n---\nbody",
      "---\na: &a\n  b: &b\n    c: *a\n---\nbody",
    ];
    for (const source of sources) {
      expect(extractFrontmatter(source)).toEqual({ frontmatter: null, body: source });
    }
  });

  it("rejects a frontmatter map nested deeper than 64 levels", () => {
    const nested = (levels: number) =>
      `---\na: ${"{b: ".repeat(levels - 1)}1${"}".repeat(levels - 1)}\n---\nbody`;

    const atLimit = nested(64);
    expect(extractFrontmatter(atLimit).frontmatter).not.toBeNull();

    const tooDeep = nested(65);
    expect(extractFrontmatter(tooDeep)).toEqual({ frontmatter: null, body: tooDeep });
  });

  it("rejects a long alias chain (deep through shared references, not a cycle)", () => {
    // A chain of 100 aliases nests 100 levels even though no object repeats on
    // its own path: the depth limit, not the cycle check, is what rejects it.
    let chain = "---\nroot: &r0 {v: 1}\n";
    for (let i = 1; i < 100; i++) chain += `k${i}: &r${i} {child: *r${i - 1}}\n`;
    const source = `${chain}---\nbody`;
    expect(extractFrontmatter(source)).toEqual({ frontmatter: null, body: source });
  });

  it("keeps an anchor reused by sibling keys (shared, not cyclic)", () => {
    const { frontmatter } = extractFrontmatter("---\nx: &s {k: 1}\ny: *s\n---\nbody");
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.x).toEqual({ k: 1 });
    // Aliases are still by reference: two fields, one map.
    expect(frontmatter!.x).toBe(frontmatter!.y);
  });

  it("validates a shared subtree once instead of re-walking it per reference", () => {
    // 22 doubling levels: re-walking both branches on every reference costs
    // ~2^22 visits (~3.7 s here) while a memoized height costs 22.
    const levels = 22;
    let source = "---\nbase: &a0 {v: 1}\n";
    for (let i = 1; i <= levels; i++) {
      source += `k${i}: &a${i} {l: *a${i - 1}, r: *a${i - 1}}\n`;
    }
    source += "---\nbody";

    const started = performance.now();
    const { frontmatter } = extractFrontmatter(source);
    const elapsed = performance.now() - started;

    expect(frontmatter).not.toBeNull();
    // Same anchor, one object: siblings share the reference, no cycle.
    expect((frontmatter!.k22 as { l: unknown }).l).toBe(frontmatter!.k21);
    expect(elapsed).toBeLessThan(1000);
  });

  it("applies the depth limit to the absolute path through a shared subtree", () => {
    // A 40-level chain, valid at the top (depth 1 + height 39 = 40) and over
    // the limit when the same subtree hangs 30 maps down (31 + 39 = 70).
    let chain = "c0: &c0 {v: 1}\n";
    for (let i = 1; i < 40; i++) chain += `c${i}: &c${i} {child: *c${i - 1}}\n`;

    const shallow = `---\n${chain}top: *c39\n---\nbody`;
    expect(extractFrontmatter(shallow).frontmatter).not.toBeNull();

    const nested = `deep: ${"{n: ".repeat(30)}*c39${"}".repeat(30)}\n`;
    const deep = `---\n${chain}${nested}---\nbody`;
    expect(extractFrontmatter(deep)).toEqual({ frontmatter: null, body: deep });
  });

  it("keeps a map whose data key is named toString (valid YAML, no coercion)", () => {
    // The panel must not `String()` such a value: `toString` is a string here,
    // not a method. The parser only walks own values, so it stays valid.
    const source = "---\nmeta: {toString: boom}\n---\nbody";
    const { frontmatter } = extractFrontmatter(source);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.meta).toEqual({ toString: "boom" });
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
