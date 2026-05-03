import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { makeTabId, parseTabId } from "../tabs.ts";

// The tabId encoding is `${rootId}::${filePath}` and parseTabId splits on the
// FIRST `::`. The encoding is unambiguous as long as rootId does not contain
// `::` AND its concatenation with the separator does not introduce a new
// `::` boundary — that means rootId must not end with `:`. Capturing that
// constraint as a property helps document the invariant explicitly.

const safeRootIdArb = fc.string().filter((s) => !s.includes("::") && !s.endsWith(":"));

describe("tab id (property)", () => {
  it("parseTabId(makeTabId(r, p)) round-trips when rootId is unambiguous", () => {
    fc.assert(
      fc.property(safeRootIdArb, fc.string(), (rootId, filePath) => {
        const tabId = makeTabId(rootId, filePath);
        expect(parseTabId(tabId)).toEqual({ rootId, filePath });
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("filePaths containing :: survive when rootId is unambiguous", () => {
    fc.assert(
      fc.property(
        safeRootIdArb,
        fc.string(),
        fc.string(),
        (rootId, before, after) => {
          const filePath = `${before}::${after}`;
          const tabId = makeTabId(rootId, filePath);
          expect(parseTabId(tabId)).toEqual({ rootId, filePath });
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("makeTabId always contains :: as a separator", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (rootId, filePath) => {
        expect(makeTabId(rootId, filePath)).toContain("::");
        return true;
      }),
      { numRuns: 100 },
    );
  });
});
