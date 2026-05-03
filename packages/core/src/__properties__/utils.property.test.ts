import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { escapeHtml, isAdocFile, isMdFile, isSupportedFile } from "../utils.ts";

describe("escapeHtml invariants (property)", () => {
  it("output never contains a raw < or > or unencoded \" or & followed by non-entity", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const out = escapeHtml(input);
        expect(out.includes("<")).toBe(false);
        expect(out.includes(">")).toBe(false);
        // Every `&` must start a valid escaped entity we emit.
        const ampPositions = [...out.matchAll(/&/g)].map((m) => m.index ?? 0);
        for (const i of ampPositions) {
          const tail = out.slice(i, i + 6);
          const ok =
            tail.startsWith("&amp;") ||
            tail.startsWith("&lt;") ||
            tail.startsWith("&gt;") ||
            tail.startsWith("&quot;");
          expect(ok).toBe(true);
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("idempotent on already-safe strings (no special chars)", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/[<>&"]/.test(s)),
        (s) => {
          expect(escapeHtml(s)).toBe(s);
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("file-extension predicates (property)", () => {
  it("isSupportedFile === isAdocFile || isMdFile for any input", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        expect(isSupportedFile(name)).toBe(isAdocFile(name) || isMdFile(name));
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("a name without a markdown/adoc-looking suffix is never supported", () => {
    fc.assert(
      fc.property(
        fc
          .string()
          .filter((s) => !/\.(md|markdown|mdown|adoc|asciidoc|asc|ad)$/i.test(s)),
        (s) => {
          expect(isSupportedFile(s)).toBe(false);
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
