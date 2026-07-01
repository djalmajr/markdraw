import { describe, expect, it } from "bun:test";
import { djb2 } from "./hash.ts";

// Reference copy of the hand-rolled loop the shared helper replaced. If djb2
// ever drifts from this, every id/version format that embeds it regresses.
function reference(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

describe("djb2", () => {
  it("matches known base-36 digests", () => {
    expect(djb2("")).toBe("45h");
    expect(djb2("a")).toBe("3t3a");
    expect(djb2("hello")).toBe("4bj995");
    expect(djb2("The quick brown fox")).toBe("163xzi0");
    expect(djb2("advisor")).toBe("8zo68t");
    expect(djb2("line1\nline2")).toBe("1w35g2q");
  });

  it("stays byte-identical to the original hand-rolled loop", () => {
    for (const s of ["", "a", "hello", "日本語", "tab\tsep", "x".repeat(1000)]) {
      expect(djb2(s)).toBe(reference(s));
    }
  });
});
