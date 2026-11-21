import { describe, expect, it } from "bun:test";
import { convert } from "@asciidoctor/core";
import {
  buildAnchorIndex,
  extractAsciidocAnchorIds,
  resolveAnchor,
  type AnchorFileSource,
} from "./asciidoc-anchors.ts";

describe("extractAsciidocAnchorIds", () => {
  it("extracts block-line [[id]] and [[id, reftext]]", () => {
    // Mutation: ignoring [[id]] would leave the commonest explicit anchor
    // out of the index, so clicking <<id>> would show "not found".
    expect(extractAsciidocAnchorIds("[[intro]]\n[[next, Next section]]\n"))
      .toEqual(["intro", "next"]);
  });

  it("extracts [[id]] inline in the middle of a line", () => {
    expect(extractAsciidocAnchorIds("Texto [[mid]] no meio da linha."))
      .toEqual(["mid"]);
  });

  it("extracts [#id] and [#id.role%option] block anchors", () => {
    // Mutation: only accepting a bare id would drop role/option variants.
    expect(extractAsciidocAnchorIds("[#one]\n[#two.role%option]\n"))
      .toEqual(["one", "two"]);
  });

  it("extracts inline [#id]#texto#", () => {
    expect(extractAsciidocAnchorIds("Veja [#inline]#isto# aqui."))
      .toEqual(["inline"]);
  });

  it("extracts anchor:id[...] macros", () => {
    // Mutation: dropping the macro case loses anchors written by Asciidoctor
    // for inline text.
    expect(extractAsciidocAnchorIds("Veja anchor:macro[este trecho]."))
      .toEqual(["macro"]);
  });

  it("extracts id= from attribute lists, quoted and mixed", () => {
    expect(extractAsciidocAnchorIds(
      '[id=plain]\n[id="quoted"]\n[id=\'single\']\n[source,id=mixed]\n[id=quoted, title="x"]\n',
    )).toEqual(["plain", "quoted", "single", "mixed"]);
  });

  it("ignores comments, comment blocks and delimited listing/literal/passthrough bodies", () => {
    expect(extractAsciidocAnchorIds([
      "// [[commented]]",
      "////",
      "[[inside-comment]]",
      "////",
      "----",
      "[[in-listing]]",
      "----",
      "....",
      "[id=in-literal]",
      "....",
      "++++",
      "anchor:in-passthrough[]",
      "++++",
      "[[kept]]",
    ].join("\n"))).toEqual(["kept"]);
  });

  it("ignores auto-generated section ids", () => {
    // Mutation: treating every word of a heading as an anchor would resolve
    // <<Section>> to the wrong file.
    expect(extractAsciidocAnchorIds("== Section Title\n\nTexto sem âncora.\n"))
      .toEqual([]);
  });

  it("deduplicates repeated anchors", () => {
    expect(extractAsciidocAnchorIds("[[dup]]\n[#dup]\nanchor:dup[]\n"))
      .toEqual(["dup"]);
  });

  // F1: the ids must be exactly the ones Asciidoctor creates, including
  // Unicode letters, not truncated at the first non-ASCII character.
  it("F1 preserves Unicode ids in all four explicit forms", async () => {
    const forms = [
      "[[introdução]]",
      "anchor:introdução[]",
      "[#introdução]",
      "[id=introdução]",
    ];
    for (const form of forms) {
      const source = `${form}\n== Capítulo`;
      expect(extractAsciidocAnchorIds(source)).toEqual(["introdução"]);
      expect(String(await convert(source))).toContain('id="introdução"');
    }
    expect(extractAsciidocAnchorIds("[#introdução.role%opção]\n== Capítulo"))
      .toEqual(["introdução"]);
    expect(extractAsciidocAnchorIds("[[cafe\u0301]]"))
      .toEqual(["cafe\u0301"]);
  });

  // F2: literal monospace with `+`, inline passthrough and escaped brackets
  // are syntax examples for Asciidoctor, not anchors. Plain backticks (with
  // or without doubling) still create a real anchor.
  it("F2 skips literal-plus, passthrough and escaped bracket contexts", async () => {
    const literal = [
      "Exemplo: `+[[alvo]]+`.",
      "Exemplo: ``+[[alvo]]+``.",
      "Exemplo: +++[[alvo]]+++.",
      "Exemplo pass:[[#alvo]] texto.",
      String.raw`Exemplo: \[[alvo]].`,
    ];
    for (const source of literal) {
      expect(extractAsciidocAnchorIds(source)).toEqual([]);
      expect(String(await convert(source))).not.toContain('id="alvo"');
    }
    for (const source of ["Exemplo: `[[alvo]]`.", "Exemplo: ``[[alvo]]``."]) {
      expect(extractAsciidocAnchorIds(source)).toEqual(["alvo"]);
      expect(String(await convert(source))).toContain('id="alvo"');
    }
  });

  // F3: the whole delimiter is state; a shorter run of the same character
  // inside a block is content, and no line inside a block opens another one.
  it("F3 matches the full delimiter and keeps block state", async () => {
    const cases: Array<[string, string[]]> = [
      ["-----\n----\n[[alvo]]\n----\n-----", []],
      ["---.\n\n[[alvo]]\n== Capítulo", ["alvo"]],
      ["----\n////\n----\n\n[[alvo]]\n== Capítulo", ["alvo"]],
      ["////\n----\n////\n\n[[alvo]]\n== Capítulo", ["alvo"]],
      ["/////\n////\n[[alvo]]\n\nTexto\n/////", []],
    ];
    for (const [source, expected] of cases) {
      expect(extractAsciidocAnchorIds(source)).toEqual(expected);
      const html = String(await convert(source));
      const rendered = [...html.matchAll(/<[^>]+\sid="([^"]+)"/g)].map((m) => m[1]);
      expect(rendered).toEqual(expected);
    }
  });

  it("F1 indexes the full ID or skips an invalid form without indexing a prefix", async () => {
    const cases = [
      ["[#al!vo.role%option]", ["al!vo"]],
      ["[#al!vo,role=note]", ["al!vo"]],
      ["[id=al!vo,role=note]", ["al!vo"]],
      ['[id="al!vo,parte]dois",role=note]', ["al!vo,parte]dois"]],
      ["[id='al!vo,parte',role=note]", ["al!vo,parte"]],
      ["[id=al+++vo+++]", ["al+++vo+++"]],
      ["[#al+++vo+++]", ["al+++vo+++"]],
      ['[role="example,id=fake",id=real]', ["real"]],
      ["[[al!vo, reftext]]", []],
      ["[[al.vo, reftext]]", ["al.vo"]],
    ] as const;
    for (const [form, expected] of cases) {
      const source = `${form}\n== Título`;
      const rendered = [...String(await convert(source)).matchAll(/<[^>]+\sid="([^"]+)"/g)]
        .map((match) => match[1]);
      expect(rendered, form).toEqual(expected);
      expect(extractAsciidocAnchorIds(source), form).toEqual(expected);
    }
    const inline = "Antes [#al%vo]#palavra# e [#ou#tro]#trecho#.";
    expect(String(await convert(inline))).toContain('id="al%vo"');
    expect(String(await convert(inline))).toContain('id="ou#tro"');
    expect(extractAsciidocAnchorIds(inline)).toEqual(["al%vo", "ou#tro"]);
  });

  it("F2 keeps passthrough and monospace masks through newlines and escaped brackets", async () => {
    const cases = [
      "Antes +++texto\n[[oculta]]+++ e [[visível]].",
      "Antes `+texto\n[[oculta]]+` e [[visível]].",
      "Antes ``+texto\n[[oculta]]+`` e [[visível]].",
      "Antes pass:[texto\n[[oculta]]] e [[visível]].",
      "Antes pass:[texto \\] [[oculta]]] e [[visível]].",
      "Antes +++sem fechar\n\n[[visível]]\n== Título",
      "Antes +++sem fechar\n----\n[[oculta]]\n----\n\n[[visível]]\n== Título",
      "Antes +++sem fechar\n====\n[[visível]]\nTexto.\n====",
    ];
    for (const source of cases) {
      const rendered = [...String(await convert(source)).matchAll(/<[^>]+\sid="([^"]+)"/g)]
        .map((match) => match[1]);
      expect(rendered, source).toEqual(["visível"]);
      expect(extractAsciidocAnchorIds(source), source).toEqual(["visível"]);
    }
  });

  it("keeps prose anchors after a literal marker that never closes in the paragraph", async () => {
    // Mutation captured: masking to the end of the paragraph when the closer
    // is missing drops these anchors, which the converter still creates.
    const cases = [
      "Use +++ para passar texto adiante. [[alvo]]",
      "Digite `+ e depois [[alvo]].",
      "Digite ``+ e depois\n[[alvo]] na outra linha.",
      "Escapado: \\+++ literal +++ e depois [[alvo]].",
    ];
    for (const source of cases) {
      const rendered = [...String(await convert(source)).matchAll(/<[^>]+\sid="([^"]+)"/g)]
        .map((match) => match[1]);
      expect(rendered, source).toEqual(["alvo"]);
      expect(extractAsciidocAnchorIds(source), source).toEqual(["alvo"]);
    }
  });

  it("F3 requires column zero for both edges of a fence and allows trailing spaces", async () => {
    const cases = [
      "Texto.\n\n ----\n\n[[visível]]\n== Título",
      "Texto.\n\n ....\n\n[[visível]]\n== Título",
      "Texto.\n\n ++++\n\n[[visível]]\n== Título",
      "Texto.\n\n ////\n\n[[visível]]\n== Título",
      "----  \n ----\n[[oculta]]\n----  \n\n[[visível]]\n== Título",
    ];
    for (const source of cases) {
      const rendered = [...String(await convert(source)).matchAll(/<[^>]+\sid="([^"]+)"/g)]
        .map((match) => match[1]);
      expect(rendered, source).toEqual(["visível"]);
      expect(extractAsciidocAnchorIds(source), source).toEqual(["visível"]);
    }
  });
});

