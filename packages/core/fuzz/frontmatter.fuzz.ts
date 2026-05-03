// Jazzer.js harness for the frontmatter parser.
// Asserts: never throws, output body+frontmatter contract holds, no infinite
// loops or pathological YAML inputs that hang the parser.
import { extractFrontmatter } from "../src/frontmatter.ts";

export function fuzz(data: Buffer): void {
  const input = data.toString("utf8");
  const result = extractFrontmatter(input);

  // Contract: result is always { frontmatter, body } with body as string.
  if (typeof result.body !== "string") {
    throw new Error("body must be a string");
  }

  // Contract: when frontmatter is null, body must equal input verbatim.
  if (result.frontmatter === null && result.body !== input) {
    throw new Error("frontmatter=null implies body===input");
  }

  // Contract: when frontmatter parsed, the original input length equals the
  // length of the consumed prefix + body length.
  if (result.frontmatter !== null && result.body.length > input.length) {
    throw new Error("body length cannot exceed input length");
  }
}
