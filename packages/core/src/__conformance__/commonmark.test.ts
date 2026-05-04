// Run the official CommonMark v0.31.2 conformance suite (~650 examples)
// against our convertMarkdown pipeline. The pipeline ships extensions
// beyond CommonMark (KaTeX, alerts, emoji, etc.) which by design diverge
// from spec output for some inputs — we therefore measure conformance
// rate per section and treat it as a tracked metric, not a strict pass.
//
// The bare-CommonMark sections (paragraphs, ATX headings, simple lists,
// emphasis, links) are expected to land at very high conformance.
// Sections heavily affected by our plugins (HTML blocks, raw inline HTML)
// will show known drift — recorded as documentation of the trade-off.
import { describe, expect, it } from "bun:test";
import spec from "./spec.json" with { type: "json" };
import { convertMarkdown } from "../markdown.ts";

interface SpecCase {
  markdown: string;
  html: string;
  example: number;
  start_line: number;
  end_line: number;
  section: string;
}

const cases = spec as SpecCase[];

const noopRead = async () => null;

/**
 * Normalize HTML for tolerant comparison. The CommonMark reference rendering
 * differs cosmetically from any real implementation in:
 *   - whitespace at line boundaries
 *   - attribute order
 *   - self-closing slash on void elements (<br /> vs <br>)
 *
 * We collapse those so the comparison hits structural differences only.
 */
function normalize(html: string): string {
  return html
    .replace(/\s+/g, " ")
    .replace(/\s*\/?>/g, ">")
    .replace(/<br ?\/?>/g, "<br>")
    .trim();
}

/**
 * Strip our pipeline's TOC wrapper before comparing — CommonMark spec output
 * has no notion of TOC.
 */
async function ourCommonMarkBody(markdown: string): Promise<string> {
  const { html } = await convertMarkdown({
    filePath: "spec.md",
    fileContent: markdown,
    readFile: noopRead,
  });
  return html.replace(/<div id="toc"[\s\S]*?<\/div>\s*<\/div>\s*/, "");
}

interface SectionStats {
  total: number;
  pass: number;
  fail: number;
}

const stats = new Map<string, SectionStats>();

async function runOne(c: SpecCase): Promise<boolean> {
  const ours = await ourCommonMarkBody(c.markdown);
  return normalize(ours) === normalize(c.html);
}

describe("CommonMark v0.31.2 conformance suite", () => {
  it("runs the entire spec and reports pass-rate per section", async () => {
    for (const c of cases) {
      const ok = await runOne(c);
      const s =
        stats.get(c.section) ?? { total: 0, pass: 0, fail: 0 };
      s.total += 1;
      if (ok) s.pass += 1;
      else s.fail += 1;
      stats.set(c.section, s);
    }

    const overall = [...stats.values()].reduce(
      (acc, s) => ({
        total: acc.total + s.total,
        pass: acc.pass + s.pass,
        fail: acc.fail + s.fail,
      }),
      { total: 0, pass: 0, fail: 0 },
    );

    // Print the report so it shows up in CI logs / `bun test` output.
    /* eslint-disable no-console */
    console.log("\n── CommonMark conformance per section ─────────────");
    const sorted = [...stats.entries()].sort(
      ([, a], [, b]) => b.pass / b.total - a.pass / a.total,
    );
    for (const [section, s] of sorted) {
      const pct = ((s.pass / s.total) * 100).toFixed(1).padStart(5);
      console.log(
        `  ${pct}%  ${section.padEnd(36)} (${s.pass}/${s.total})`,
      );
    }
    console.log(
      `\n  Total: ${overall.pass}/${overall.total} (${((overall.pass / overall.total) * 100).toFixed(1)}%)`,
    );
    /* eslint-enable no-console */

    // Floor: don't let total conformance regress below 60%. Most failures
    // are HTML-block / autolink edge cases or our plugin extensions that
    // intentionally augment output. Bumping this threshold over time is
    // the gate for "we got more spec-conformant".
    expect(overall.pass).toBeGreaterThanOrEqual(Math.floor(overall.total * 0.6));
  }, 60_000);
});
