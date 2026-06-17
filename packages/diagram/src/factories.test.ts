import { describe, expect, test } from "bun:test";
import { arrow, bindArrow, box, createCtx, measureText, rect, text } from "./factories.ts";

describe("factories", () => {
  test("rect emits a rounded rectangle with defaults", () => {
    const ctx = createCtx();
    const r = rect(ctx, 10, 20, 100, 50);
    expect(r.type).toBe("rectangle");
    expect({ x: r.x, y: r.y, width: r.width, height: r.height }).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(r.strokeColor).toBe("#1e1e1e");
    expect(r.backgroundColor).toBe("transparent");
    expect(r.roundness).toEqual({ type: 3 });
    expect(r.strokeStyle).toBe("solid");
    expect(r.boundElements).toEqual([]);
  });

  test("rect honors dash + sharp corners", () => {
    const ctx = createCtx();
    const r = rect(ctx, 0, 0, 1, 1, { dash: true, rounded: false, bg: "#fff", stroke: "#abc" });
    expect(r.strokeStyle).toBe("dashed");
    expect(r.roundness).toBeNull();
    expect(r.backgroundColor).toBe("#fff");
    expect(r.strokeColor).toBe("#abc");
  });

  test("ids and seeds are deterministic and monotonic per context", () => {
    const ctx = createCtx();
    const a = rect(ctx, 0, 0, 1, 1);
    const b = rect(ctx, 0, 0, 1, 1);
    expect(a.id).toBe("el-1");
    expect(b.id).toBe("el-2");
    // each element burns two seeds (seed + versionNonce)
    expect(a.seed).toBe(100001);
    expect(a.versionNonce).toBe(100002);
    expect(b.seed).toBe(100003);
  });

  test("measureText scales with the longest line and line count", () => {
    const one = measureText("hello", 16);
    expect(one.width).toBeCloseTo(5 * 16 * 0.58, 5);
    expect(one.height).toBeCloseTo(1 * 16 * 1.25, 5);
    const two = measureText("hi\nworld!", 16);
    expect(two.width).toBeCloseTo(6 * 16 * 0.58, 5); // "world!" is longest
    expect(two.height).toBeCloseTo(2 * 16 * 1.25, 5);
  });

  test("text auto-sizes and carries text twice (text + originalText)", () => {
    const ctx = createCtx();
    const t = text(ctx, 0, 0, "abc", { size: 20 });
    expect(t.type).toBe("text");
    expect(t.text).toBe("abc");
    expect(t.originalText).toBe("abc");
    expect(t.width).toBeCloseTo(3 * 20 * 0.58, 5);
    expect(t.fontSize).toBe(20);
  });

  test("arrow stores points relative to its origin and sizes its bbox", () => {
    const ctx = createCtx();
    const a = arrow(ctx, [
      [100, 100],
      [100, 160],
      [200, 160],
    ]);
    expect(a.x).toBe(100);
    expect(a.y).toBe(100);
    expect(a.points).toEqual([
      [0, 0],
      [0, 60],
      [100, 60],
    ]);
    expect(a.width).toBe(100);
    expect(a.height).toBe(60);
    expect(a.endArrowhead).toBe("arrow");
    expect(a.startArrowhead).toBeNull();
  });

  test("arrow rejects fewer than 2 points", () => {
    const ctx = createCtx();
    expect(() => arrow(ctx, [[0, 0]])).toThrow();
  });

  test("box auto-computes height from body line count", () => {
    const ctx = createCtx();
    const noBody = box(ctx, 0, 0, 200, "Title", "");
    expect(noBody.height).toBe(54); // 44 + 0 + 10
    expect(noBody.body).toBeUndefined();
    expect(noBody.elements).toHaveLength(2);

    const ctx2 = createCtx();
    const withBody = box(ctx2, 0, 0, 200, "Title", "a\nb\nc");
    expect(withBody.height).toBe(44 + 3 * 18 + 10);
    expect(withBody.body).toBeDefined();
    expect(withBody.elements).toHaveLength(3);
  });

  test("box gives each element its own groupIds array (no shared mutation)", () => {
    const ctx = createCtx();
    const b = box(ctx, 0, 0, 200, "T", "body", { groupIds: ["g"] });
    // Independent arrays: mutating the rect's must not leak into title/body.
    b.rect.groupIds.push("x");
    expect(b.title.groupIds).toEqual(["g"]);
    expect(b.body!.groupIds).toEqual(["g"]);
    expect(b.rect.groupIds).toEqual(["g", "x"]);
  });

  test("bindArrow wires both endpoints and back-references", () => {
    const ctx = createCtx();
    const from = rect(ctx, 0, 0, 10, 10);
    const to = rect(ctx, 100, 0, 10, 10);
    const a = arrow(ctx, [
      [10, 5],
      [100, 5],
    ]);
    bindArrow(a, from, to, 6);
    expect(a.startBinding).toEqual({ elementId: from.id, focus: 0, gap: 6 });
    expect(a.endBinding).toEqual({ elementId: to.id, focus: 0, gap: 6 });
    expect(from.boundElements).toEqual([{ id: a.id, type: "arrow" }]);
    expect(to.boundElements).toEqual([{ id: a.id, type: "arrow" }]);
  });
});
