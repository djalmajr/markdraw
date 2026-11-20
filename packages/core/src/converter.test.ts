import { describe, expect, it } from "bun:test";
import { createConverter } from "./converter.ts";

// A Worker stand-in that answers every request and keeps what it was sent.
function fakeWorker() {
  const sent: Array<Record<string, unknown>> = [];
  const worker = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage(msg: Record<string, unknown>) {
      sent.push(msg);
      queueMicrotask(() =>
        worker.onmessage?.({ data: { id: msg.id, html: "<p>ok</p>", error: null } } as MessageEvent),
      );
    },
  };
  return { worker: worker as unknown as Worker, sent };
}

describe("createConverter.convertAdoc — nested includes", () => {
  // main -> p0..p9 (direct), each p<i> -> n<i> (nested): the scout's fixture shape.
  const files: Record<string, string> = {};
  let main = "= Doc\n\n";
  for (let i = 0; i < 10; i++) {
    main += `include::p${i}.adoc[]\n`;
    files[`p${i}.adoc`] = `include::n${i}.adoc[]`;
    files[`n${i}.adoc`] = `leaf ${i}`;
  }

  it("with a batch reader: one read per layer (2 for 10 direct + 10 nested), none per file", async () => {
    const { worker, sent } = fakeWorker();
    const { convertAdoc } = createConverter(worker);
    let perFile = 0;
    const batches: string[][] = [];
    await convertAdoc({
      filePath: "main.adoc",
      fileContent: main,
      readFile: async () => { perFile++; return null; },
      readFiles: async (paths) => {
        batches.push([...paths]);
        return new Map(paths.filter((p) => p in files).map((p) => [p, files[p]!]));
      },
    });
    expect(batches.length).toBe(2);
    expect(batches[0]!.length).toBe(10);
    expect(batches[1]!.length).toBe(10);
    expect(perFile).toBe(0);
    // the worker still receives the whole include cache
    const cache = sent[0]!.includeCache as Record<string, string>;
    expect(Object.keys(cache).length).toBe(20);
  });

  it("without a batch reader it still collects everything, reading each file once", async () => {
    const { worker, sent } = fakeWorker();
    const { convertAdoc } = createConverter(worker);
    const reads: string[] = [];
    await convertAdoc({
      filePath: "main.adoc",
      fileContent: main,
      readFile: async (p) => { reads.push(p); return files[p] ?? null; },
    });
    expect(reads.length).toBe(20);
    expect(Object.keys(sent[0]!.includeCache as Record<string, string>).length).toBe(20);
  });
});
