import { describe, expect, it } from "bun:test";
import {
  computeReadingMetrics,
  computeReadingMetricsFromHtml,
  formatReadingTime,
} from "./reading-metrics.ts";

/**
 * Coverage shape — the goal is to prove the metric, not the regex.
 * Each test names a mutation that would flip it red, per
 * `wiki/testing/conventions.md`.
 */
describe("computeReadingMetrics", () => {
  it("returns zeros for empty content", () => {
    // Mutation: defaulting `words` to 1 (or any non-zero) on empty
    // input would render a misleading reading-time pill in the
    // status bar.
    const m = computeReadingMetrics("");
    expect(m.words).toBe(0);
    expect(m.readingTimeMs).toBe(0);
  });

  it("counts whitespace-separated runs as words (markdown body)", () => {
    // Mutation: collapsing `split(/\s+/)` to `split(" ")` would
    // miscount text with newlines / tabs.
    const m = computeReadingMetrics("alpha beta\tgamma\ndelta");
    expect(m.words).toBe(4);
  });

  it("counts 6 words in a sentence with markdown decorations (bold/code/link/text)", () => {
    // Mutation: stripping the *content* inside backticks/brackets
    // (instead of just the delimiters) would collapse `code` and
    // `link` to nothing — readers consume the words themselves,
    // so they must survive the strip.
    const m = computeReadingMetrics("**bold** and `code` and [link](http://x.test) text");
    expect(m.words).toBe(6);
  });

  it("ignores fenced code blocks (the user is reading prose, not source)", () => {
    // Mutation: dropping the fenced-code strip would inflate word
    // counts on docs heavy with code samples — making "reading
    // time" useless for technical content.
    const text = `intro paragraph here\n\n\`\`\`ts\nconst x = 1;\nconst y = 2;\nconsole.log(x + y);\n\`\`\`\n\nclosing paragraph`;
    const m = computeReadingMetrics(text);
    // "intro paragraph here closing paragraph" → 5 words
    expect(m.words).toBe(5);
  });

  it("ignores asciidoc source blocks", () => {
    // Mutation: removing the `----` listing block strip would
    // double-count adoc code samples the same way fenced blocks
    // were in the markdown case.
    const text = `intro paragraph here\n\n----\nfn main() { println!(\"hi\"); }\n----\n\nclosing paragraph`;
    const m = computeReadingMetrics(text);
    expect(m.words).toBe(5);
  });

  it("scales reading time linearly with word count at 220 wpm", () => {
    // Mutation: hardcoding wpm to a different baseline (e.g. 200)
    // would shift every value below — reading time is purely
    // words / wpm * 60_000.
    const m = computeReadingMetrics("a ".repeat(220).trim());
    expect(m.words).toBe(220);
    expect(m.readingTimeMs).toBe(60_000); // exactly 1 minute
  });

  it("respects a caller-supplied wpm override", () => {
    // Mutation: ignoring the second argument would make the
    // reader-preference setting silently no-op.
    const m = computeReadingMetrics("a ".repeat(110).trim(), 110);
    expect(m.readingTimeMs).toBe(60_000);
  });
});

describe("computeReadingMetricsFromHtml", () => {
  it("counts visible text only — ignores tags and attributes", () => {
    // Mutation: stripping tags with `replace(/<[^>]+>/g, "")` but
    // forgetting to also strip <script>/<style> contents would let
    // their bodies inflate the count.
    const html = "<p>hello <strong>world</strong></p>";
    const m = computeReadingMetricsFromHtml(html);
    expect(m.words).toBe(2);
  });

  it("expands `include::`-style content because asciidoctor inlined it during render", () => {
    // Regression: a README.adoc with `include::partials/intro.adoc[]`
    // shows full TOC + body in preview yet `editorContent` only has
    // the raw `include::` line. Counting against html catches the
    // expanded body the user actually reads.
    const html = `
      <h1>Outer</h1>
      <p>top paragraph</p>
      <section>
        <h2>Included section</h2>
        <p>body of include with several extra words</p>
      </section>
    `;
    const m = computeReadingMetricsFromHtml(html);
    // "Outer top paragraph Included section body of include with
    // several extra words" → 12 words.
    expect(m.words).toBe(12);
  });

  it("strips <pre><code> blocks (rendered fenced code) the same way it strips source fences", () => {
    // Mutation: leaving rendered code blocks in the count would
    // re-introduce the inflate-on-technical-docs problem the
    // fenced-block strip was designed to prevent.
    const html = `
      <p>intro paragraph</p>
      <pre><code>const a = 1; const b = 2;</code></pre>
      <p>outro paragraph</p>
    `;
    const m = computeReadingMetricsFromHtml(html);
    // "intro paragraph outro paragraph" → 4 words
    expect(m.words).toBe(4);
  });

  it("ignores embedded <script> and <style> bodies", () => {
    // Mutation: a naïve `innerText`-style implementation that
    // doesn't filter scripts / styles would count CSS and JS as
    // prose.
    const html = `<style>.x { color: red; }</style><p>just three words</p><script>var ignored = 'x';</script>`;
    const m = computeReadingMetricsFromHtml(html);
    expect(m.words).toBe(3);
  });

  it("decodes html entities so \"don&#39;t\" counts as one token, not two", () => {
    // Mutation: counting after entity escaping leaves `don&#39;t`
    // as raw text and inflates by one (`&#39` becomes its own
    // token).
    const html = "<p>users&nbsp;don&#39;t miss this</p>";
    const m = computeReadingMetricsFromHtml(html);
    // "users don't miss this" → 4 words
    expect(m.words).toBe(4);
  });
});

describe("formatReadingTime", () => {
  it("rounds up to 1 minute for any non-zero word count under a minute", () => {
    // Mutation: flooring instead of ceiling would render 0 min for
    // every short doc — the user wouldn't see anything in the bar.
    expect(formatReadingTime(15_000)).toBe("1 min");
    expect(formatReadingTime(1)).toBe("1 min");
  });

  it("rounds to nearest minute for longer durations", () => {
    expect(formatReadingTime(60_000)).toBe("1 min");
    expect(formatReadingTime(150_000)).toBe("3 min"); // 2.5 → 3
    expect(formatReadingTime(149_999)).toBe("2 min"); // just under 2.5
  });

  it("returns an empty string when there's nothing to display", () => {
    // Mutation: returning "0 min" instead would clutter the status
    // bar when no file is open.
    expect(formatReadingTime(0)).toBe("");
  });
});
