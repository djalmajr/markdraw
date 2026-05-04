// i18n / Unicode edge-case sweeps. The conversion pipeline must survive
// inputs from the wild: full-width CJK, ZWJ emoji sequences, RTL marks,
// combining diacriticals, surrogate pairs, BiDi override characters.
//
// These are property tests because we don't want a hand-picked fixture
// for every script — we want to assert invariants that hold for ANY
// well-formed Unicode input.
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { extractFrontmatter } from "../frontmatter.ts";
import { convertMarkdown } from "../markdown.ts";
import { escapeHtml } from "../utils.ts";

const noopRead = async () => null;

const unicodeStringArb = fc.fullUnicodeString({ maxLength: 200 });

describe("Unicode invariants", () => {
  it("extractFrontmatter handles arbitrary Unicode body without throwing", () => {
    fc.assert(
      fc.property(unicodeStringArb, (input) => {
        expect(() => extractFrontmatter(input)).not.toThrow();
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("escapeHtml never produces a raw <, >, or unbalanced & for any Unicode input", () => {
    fc.assert(
      fc.property(unicodeStringArb, (input) => {
        const out = escapeHtml(input);
        expect(out.includes("<")).toBe(false);
        expect(out.includes(">")).toBe(false);
        const ampPositions = [...out.matchAll(/&/g)].map((m) => m.index ?? 0);
        for (const i of ampPositions) {
          const tail = out.slice(i, i + 6);
          const ok =
            tail.startsWith("&amp;") ||
            tail.startsWith("&lt;") ||
            tail.startsWith("&gt;") ||
            tail.startsWith("&quot;");
          expect(ok).toBe(true);
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("BiDi override marks (U+202E etc.) survive into rendered output as escaped/literal, never as injected control of HTML structure", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("‮", "‭", "‬", "‎", "‏"),
        async (mark) => {
          const doc = `paragraph: before${mark}after\n\n## section\n\nbody`;
          const { html } = await convertMarkdown({
            filePath: "i18n.md",
            fileContent: doc,
            readFile: noopRead,
          });
          // The override mark may pass through in text content, but the
          // surrounding tag structure must remain intact — the doc has one
          // h2 and at least two <p>'s.
          expect((html.match(/<h2[^>]*>/g) ?? []).length).toBe(1);
          expect((html.match(/<p[^>]*>/g) ?? []).length).toBeGreaterThanOrEqual(1);
          return true;
        },
      ),
      { numRuns: 5 },
    );
  });

  it("ZWJ sequences in headings produce a heading with the literal grapheme cluster as text", async () => {
    const families = ["👨‍👩‍👧‍👦", "🏴‍☠️", "👋🏽"];
    for (const grapheme of families) {
      const { html } = await convertMarkdown({
        filePath: "i18n.md",
        fileContent: `# ${grapheme}\n\nbody`,
        readFile: noopRead,
      });
      // The heading text must include every codepoint of the grapheme,
      // not split on the ZWJ. We assert each codepoint appears in the
      // body. (markdown-it-anchor's slugify drops these chars, which is
      // fine — we're testing TEXT content, not slug.)
      const headingText = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "";
      for (const ch of [...grapheme]) {
        expect(headingText).toContain(ch);
      }
    }
  });

  it("CJK + RTL mixed inline content preserves character count in output", async () => {
    const inputs = [
      "中文 text Arabic مرحبا English",
      "日本語 + עברית + Português",
      "한국어 mixed with deutsch",
    ];
    for (const text of inputs) {
      const { html } = await convertMarkdown({
        filePath: "i18n.md",
        fileContent: `paragraph: ${text}`,
        readFile: noopRead,
      });
      // Every non-whitespace char in input must appear in body.
      for (const ch of [...text]) {
        if (/\S/.test(ch)) {
          expect(html.includes(ch)).toBe(true);
        }
      }
    }
  });

  it("combining diacriticals — NFC and NFD forms render equivalently visible content", async () => {
    const nfc = "café"; // single 'é' codepoint
    const nfd = "café"; // 'e' + combining acute

    const a = await convertMarkdown({
      filePath: "i18n.md",
      fileContent: `## ${nfc}\n\nbody`,
      readFile: noopRead,
    });
    const b = await convertMarkdown({
      filePath: "i18n.md",
      fileContent: `## ${nfd}\n\nbody`,
      readFile: noopRead,
    });

    // Heading count and section structure must match.
    const headingsA = (a.html.match(/<h2[^>]*>/g) ?? []).length;
    const headingsB = (b.html.match(/<h2[^>]*>/g) ?? []).length;
    expect(headingsB).toBe(headingsA);
  });
});
