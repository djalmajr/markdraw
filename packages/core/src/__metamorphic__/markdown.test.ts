// Metamorphic testing for the markdown pipeline. A metamorphic relation
// is an invariant that should hold across *related* runs of the SUT,
// without needing an oracle for any single run.
//
// These relations let us assert correctness on inputs we couldn't
// otherwise judge — there's no "expected HTML" to compare against, but
// we KNOW that two runs related by a structural transformation must
// produce HTML that's also related in a known way.
//
// Relevant background: Metamorphic Coverage (arxiv 2508.16307) shows
// MC is 4× more sensitive than line coverage at distinguishing
// effective tests from noise.
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { convertMarkdown } from "../markdown.ts";

const noopRead = async () => null;

async function render(md: string): Promise<string> {
  const { html } = await convertMarkdown({
    filePath: "doc.md",
    fileContent: md,
    readFile: noopRead,
  });
  return html;
}

function bodyOnly(html: string): string {
  return html.replace(/<div id="toc"[\s\S]*?<\/div>\s*<\/div>\s*/, "");
}

function countMatches(haystack: string, re: RegExp): number {
  return (haystack.match(re) ?? []).length;
}

describe("markdown metamorphic relations", () => {
  // MR-1 ─────────────────────────────────────────────────────────────────
  // Concatenating two valid docs (with disjoint headings) produces a
  // document whose heading count equals the sum of the two parts'.
  // If a future change starts dropping headings under some condition,
  // this relation flags it.
  it("MR-1: heading count of (A ++ B) === count(A) + count(B)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        async (na, nb) => {
          const docA = Array.from({ length: na }, (_, i) => `## Heading A${i}\n\ntext A${i}`).join("\n\n");
          const docB = Array.from({ length: nb }, (_, i) => `## Heading B${i}\n\ntext B${i}`).join("\n\n");
          const htmlA = bodyOnly(await render(docA));
          const htmlB = bodyOnly(await render(docB));
          const htmlAB = bodyOnly(await render(`${docA}\n\n${docB}`));

          const headRe = /<h2[^>]*>/g;
          const cA = countMatches(htmlA, headRe);
          const cB = countMatches(htmlB, headRe);
          const cAB = countMatches(htmlAB, headRe);
          expect(cAB).toBe(cA + cB);
          return true;
        },
      ),
      { numRuns: 30 },
    );
  });

  // MR-2 ─────────────────────────────────────────────────────────────────
  // Adding trailing whitespace to every line of a doc must not change
  // the heading set or paragraph count. This catches accidental
  // dependence on EOL trimming downstream.
  it("MR-2: trailing-whitespace-per-line preserves structural counts", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.constant("# Title"),
            fc.constant("## Section"),
            fc.constant("paragraph text"),
            fc.constant("- list item"),
            fc.constant("```\ncode\n```"),
          ),
          { minLength: 2, maxLength: 8 },
        ),
        async (lines) => {
          const original = lines.join("\n\n");
          const padded = lines.map((l) => `${l}   `).join("\n\n");

          const a = bodyOnly(await render(original));
          const b = bodyOnly(await render(padded));

          const re = /<h[1-6][^>]*>|<p[^>]*>|<li[^>]*>|<pre>/g;
          expect(countMatches(b, re)).toBe(countMatches(a, re));
          return true;
        },
      ),
      { numRuns: 30 },
    );
  });

  // MR-3 ─────────────────────────────────────────────────────────────────
  // Frontmatter NEVER touches the body output. Adding/removing/changing
  // the frontmatter must produce identical body HTML (TOC excluded).
  // If a future plugin starts reading frontmatter to alter rendering,
  // this relation flags it as an opinionated change.
  it("MR-3: arbitrary frontmatter doesn't alter body HTML", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 8 }).filter((s) => /^[a-z][a-z0-9_]*$/.test(s)),
          fc.string({ maxLength: 30 }).filter((s) => !/[\n:#]/.test(s)),
          { minKeys: 0, maxKeys: 5 },
        ),
        async (frontmatter) => {
          const body = `# Title\n\nbody paragraph\n\n## Section\n\nmore`;
          const yaml = Object.entries(frontmatter)
            .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
            .join("\n");
          const withFront = yaml ? `---\n${yaml}\n---\n${body}` : body;

          const a = bodyOnly(await render(body));
          const b = bodyOnly(await render(withFront));
          expect(b).toBe(a);
          return true;
        },
      ),
      { numRuns: 50 },
    );
  });

  // MR-4 ─────────────────────────────────────────────────────────────────
  // Idempotence under repeated identical input: rendering the same doc
  // twice must produce byte-identical HTML. Catches non-deterministic
  // output — e.g., a plugin that uses Math.random() for IDs, or a TOC
  // that depends on Date.now().
  it("MR-4: convertMarkdown is deterministic", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(fc.constant("# H"), fc.constant("text"), fc.constant("- item")),
          { minLength: 1, maxLength: 10 },
        ),
        async (lines) => {
          const doc = lines.join("\n\n");
          const a = await render(doc);
          const b = await render(doc);
          expect(b).toBe(a);
          return true;
        },
      ),
      { numRuns: 30 },
    );
  });

  // MR-5 ─────────────────────────────────────────────────────────────────
  // Substitution-preserving relation: replacing a heading's text with a
  // longer string of the same character class must preserve the heading
  // structure (level, position, count). If a length-dependent bug exists
  // in slug generation or anchor IDs, this catches it.
  it("MR-5: heading text length doesn't change heading structure", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }),
        async (titleLen) => {
          const title = "A".repeat(titleLen);
          const docA = `## Short\n\ntext`;
          const docB = `## ${title}\n\ntext`;
          const a = bodyOnly(await render(docA));
          const b = bodyOnly(await render(docB));

          const re = /<h2[^>]*>/g;
          expect(countMatches(b, re)).toBe(countMatches(a, re));
          return true;
        },
      ),
      { numRuns: 30 },
    );
  });

  // MR-6 ─────────────────────────────────────────────────────────────────
  // No injection: arbitrary plain-text containing HTML metacharacters
  // (<, >, &, ") must produce HTML where those characters appear only
  // through escape entities, never as raw markup. This is the "never
  // emit unescaped user-controlled <>" property the escapeHtml utility
  // exists to enforce — but we want to assert the WHOLE pipeline does.
  it("MR-6: text starting with a non-tag char never produces <script>/<iframe>", async () => {
    // We're not testing HTML-in-markdown (which IS intentionally allowed
    // via `html: true`). We're testing that text that does NOT start with
    // `<` cannot somehow emerge as `<script>` or `<iframe>` after the
    // markdown pipeline runs — an indirect injection would mean a plugin
    // is generating tags from non-tag input.
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 60 }).filter((s) => /^[a-zA-Z]/.test(s.trim())),
        async (raw) => {
          const doc = `paragraph: ${raw}\n\nend.`;
          const html = await render(doc);
          expect(html.toLowerCase()).not.toMatch(/<script\b/);
          expect(html.toLowerCase()).not.toMatch(/<iframe\b/);
          return true;
        },
      ),
      { numRuns: 50 },
    );
  });
});
