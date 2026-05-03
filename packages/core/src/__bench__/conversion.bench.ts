// Standalone bench script. Run with: bun run packages/core/src/__bench__/conversion.bench.ts
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

async function main(): Promise<void> {
  const mdSmall = buildMarkdownDoc(10, 5);
  const mdLarge = buildMarkdownDoc(80, 10);
  const adocSmall = buildAdocDoc(10, 5);
  const adocLarge = buildAdocDoc(80, 10);

  console.log("\nMarkdown:");
  await timeIt("  small  (~10 headings, ~50 paragraphs)", () =>
    convertMarkdown({ filePath: "doc.md", fileContent: mdSmall, readFile: noopRead }),
  );
  await timeIt("  large  (~80 headings, ~800 paragraphs)", () =>
    convertMarkdown({ filePath: "doc.md", fileContent: mdLarge, readFile: noopRead }),
  );

  console.log("\nAsciiDoc:");
  await timeIt("  small  (~10 sections)", () =>
    convertAdoc({ filePath: "doc.adoc", fileContent: adocSmall, readFile: noopRead }),
  );
  await timeIt(
    "  large  (~80 sections)",
    () => convertAdoc({ filePath: "doc.adoc", fileContent: adocLarge, readFile: noopRead }),
    15,
  );

  // Persist a baseline so CI / future runs can compare regressions.
  const baseline = {
    timestamp: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    platform: `${process.platform}-${process.arch}`,
  };
  await Bun.write(
    `${import.meta.dir}/last-run.json`,
    JSON.stringify(baseline, null, 2),
  );
}

await main();
