import { describe, expect, it } from "bun:test";
import {
  extractLinks,
  buildBacklinkIndex,
  findBacklinks,
} from "./backlinks.ts";

/**
 * The backlink panel is only as good as its parser. Coverage walks
 * through the link shapes our markdown / asciidoc renderers
 * understand — anything we don't extract here will silently
 * disappear from the panel.
 */
describe("extractLinks", () => {
  it("extracts the target of a markdown link", () => {
    // Mutation: dropping the `\\(([^)]+)\\)` capture would extract
    // the visible label instead of the path — backlinks would
    // resolve to nothing.
    expect(extractLinks("see [intro](other.md) here", "doc.md"))
      .toEqual(["other.md"]);
  });

  it("extracts only relative document targets — not http URLs", () => {
    // Mutation: forgetting to filter `http://` / `https://` would
    // pollute the index with unresolvable web links.
    const links = extractLinks(
      "external [site](https://example.test) and [local](sibling.md)",
      "doc.md",
    );
    expect(links).toEqual(["sibling.md"]);
  });

  it("strips the `#fragment` from a markdown link target", () => {
    // Mutation: keeping the fragment would mismatch the index key
    // (`other.md#section` ≠ `other.md`).
    expect(extractLinks("see [hi](other.md#hello)", "doc.md"))
      .toEqual(["other.md"]);
  });

  it("extracts the target of an asciidoc xref", () => {
    // Mutation: failing on the `xref:` macro shape silently drops
    // every adoc cross-reference — the most common link kind in
    // asciidoc workspaces.
    expect(extractLinks("xref:other.adoc[the other doc]", "doc.adoc"))
      .toEqual(["other.adoc"]);
  });

  it("extracts the target of an asciidoc include::", () => {
    // Mutation: ignoring `include::` would miss the canonical way
    // adoc docs compose modular content.
    expect(extractLinks("include::partials/intro.adoc[]", "doc.adoc"))
      .toEqual(["partials/intro.adoc"]);
  });

  it("resolves a `../foo` target against the source file's directory", () => {
    // Mutation: skipping the relative-resolve step would index raw
    // strings, so the panel would ask for `..` segments that never
    // match any indexed file path.
    expect(extractLinks("[up](../shared/util.md)", "deep/nested/doc.md"))
      .toEqual(["deep/shared/util.md"]);
  });

  it("ignores unrelated bracket pairs that don't form a link", () => {
    // Mutation: a too-greedy regex would match `[note]:` or
    // `[citation]` and inject phantom backlinks.
    expect(extractLinks("see [note] for context", "doc.md"))
      .toEqual([]);
  });

  it("dedupes when the same target appears multiple times in one source", () => {
    // Mutation: not deduping inflates backlink rows in the panel
    // (one source listed three times for the same target).
    const links = extractLinks(
      "[a](other.md), then [a again](other.md), and [a once more](other.md)",
      "doc.md",
    );
    expect(links).toEqual(["other.md"]);
  });
});

describe("buildBacklinkIndex", () => {
  it("inverts a forward link map into target → sources", () => {
    // Mutation: keying by source instead of target produces a
    // *forward* link map — backlinks would query the wrong key
    // and always return [].
    const index = buildBacklinkIndex([
      { path: "a.md", content: "[link](b.md)" },
      { path: "c.md", content: "[link](b.md)" },
    ]);
    expect(findBacklinks("b.md", index).sort()).toEqual(["a.md", "c.md"]);
  });

  it("returns an empty array when nothing references the target", () => {
    // Mutation: returning `undefined` from `findBacklinks` would
    // crash any caller that does `.length` or `.map`.
    const index = buildBacklinkIndex([
      { path: "a.md", content: "no links here" },
    ]);
    expect(findBacklinks("b.md", index)).toEqual([]);
  });

  it("excludes a doc from referring to itself (self-link is not a backlink)", () => {
    // Mutation: counting self-links would surface "this doc links
    // back to itself" rows that are pure noise to the reader.
    const index = buildBacklinkIndex([
      { path: "a.md", content: "[me](a.md) and [b](b.md)" },
    ]);
    expect(findBacklinks("a.md", index)).toEqual([]);
  });
});