function source(path: string, content: string, rootId = "root"): AnchorFileSource {
  return { rootId, rootName: rootId, path, content };
}

describe("buildAnchorIndex + resolveAnchor", () => {
  const files = [
    source("index.adoc", "[[start]]"),
    source("chapters/one.adoc", "[[start]]\n[[only-one]]"),
    source("chapters/deep/two.asciidoc", "[[start]]"),
    source("other/chapter.asc", "[[start]]\n[[other-id]]"),
    source("chapters/notes.md", "[[start]]"),
    source("vault/other.adoc", "[[start]]", "other-root"),
  ];
  const index = buildAnchorIndex(files);

  it("indexes only AsciiDoc files", () => {
    expect(resolveAnchor(index, "start", { rootId: "root", path: "chapters/notes.md" }))
      .toEqual({ rootId: "root", path: "chapters/one.adoc" });
    expect(index.has("only-one")).toBe(true);
    expect(index.get("only-one")).toHaveLength(1);
  });

  it("prefers the same directory over a shallower file", () => {
    expect(resolveAnchor(index, "start", { rootId: "root", path: "chapters/reader.adoc" }))
      .toEqual({ rootId: "root", path: "chapters/one.adoc" });
  });

  it("prefers the shortest up+down path distance", () => {
    // From chapters/deep/: chapters/deep/two.asciidoc is in the same directory
    // (0), chapters/one.adoc is one level up, index.adoc is two up, and
    // other/chapter.asc is two up + one down.
    expect(resolveAnchor(index, "start", { rootId: "root", path: "chapters/deep/reader.adoc" }))
      .toEqual({ rootId: "root", path: "chapters/deep/two.asciidoc" });

    const far = buildAnchorIndex([
      source("a/b/c/reader.adoc", "[[x]]"),
      source("x/far.adoc", "[[nearer]]"),
      source("a/b/c/d/e/deep.adoc", "[[nearer]]"),
    ]);
    expect(resolveAnchor(far, "nearer", { rootId: "root", path: "a/b/c/reader.adoc" }))
      .toEqual({ rootId: "root", path: "a/b/c/d/e/deep.adoc" });
  });

  it("breaks ties by lexicographic path, deterministically", () => {
    const tied = buildAnchorIndex([
      source("b/z.adoc", "[[tie]]"),
      source("a/y.adoc", "[[tie]]"),
    ]);
    const from = { rootId: "root", path: "a/x.adoc" };
    expect(resolveAnchor(tied, "tie", from))
      .toEqual({ rootId: "root", path: "a/y.adoc" });
    expect(resolveAnchor(tied, "tie", from))
      .toEqual(resolveAnchor(tied, "tie", from));
  });

  it("never picks another root", () => {
    const onlyOtherRoot = buildAnchorIndex([files[5]!]);
    expect(resolveAnchor(onlyOtherRoot, "start", { rootId: "root", path: "index.adoc" }))
      .toBeUndefined();
  });

  it("never picks the file itself", () => {
    expect(resolveAnchor(index, "start", { rootId: "root", path: "chapters/one.adoc" }))
      .toEqual({ rootId: "root", path: "chapters/deep/two.asciidoc" });
    const alone = buildAnchorIndex([source("only.adoc", "[[single]]")]);
    expect(resolveAnchor(alone, "single", { rootId: "root", path: "only.adoc" }))
      .toBeUndefined();
  });

  it("returns undefined for an id nobody defines", () => {
    expect(resolveAnchor(index, "missing", { rootId: "root", path: "index.adoc" }))
      .toBeUndefined();
  });
});
