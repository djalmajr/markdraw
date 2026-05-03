import { beforeEach, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { addRecentFile, clearRecentFiles, getRecentFiles, type RecentFile } from "../recent-files.ts";
import { installLocalStorageMock } from "../test-utils.ts";

installLocalStorageMock();

const fileArb: fc.Arbitrary<RecentFile> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 30 }),
  path: fc.string({ minLength: 1, maxLength: 60 }),
  rootName: fc.string({ minLength: 1, maxLength: 30 }),
  rootPath: fc.string({ minLength: 1, maxLength: 60 }),
});

describe("recent-files invariants (property)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("length is always <= MAX_RECENT (10) regardless of how many we add", () => {
    fc.assert(
      fc.property(fc.array(fileArb, { minLength: 0, maxLength: 50 }), (files) => {
        clearRecentFiles();
        for (const f of files) addRecentFile(f);
        expect(getRecentFiles().length).toBeLessThanOrEqual(10);
        return true;
      }),
      { numRuns: 50 },
    );
  });

  it("the most recently added file is always at index 0", () => {
    fc.assert(
      fc.property(fileArb, fileArb, (a, b) => {
        clearRecentFiles();
        addRecentFile(a);
        addRecentFile(b);
        const head = getRecentFiles()[0]!;
        // If a and b dedupe to the same key, b still wins (replaces).
        expect(head.path).toBe(b.path);
        expect(head.rootPath).toBe(b.rootPath);
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it("dedup key (path, rootPath) is enforced — distinct keys never collapse", () => {
    fc.assert(
      fc.property(fc.array(fileArb, { minLength: 1, maxLength: 20 }), (files) => {
        clearRecentFiles();
        for (const f of files) addRecentFile(f);
        const list = getRecentFiles();
        const keys = new Set(list.map((f) => `${f.rootPath}::${f.path}`));
        expect(keys.size).toBe(list.length);
        return true;
      }),
      { numRuns: 50 },
    );
  });
});
