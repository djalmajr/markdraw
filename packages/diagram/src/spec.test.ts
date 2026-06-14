import { describe, expect, test } from "bun:test";
import { parseSpec } from "./spec.ts";

describe("parseSpec", () => {
  test("accepts a minimal valid spec", () => {
    const result = parseSpec({
      nodes: [{ id: "a", lane: "left", title: "A" }],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.nodes).toHaveLength(1);
      expect(result.spec.nodes[0].id).toBe("a");
    }
  });

  test("accepts the full optional surface", () => {
    const result = parseSpec({
      title: { text: "T", subtitle: "s" },
      lanes: [{ id: "left", title: "Left", width: 300 }],
      groups: [{ id: "g", title: "G", nodes: ["a"], color: "#eee" }],
      nodes: [{ id: "a", lane: "left", title: "A", body: "x\ny", shape: "box", group: "g", style: { bg: "#fff" } }],
      edges: [{ from: "a", to: "a", kind: "data", label: "loop", dash: true }],
      styleHints: { laneGap: 80, nodeGap: 30, laneWidth: 280, origin: { x: 0, y: 0 } },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects a missing required field with a path-tagged issue", () => {
    const result = parseSpec({ nodes: [{ id: "a", lane: "left" }], edges: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.some((i) => i.includes("nodes.0.title"))).toBe(true);
    }
  });

  test("rejects an unknown edge kind", () => {
    const result = parseSpec({
      nodes: [{ id: "a", lane: "l", title: "A" }],
      edges: [{ from: "a", to: "a", kind: "telepathy" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a non-object input", () => {
    expect(parseSpec(null).ok).toBe(false);
    expect(parseSpec("nope").ok).toBe(false);
    expect(parseSpec(42).ok).toBe(false);
  });
});
