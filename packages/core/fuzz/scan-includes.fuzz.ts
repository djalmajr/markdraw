// Jazzer.js harness for the include-scanning regex paths.
// These regexes run on raw user content and must not ReDoS or throw.
import { scanIncludes } from "../src/asciidoc.ts";
import { scanMarkdownIncludes } from "../src/markdown.ts";

export function fuzz(data: Buffer): void {
  const input = data.toString("utf8");

  const adoc = scanIncludes(input);
  if (!Array.isArray(adoc)) throw new Error("scanIncludes must return Array");
  for (const target of adoc) {
    if (typeof target !== "string") throw new Error("include target must be string");
  }

  const md = scanMarkdownIncludes(input);
  if (!Array.isArray(md)) throw new Error("scanMarkdownIncludes must return Array");
  for (const target of md) {
    if (typeof target !== "string") throw new Error("include target must be string");
  }
}
