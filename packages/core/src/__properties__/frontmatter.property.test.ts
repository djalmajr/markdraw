import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { extractFrontmatter } from "../frontmatter.ts";

describe("extractFrontmatter invariants (property)", () => {
  it("documents NOT starting with '---\\n' yield frontmatter=null and body=input", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/^---\r?\n/.test(s)),
        (input) => {
          const { frontmatter, body } = extractFrontmatter(input);
          expect(frontmatter).toBeNull();
          expect(body).toBe(input);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("when frontmatter is parsed, body never contains the closing '---' fence at position 0", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 10 }).filter((s) => /^[a-z][a-z0-9]*$/.test(s)),
          fc.oneof(
            fc.string({ maxLength: 20 }).filter((s) => !/[\n:#]/.test(s)),
            fc.integer(),
            fc.boolean(),
          ),
          { minKeys: 1, maxKeys: 5 },
        ),
        fc.string({ maxLength: 200 }),
        (yamlObj, suffix) => {
          const yaml = Object.entries(yamlObj)
            .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`)
            .join("\n");
          const input = `---\n${yaml}\n---\n${suffix}`;
          const { frontmatter, body } = extractFrontmatter(input);
          if (frontmatter !== null) {
            expect(body).toBe(suffix);
          }
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("never throws on arbitrary input (degrades gracefully)", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(() => extractFrontmatter(input)).not.toThrow();
        return true;
      }),
      { numRuns: 200 },
    );
  });
});
