// Colocated tests for extractPdfText. pdfjs-dist is mocked (folder.test.ts
// mock.module style): bun has neither vite's `?url` asset resolution nor a
// PDF worker, so the suite drives a scripted fake document and pins the
// output contract — `[page N]` markers, form-feed joins, the maxPages cap,
// and the worker/byte-copy wiring.

import { beforeEach, describe, expect, it, mock } from "bun:test";

interface FakeTextItem {
  hasEOL?: boolean;
  str?: string;
  type?: string;
}

let destroyCount = 0;
let getDocumentArgs: unknown[] = [];
let getPageCalls: number[] = [];
let pageItems: FakeTextItem[][] = [];
let pageTextError: Error | null = null;
// Mutated (never reassigned): the mock factory runs once and caches this
// object, so resets must keep the reference alive.
const workerOptions = { workerSrc: "" };

mock.module("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "pdf.worker.test.mjs" }));
mock.module("pdfjs-dist", () => ({
  GlobalWorkerOptions: workerOptions,
  getDocument: (arg: unknown) => {
    getDocumentArgs.push(arg);
    return {
      promise: Promise.resolve({
        numPages: pageItems.length,
        destroy: async () => {
          destroyCount += 1;
        },
        getPage: async (n: number) => {
          getPageCalls.push(n);
          return {
            getTextContent: async () => {
              if (pageTextError) throw pageTextError;
              return { items: pageItems[n - 1] ?? [] };
            },
          };
        },
      }),
    };
  },
}));

import { extractPdfText } from "./pdf-text.ts";

beforeEach(() => {
  destroyCount = 0;
  getDocumentArgs = [];
  getPageCalls = [];
  pageItems = [];
  pageTextError = null;
  workerOptions.workerSrc = "";
});

describe("extractPdfText", () => {
  it("renders each page under a [page N] marker, honors hasEOL, joins with form feeds", async () => {
    // Mutation: dropping the `\f` join (or the marker) would hand the model
    // an unstructured blob it can't attribute to pages.
    pageItems = [
      [{ str: "Hello " }, { hasEOL: true, str: "world" }, { str: "second line" }],
      [{ str: "Page two" }],
    ];
    const out = await extractPdfText(new Uint8Array([1]));
    expect(out).toBe("[page 1]\nHello world\nsecond line\n\f\n[page 2]\nPage two");
    expect(destroyCount).toBe(1); // document released after a successful pass
  });

  it("skips marked-content items that carry structure but no text", async () => {
    pageItems = [[{ type: "beginMarkedContent" }, { str: "visible" }, { type: "endMarkedContent" }]];
    const out = await extractPdfText(new Uint8Array([1]));
    expect(out).toBe("[page 1]\nvisible");
  });

  it("caps at maxPages with a truncation note and never loads the dropped pages", async () => {
    pageItems = [[{ str: "p1" }], [{ str: "p2" }], [{ str: "p3" }], [{ str: "p4" }]];
    const out = await extractPdfText(new Uint8Array([1]), 2);
    expect(out).toBe("[page 1]\np1\n\f\n[page 2]\np2\n\f\n[truncated: showing first 2 of 4 pages]");
    // Mutation: iterating to numPages and slicing afterwards would still pay
    // the per-page extraction cost — the loop itself must stop at the cap.
    expect(getPageCalls).toEqual([1, 2]);
  });

  it("defaults the cap to 50 pages", async () => {
    pageItems = Array.from({ length: 52 }, (_, i) => [{ str: `p${i + 1}` }]);
    const out = await extractPdfText(new Uint8Array([1]));
    expect(out).toContain("[page 50]");
    expect(out).not.toContain("[page 51]");
    expect(out).toContain("[truncated: showing first 50 of 52 pages]");
  });

  it("wires the vite worker URL and hands pdf.js a private copy of the bytes", async () => {
    // Mutation: passing the caller's Uint8Array straight through would let
    // pdf.js transfer (detach) the caller's buffer to its worker.
    pageItems = [[{ str: "x" }]];
    const data = new Uint8Array([1, 2, 3]);
    await extractPdfText(data);
    expect(workerOptions.workerSrc).toBe("pdf.worker.test.mjs");
    const arg = getDocumentArgs[0] as { data: Uint8Array };
    expect(Array.from(arg.data)).toEqual([1, 2, 3]);
    expect(arg.data).not.toBe(data);
  });

  it("destroys the document even when text extraction throws", async () => {
    pageItems = [[{ str: "x" }]];
    pageTextError = new Error("boom");
    await expect(extractPdfText(new Uint8Array([1]))).rejects.toThrow("boom");
    expect(destroyCount).toBe(1);
  });
});
