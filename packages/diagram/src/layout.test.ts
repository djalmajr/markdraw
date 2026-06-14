import { describe, expect, test } from "bun:test";
import { createCtx } from "./factories.ts";
import { LAYOUT_DEFAULTS, layout } from "./layout.ts";
import { parseSpec, type DiagramSpec } from "./spec.ts";

function build(spec: DiagramSpec) {
  const parsed = parseSpec(spec);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return layout(createCtx(), parsed.spec);
}

describe("layout engine", () => {
  test("assigns x by lane order and stacks nodes within a lane", () => {
    const res = build({
      nodes: [
        { id: "a", lane: "left", title: "A" },
        { id: "b", lane: "left", title: "B" },
        { id: "c", lane: "right", title: "C" },
      ],
      edges: [],
    });
    const a = res.nodes.get("a")!;
    const b = res.nodes.get("b")!;
    const c = res.nodes.get("c")!;
    // lane "left" at x=0, "right" at 0 + laneWidth + laneGap
    expect(a.bounds.x).toBe(0);
    expect(c.bounds.x).toBe(LAYOUT_DEFAULTS.laneWidth + LAYOUT_DEFAULTS.laneGap);
    // a and b share a lane; b sits below a by a's height + nodeGap
    expect(b.bounds.x).toBe(0);
    expect(b.bounds.y).toBe(a.bounds.y + a.bounds.height + LAYOUT_DEFAULTS.nodeGap);
    // first node in the other lane starts at the same top as the first overall
    expect(c.bounds.y).toBe(a.bounds.y);
  });

  test("auto-sizes node height from body and pushes the next node down", () => {
    const res = build({
      nodes: [
        { id: "tall", lane: "l", title: "Tall", body: "1\n2\n3\n4\n5" },
        { id: "next", lane: "l", title: "Next" },
      ],
      edges: [],
    });
    const tall = res.nodes.get("tall")!;
    const next = res.nodes.get("next")!;
    expect(tall.bounds.height).toBe(44 + 5 * 18 + 10);
    expect(next.bounds.y).toBe(tall.bounds.y + tall.bounds.height + LAYOUT_DEFAULTS.nodeGap);
  });

  test("a title block shifts the first node row down", () => {
    const withTitle = build({
      title: { text: "Arch", subtitle: "sub" },
      nodes: [{ id: "a", lane: "l", title: "A" }],
      edges: [],
    });
    const without = build({ nodes: [{ id: "a", lane: "l", title: "A" }], edges: [] });
    expect(withTitle.nodes.get("a")!.bounds.y).toBe(
      without.nodes.get("a")!.bounds.y + LAYOUT_DEFAULTS.titleHeight,
    );
  });

  test("explicit lane widths and order are honored", () => {
    const res = build({
      lanes: [
        { id: "wide", width: 400 },
        { id: "narrow", width: 120 },
      ],
      nodes: [
        { id: "a", lane: "narrow", title: "A" },
        { id: "b", lane: "wide", title: "B" },
      ],
      edges: [],
    });
    expect(res.lanes[0].id).toBe("wide");
    expect(res.nodes.get("b")!.bounds.width).toBe(400);
    expect(res.nodes.get("a")!.bounds.x).toBe(400 + LAYOUT_DEFAULTS.laneGap);
    expect(res.nodes.get("a")!.bounds.width).toBe(120);
  });

  test("groups frame their member nodes and sit behind them in z-order", () => {
    const res = build({
      groups: [{ id: "g", title: "Cluster", nodes: ["a", "b"] }],
      nodes: [
        { id: "a", lane: "l", title: "A" },
        { id: "b", lane: "l", title: "B" },
        { id: "c", lane: "r", title: "C" },
      ],
      edges: [],
    });
    expect(res.groups).toHaveLength(1);
    const g = res.groups[0];
    const a = res.nodes.get("a")!;
    const b = res.nodes.get("b")!;
    // frame encloses both members (with padding)
    expect(g.bounds.x).toBeLessThan(a.bounds.x);
    expect(g.bounds.y).toBeLessThan(a.bounds.y);
    expect(g.bounds.x + g.bounds.width).toBeGreaterThan(b.bounds.x + b.bounds.width);
    // group frame drawn before any node card
    const firstNodeIdx = res.elements.findIndex((e) => e.id === a.rect.id);
    const groupIdx = res.elements.findIndex((e) => e.id === g.rect.id);
    expect(groupIdx).toBeLessThan(firstNodeIdx);
  });

  test("is deterministic for a fixed spec", () => {
    const spec: DiagramSpec = {
      nodes: [
        { id: "a", lane: "l", title: "A", body: "x" },
        { id: "b", lane: "r", title: "B" },
      ],
      edges: [],
    };
    const one = layout(createCtx(), spec);
    const two = layout(createCtx(), spec);
    expect(JSON.stringify(one.elements)).toBe(JSON.stringify(two.elements));
  });
});
