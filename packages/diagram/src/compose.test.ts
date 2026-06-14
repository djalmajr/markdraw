import { describe, expect, test } from "bun:test";
import { composeBelow, elementsBounds, translateElements } from "./compose.ts";
import { createCtx, rect } from "./factories.ts";
import { generateFromSpec } from "./generate.ts";

describe("compose", () => {
  test("elementsBounds unions boxes; null when empty", () => {
    expect(elementsBounds([])).toBeNull();
    const ctx = createCtx();
    const a = rect(ctx, 10, 10, 100, 50);
    const b = rect(ctx, 200, 80, 40, 40);
    expect(elementsBounds([a, b])).toEqual({ x: 10, y: 10, width: 230, height: 110 });
  });

  test("translateElements shifts x/y and is a no-op for (0,0)", () => {
    const ctx = createCtx();
    const a = rect(ctx, 5, 5, 10, 10);
    const moved = translateElements([a], 3, 7);
    expect({ x: moved[0].x, y: moved[0].y }).toEqual({ x: 8, y: 12 });
    expect(a.x).toBe(5); // original untouched (immutable map)
    expect(translateElements([a], 0, 0)[0]).toEqual(a);
  });

  test("composeBelow stacks incoming under existing with a gap and no overlap", () => {
    const ctx = createCtx();
    const existing = [rect(ctx, 0, 0, 100, 100)]; // bottom at y=100
    const incoming = [rect(ctx, 0, -20, 50, 50)]; // its own top at y=-20
    const merged = composeBelow(existing, incoming, 40);
    expect(merged).toHaveLength(2);
    // incoming's top now sits at existing.bottom + gap = 140
    expect(merged[1].y).toBe(140);
  });

  test("composeBelow returns incoming unshifted when existing is empty", () => {
    const ctx = createCtx();
    const incoming = [rect(ctx, 7, 7, 10, 10)];
    expect(composeBelow([], incoming)).toEqual(incoming);
  });

  test("appending a generated diagram keeps it clear of prior content", () => {
    const existing = generateFromSpec({ nodes: [{ id: "a", lane: "l", title: "Old" }], edges: [] }).elements;
    const incoming = generateFromSpec({ nodes: [{ id: "b", lane: "l", title: "New" }], edges: [] }).elements;
    const merged = composeBelow(existing, incoming, 60);
    const eb = elementsBounds(existing)!;
    // every appended element starts at or below the existing block + gap
    const incomingStart = Math.min(...merged.slice(existing.length).map((e) => e.y));
    expect(incomingStart).toBeGreaterThanOrEqual(eb.y + eb.height);
  });
});
