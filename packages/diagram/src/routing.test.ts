import { describe, expect, test } from "bun:test";
import { createCtx } from "./factories.ts";
import { layout } from "./layout.ts";
import { EDGE_PALETTE, route } from "./routing.ts";
import type { DiagramSpec } from "./spec.ts";

function pipeline(spec: DiagramSpec) {
  const ctx = createCtx();
  const lay = layout(ctx, spec);
  const routes = route(ctx, lay, spec.edges);
  return { lay, routes };
}

describe("edge routing", () => {
  test("same-lane aligned nodes get a straight vertical arrow, top→bottom", () => {
    const { lay, routes } = pipeline({
      nodes: [
        { id: "a", lane: "l", title: "A" },
        { id: "b", lane: "l", title: "B" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const a = lay.nodes.get("a")!;
    const b = lay.nodes.get("b")!;
    const r = routes.routed[0];
    expect(r.points).toEqual([
      [a.bounds.x + a.bounds.width / 2, a.bounds.y + a.bounds.height],
      [b.bounds.x + b.bounds.width / 2, b.bounds.y],
    ]);
  });

  test("cross-lane nodes route horizontally out of the right edge into the left edge", () => {
    const { lay, routes } = pipeline({
      nodes: [
        { id: "a", lane: "left", title: "A" },
        { id: "b", lane: "right", title: "B" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const a = lay.nodes.get("a")!;
    const b = lay.nodes.get("b")!;
    const r = routes.routed[0];
    // both are first in their lanes → aligned y → straight horizontal
    expect(r.points[0]).toEqual([a.bounds.x + a.bounds.width, a.bounds.y + a.bounds.height / 2]);
    expect(r.points[r.points.length - 1]).toEqual([b.bounds.x, b.bounds.y + b.bounds.height / 2]);
  });

  test("misaligned cross-lane nodes get an orthogonal Z route through the gutter", () => {
    const { routes } = pipeline({
      nodes: [
        { id: "a", lane: "left", title: "A" },
        { id: "x", lane: "right", title: "X" }, // pushes b down in the right lane
        { id: "b", lane: "right", title: "B" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const r = routes.routed[0];
    expect(r.points).toHaveLength(4); // start, two bends, end
    // the two middle points share the gutter mid-x (a vertical jog)
    expect(r.points[1][0]).toBe(r.points[2][0]);
  });

  test("arrows bind to both endpoints so they follow on move", () => {
    const { lay, routes } = pipeline({
      nodes: [
        { id: "a", lane: "l", title: "A" },
        { id: "b", lane: "l", title: "B" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const a = lay.nodes.get("a")!;
    const b = lay.nodes.get("b")!;
    const arr = routes.routed[0].arrow;
    expect(arr.startBinding?.elementId).toBe(a.rect.id);
    expect(arr.endBinding?.elementId).toBe(b.rect.id);
    expect(a.rect.boundElements).toContainEqual({ id: arr.id, type: "arrow" });
    expect(b.rect.boundElements).toContainEqual({ id: arr.id, type: "arrow" });
  });

  test("edge kind selects the palette color; explicit color overrides", () => {
    const { routes } = pipeline({
      nodes: [
        { id: "a", lane: "l", title: "A" },
        { id: "b", lane: "l", title: "B" },
        { id: "c", lane: "l", title: "C" },
      ],
      edges: [
        { from: "a", to: "b", kind: "auth" },
        { from: "b", to: "c", color: "#000000" },
      ],
    });
    expect(routes.routed[0].arrow.strokeColor).toBe(EDGE_PALETTE.auth);
    expect(routes.routed[1].arrow.strokeColor).toBe("#000000");
  });

  test("labels are emitted near the route midpoint and drawn after arrows", () => {
    const { routes } = pipeline({
      nodes: [
        { id: "a", lane: "l", title: "A" },
        { id: "b", lane: "l", title: "B" },
      ],
      edges: [{ from: "a", to: "b", label: "calls" }],
    });
    expect(routes.routed[0].label).toBeDefined();
    expect(routes.routed[0].label!.text).toBe("calls");
    // arrow comes before label in the element list
    const arrIdx = routes.elements.findIndex((e) => e.type === "arrow");
    const lblIdx = routes.elements.findIndex((e) => e.type === "text");
    expect(arrIdx).toBeLessThan(lblIdx);
  });

  test("skips self-edges and dangling endpoints with a reason", () => {
    const { routes } = pipeline({
      nodes: [{ id: "a", lane: "l", title: "A" }],
      edges: [
        { from: "a", to: "a" },
        { from: "a", to: "ghost" },
      ],
    });
    expect(routes.routed).toHaveLength(0);
    expect(routes.skipped).toHaveLength(2);
    expect(routes.skipped[0].reason).toContain("self-edge");
    expect(routes.skipped[1].reason).toContain("dangling");
  });
});
