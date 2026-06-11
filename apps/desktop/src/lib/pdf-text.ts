// PDF → plain text for the AI tools: lets the model "read" a workspace PDF
// as paged text instead of raw bytes. Mirrors the media-viewer's pdf.js setup
// (packages/ui/src/components/media-viewer.tsx): the worker ships as a
// standalone vite asset resolved to a URL string at build time, while the
// heavy pdfjs runtime stays out of the initial bundle and is imported lazily
// on first use. Both imports are dynamic (not just the runtime): bun's
// mock.module only intercepts the `?url` virtual specifier on dynamic
// imports from other modules, so a static import would be untestable here.

/** Default page budget; beyond it the output ends with a truncation note. */
const DEFAULT_MAX_PAGES = 50;

/**
 * Extract a PDF's text, page by page. The output is self-describing (the
 * model is the consumer):
 *
 * - each page renders as a `[page N]` marker line followed by that page's
 *   text (pdf.js `hasEOL` runs become newlines, marked-content structural
 *   items are skipped);
 * - pages are joined with `\n\f\n` — a form feed on its own line — so the
 *   result splits back into pages on `\f`;
 * - when the document has more than `maxPages` pages, only the first
 *   `maxPages` are extracted and a final
 *   `[truncated: showing first X of Y pages]` block is appended.
 */
export async function extractPdfText(data: Uint8Array, maxPages = DEFAULT_MAX_PAGES): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  // pdf.js may transfer the buffer to its worker (detaching the caller's
  // view) — hand it a private copy.
  const doc = await pdfjs.getDocument({ data: data.slice() }).promise;
  try {
    const totalPages = doc.numPages;
    const limit = Math.min(totalPages, Math.max(1, Math.trunc(maxPages)));
    const blocks: string[] = [];
    for (let n = 1; n <= limit; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        // TextMarkedContent entries carry structure, not text — skip them.
        if (!("str" in item)) continue;
        text += item.str;
        if (item.hasEOL) text += "\n";
      }
      blocks.push(`[page ${n}]\n${text.trimEnd()}`);
    }
    if (totalPages > limit) {
      blocks.push(`[truncated: showing first ${limit} of ${totalPages} pages]`);
    }
    return blocks.join("\n\f\n");
  } finally {
    void doc.destroy();
  }
}
