// Standalone bench script with regression gate. Run with:
//   bun run packages/core/src/__bench__/conversion.bench.ts
//
// On the first run with no baseline.json, captures one and exits 0.
// On subsequent runs, compares mean wall-time per scenario against the
// committed baseline. Exits 1 if ANY scenario regresses by more than
// THRESHOLD_PCT (default 25%). The baseline is intentionally machine-
// scoped: a CI runner will see a different baseline.json than your
// laptop, so we key the baseline by `${platform}/${runtime}`.
//
// To intentionally accept a slowdown / capture a new baseline, run:
//   BENCH_UPDATE_BASELINE=1 bun run packages/core/src/__bench__/conversion.bench.ts
import { convertAdoc } from "../asciidoc.ts";
import { convertMarkdown } from "../markdown.ts";

const noopRead = async () => null;

function buildMarkdownDoc(headings: number, paraPerHeading: number): string {
  const lines: string[] = [];
  lines.push("---", "title: bench", "tags: [a, b]", "---", "");
  for (let i = 0; i < headings; i += 1) {
    lines.push(`## Heading ${i}`, "");
    for (let p = 0; p < paraPerHeading; p += 1) {
      lines.push(`Paragraph **${p}** with _emphasis_, \`code\`, and a [link](https://example.com).`);
      lines.push(
        `Here is a list item ${p}.1, ~~strike~~, ==mark==, ++ins++, ^sup^, ~sub~ and :smile:.`,
      );
    }
    lines.push("", "```ts", "function f() { return 42; }", "```", "");
    lines.push("> [!NOTE]", "> A note block.", "");
  }
  return lines.join("\n");
}

function buildAdocDoc(headings: number, paraPerHeading: number): string {
  const lines: string[] = [];
  lines.push("---", "title: bench", "---", "", "= Bench Doc", "");
  for (let i = 0; i < headings; i += 1) {
    lines.push(`== Heading ${i}`, "");
    for (let p = 0; p < paraPerHeading; p += 1) {
      lines.push(`Paragraph *${p}* with _emphasis_ and \`code\`. https://example.com[Link].`);
    }
    lines.push("", "[source,ts]", "----", "function f() { return 42; }", "----", "");
  }
  return lines.join("\n");
}

interface Stats {
  mean: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  iters: number;
}

function summarize(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
  return {
    mean: sum / sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    iters: sorted.length,
  };
}

async function timeIt(name: string, fn: () => Promise<unknown>, iters = 30, warmup = 3): Promise<Stats> {
  for (let i = 0; i < warmup; i += 1) await fn();
  const samples: number[] = [];
  for (let i = 0; i < iters; i += 1) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  const stats = summarize(samples);
  console.log(
    `${name.padEnd(48)} mean=${stats.mean.toFixed(2)}ms p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms min=${stats.min.toFixed(2)}ms max=${stats.max.toFixed(2)}ms n=${stats.iters}`,
  );
  return stats;
}

// ─── Regression gate ────────────────────────────────────────────────────────

const THRESHOLD_PCT = Number(process.env.BENCH_REGRESSION_PCT ?? "25");

interface Baseline {
  schema: 1;
  capturedAt: string;
  scenarios: Record<string, { mean: number; p95: number }>;
}

interface PlatformBaselines {
  [platformKey: string]: Baseline;
}

const baselinePath = `${import.meta.dir}/baseline.json`;
const platformKey = `${process.platform}-${process.arch}/bun-${Bun.version}`;

async function loadBaselines(): Promise<PlatformBaselines> {
  try {
    const text = await Bun.file(baselinePath).text();
    return JSON.parse(text) as PlatformBaselines;
  } catch {
    return {};
  }
}

async function saveBaselines(all: PlatformBaselines): Promise<void> {
  await Bun.write(baselinePath, `${JSON.stringify(all, null, 2)}\n`);
}

interface Regression {
  scenario: string;
  baselineMs: number;
  actualMs: number;
  pct: number;
}

function compareAgainst(prev: Baseline | undefined, current: Record<string, Stats>): Regression[] {
  if (!prev) return [];
  const out: Regression[] = [];
  for (const [scenario, now] of Object.entries(current)) {
    const before = prev.scenarios[scenario];
    if (!before) continue;
    const pct = ((now.mean - before.mean) / before.mean) * 100;
    if (pct > THRESHOLD_PCT) {
      out.push({
        scenario,
        baselineMs: before.mean,
        actualMs: now.mean,
        pct,
      });
    }
  }
  return out;
}

async function main(): Promise<number> {
  const mdSmall = buildMarkdownDoc(10, 5);
  const mdLarge = buildMarkdownDoc(80, 10);
  const adocSmall = buildAdocDoc(10, 5);
  const adocLarge = buildAdocDoc(80, 10);

  const results: Record<string, Stats> = {};

  console.log("\nMarkdown:");
  results["markdown:small"] = await timeIt("  small  (~10 headings, ~50 paragraphs)", () =>
    convertMarkdown({ filePath: "doc.md", fileContent: mdSmall, readFile: noopRead }),
  );
  results["markdown:large"] = await timeIt("  large  (~80 headings, ~800 paragraphs)", () =>
    convertMarkdown({ filePath: "doc.md", fileContent: mdLarge, readFile: noopRead }),
  );

  console.log("\nAsciiDoc:");
  results["asciidoc:small"] = await timeIt("  small  (~10 sections)", () =>
    convertAdoc({ filePath: "doc.adoc", fileContent: adocSmall, readFile: noopRead }),
  );
  results["asciidoc:large"] = await timeIt(
    "  large  (~80 sections)",
    () => convertAdoc({ filePath: "doc.adoc", fileContent: adocLarge, readFile: noopRead }),
    15,
  );

  const all = await loadBaselines();
  const prev = all[platformKey];
  const regressions = compareAgainst(prev, results);
  const update = process.env.BENCH_UPDATE_BASELINE === "1";
  const isFirstRun = !prev;

  if (update || isFirstRun) {
    all[platformKey] = {
      schema: 1,
      capturedAt: new Date().toISOString(),
      scenarios: Object.fromEntries(
        Object.entries(results).map(([k, v]) => [k, { mean: v.mean, p95: v.p95 }]),
      ),
    };
    await saveBaselines(all);
    if (isFirstRun) {
      console.log(`\n[bench] No baseline for ${platformKey}; captured a fresh one.`);
    } else {
      console.log(`\n[bench] BENCH_UPDATE_BASELINE=1 — overwrote baseline for ${platformKey}.`);
    }
    return 0;
  }

  if (regressions.length > 0) {
    console.log(`\n\x1b[1;31m✖ Regressions over +${THRESHOLD_PCT}% vs baseline (${platformKey}):\x1b[0m`);
    for (const r of regressions) {
      console.log(
        `   ${r.scenario.padEnd(20)} ${r.baselineMs.toFixed(2)}ms → ${r.actualMs.toFixed(2)}ms (+${r.pct.toFixed(1)}%)`,
      );
    }
    console.log(
      "\nIf this slowdown is intentional, accept it with:\n  BENCH_UPDATE_BASELINE=1 bun run packages/core/src/__bench__/conversion.bench.ts",
    );
    return 1;
  }

  console.log(`\n[bench] no regressions vs baseline (${platformKey}).`);
  return 0;
}

const code = await main();
process.exit(code);
