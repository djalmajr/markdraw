import { describe, expect, test } from "bun:test";
import { generate, generateFromSpec } from "../generate.ts";
import { trapioSpec } from "./trapio.spec.ts";

describe("trapio parity fixture", () => {
  test("the full architecture spec parses, builds, and validates with zero errors", () => {
    const built = generate(trapioSpec);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.report.ok).toBe(true);
    expect(built.report.errors).toEqual([]);
  });

  test("every spec node is placed and every non-skipped edge is routed", () => {
    const res = generateFromSpec(trapioSpec);
    expect(res.layout.nodes.size).toBe(trapioSpec.nodes.length);
    expect(res.routing.routed.length + res.routing.skipped.length).toBe(trapioSpec.edges.length);
    expect(res.routing.skipped).toEqual([]); // the spec is designed to route cleanly
  });

  test("the cluster group frames all its members", () => {
    const res = generateFromSpec(trapioSpec);
    expect(res.layout.groups).toHaveLength(1);
    const cluster = res.layout.groups[0];
    for (const id of trapioSpec.groups![0].nodes!) {
      const node = res.layout.nodes.get(id)!;
      expect(node.bounds.x).toBeGreaterThanOrEqual(cluster.bounds.x);
      expect(node.bounds.y).toBeGreaterThanOrEqual(cluster.bounds.y);
      expect(node.bounds.x + node.bounds.width).toBeLessThanOrEqual(cluster.bounds.x + cluster.bounds.width);
    }
  });

  test("generation is deterministic", () => {
    const a = generateFromSpec(trapioSpec);
    const b = generateFromSpec(trapioSpec);
    expect(JSON.stringify(a.elements)).toBe(JSON.stringify(b.elements));
  });
});
