// Jazzer.js harness for the asciidoc xref/`<<>>` regex preprocessor.
// Three regexes run in sequence on raw text — fertile ground for ReDoS.
// We surface that by going through the public convertAdoc entry point and
// asserting it never throws and never escalates into a hang.
import { convertAdoc } from "../src/asciidoc.ts";

export async function fuzz(data: Buffer): Promise<void> {
  const input = data.toString("utf8");
  // Cap input size — fuzzers love to throw multi-MB blobs at us, but we want
  // the harness to test parser logic, not buffer-allocation paths.
  if (input.length > 16 * 1024) return;

  const result = await convertAdoc({
    filePath: "fuzz.adoc",
    fileContent: input,
    readFile: async () => null,
  });
  if (typeof result.html !== "string") {
    throw new Error("convertAdoc must return string html");
  }
}
