import { describe, expect, it } from "bun:test";
import { countChanges, diffLines, type DiffOp } from "./line-diff.ts";

/** Reconstruct the old/new text from ops to assert round-trip fidelity. */
function reconstruct(ops: DiffOp[]): { old: string; next: string } {
  const oldLines = ops.filter((o) => o.type !== "add").map((o) => o.line);
  const newLines = ops.filter((o) => o.type !== "del").map((o) => o.line);
  return { old: oldLines.join("\n"), next: newLines.join("\n") };
}

describe("diffLines", () => {
  it("marks identical text as all-equal", () => {
    const ops = diffLines("a\nb\nc", "a\nb\nc");
    expect(ops.every((o) => o.type === "equal")).toBe(true);
    expect(countChanges(ops)).toBe(0);
  });

  it("detects a pure addition (lines appended)", () => {
    const ops = diffLines("a\nb", "a\nb\nc");
    expect(ops).toEqual([
      { type: "equal", line: "a" },
      { type: "equal", line: "b" },
      { type: "add", line: "c" },
    ]);
  });

  it("detects a pure deletion", () => {
    const ops = diffLines("a\nb\nc", "a\nc");
    expect(ops).toEqual([
      { type: "equal", line: "a" },
      { type: "del", line: "b" },
      { type: "equal", line: "c" },
    ]);
  });

  it("represents a single-line replace as del + add", () => {
    const ops = diffLines("a\nOLD\nc", "a\nNEW\nc");
    expect(ops).toEqual([
      { type: "equal", line: "a" },
      { type: "del", line: "OLD" },
      { type: "add", line: "NEW" },
      { type: "equal", line: "c" },
    ]);
    expect(countChanges(ops)).toBe(2);
  });

  it("keeps shared context lines around an interleaved change", () => {
    const ops = diffLines("h1\nx\nfoot", "h1\ny\nz\nfoot");
    // Round-trip must recover both sides exactly.
    const { old, next } = reconstruct(ops);
    expect(old).toBe("h1\nx\nfoot");
    expect(next).toBe("h1\ny\nz\nfoot");
    // h1 and foot stay as equal context (minimal change set).
    expect(ops.filter((o) => o.type === "equal").map((o) => o.line)).toEqual(["h1", "foot"]);
  });

  it("round-trips an arbitrary multi-edit block", () => {
    const oldText = "alpha\nbeta\ngamma\ndelta\nepsilon";
    const newText = "alpha\nBETA\ngamma\nepsilon\nzeta";
    const ops = diffLines(oldText, newText);
    const { old, next } = reconstruct(ops);
    expect(old).toBe(oldText);
    expect(next).toBe(newText);
  });

  it("treats a trailing newline as a final equal empty line", () => {
    const ops = diffLines("a\n", "a\n");
    expect(ops).toEqual([
      { type: "equal", line: "a" },
      { type: "equal", line: "" },
    ]);
  });

  it("falls back to a coarse replace for very large blocks (no LCS blowup)", () => {
    const big = Array.from({ length: 700 }, (_, i) => `l${i}`).join("\n");
    const big2 = Array.from({ length: 700 }, (_, i) => `m${i}`).join("\n");
    const ops = diffLines(big, big2);
    // All 700 old lines deleted, then all 700 new lines added.
    expect(ops.slice(0, 700).every((o) => o.type === "del")).toBe(true);
    expect(ops.slice(700).every((o) => o.type === "add")).toBe(true);
    const { old, next } = reconstruct(ops);
    expect(old).toBe(big);
    expect(next).toBe(big2);
  });
});
