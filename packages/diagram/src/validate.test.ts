import { describe, expect, test } from "bun:test";
import { createCtx } from "./factories.ts";
import { layout } from "./layout.ts";
import { route } from "./routing.ts";
import type { DiagramSpec } from "./spec.ts";
import { formatReport, validate } from "./validate.ts";

function check(spec: DiagramSpec) {
  const ctx = createCtx();
  const lay = layout(ctx, spec);
  const routes = route(ctx, lay, spec.edges);
  return validate(spec, lay, routes);
}

describe("validator", () => {
  test("a clean multi-lane diagram reports no errors", () => {
    const report = check({
      title: { text: "Clean" },
      nodes: [
        { id: "a", lane: "left", title: "A", body: "x" },
        { id: "b", lane: "right", title: "B" },
        { id: "c", lane: "left", title: "C" },
      ],
      edges: [
        { from: "a", to: "c" },
        { from: "a", to: "b", kind: "request" },
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);
  });

  test("detects node overlap (forced via a negative lane gap)", () => {
    const report = check({
      styleHints: { laneGap: -200 },
      nodes: [
        { id: "a", lane: "left", title: "A" },
        { id: "b", lane: "right", title: "B" },
      ],
      edges: [],
    });
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === "node-overlap")).toBe(true);
  });

  test("detects an arrow passing through a third node", () => {
    // a, m, b all on the first row of three adjacent lanes → the straight
    // horizontal a→b route slices through m.
    const report = check({
      nodes: [
        { id: "a", lane: "left", title: "A" },
        { id: "m", lane: "mid", title: "M" },
        { id: "b", lane: "right", title: "B" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    expect(report.ok).toBe(false);
    const hit = report.errors.find((e) => e.code === "line-through-box");
    expect(hit).toBeDefined();
    expect(hit!.ids).toContain("m");
  });

  test("flags a duplicate node id", () => {
    const report = check({
      nodes: [
        { id: "a", lane: "l", title: "A" },
        { id: "a", lane: "l", title: "A2" },
      ],
      edges: [],
    });
    expect(report.errors.some((e) => e.code === "duplicate-node-id")).toBe(true);
  });

  test("flags a dangling edge endpoint as an error", () => {
    const report = check({
      nodes: [{ id: "a", lane: "l", title: "A" }],
      edges: [{ from: "a", to: "ghost" }],
    });
    expect(report.errors.some((e) => e.code === "dangling-edge")).toBe(true);
  });

  test("warns on a group listing a non-existent node", () => {
    const report = check({
      groups: [{ id: "g", nodes: ["a", "missing"] }],
      nodes: [{ id: "a", lane: "l", title: "A" }],
      edges: [],
    });
    expect(report.warnings.some((w) => w.code === "group-member-missing")).toBe(true);
    expect(report.ok).toBe(true); // warning, not error
  });

  test("warns when a label overflows its box, but doesn't fail the build", () => {
    const report = check({
      nodes: [
        { id: "wide", lane: "l", title: "A title far too long to ever fit the default lane width" },
        { id: "fits", lane: "l", title: "Short" },
      ],
      edges: [],
    });
    const overflow = report.warnings.find((w) => w.code === "text-overflow");
    expect(overflow).toBeDefined();
    expect(overflow!.ids).toContain("wide");
    // the short label must NOT be flagged
    expect(report.warnings.some((w) => w.code === "text-overflow" && w.ids?.includes("fits"))).toBe(false);
    expect(report.ok).toBe(true); // advisory warning, not an error
  });

  test("flags an arrow that isn't reciprocally bound (binding guard)", () => {
    const spec: DiagramSpec = {
      nodes: [
        { id: "a", lane: "l", title: "A" },
        { id: "b", lane: "l", title: "B" },
      ],
      edges: [{ from: "a", to: "b" }],
    };
    const ctx = createCtx();
    const lay = layout(ctx, spec);
    const routes = route(ctx, lay, spec.edges);
    // The router always binds; strip it to simulate a regression / hand-built
    // scene. An unbound arrow won't follow a moved node — the guard must catch it.
    routes.routed[0].arrow.startBinding = null;
    routes.routed[0].arrow.endBinding = null;
    const report = validate(spec, lay, routes);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === "arrow-unbound")).toBe(true);
  });

  test("formatReport renders one line per issue", () => {
    const report = check({
      nodes: [{ id: "a", lane: "l", title: "A" }],
      edges: [{ from: "a", to: "ghost" }],
    });
    const txt = formatReport(report);
    expect(txt).toContain("dangling-edge");
    expect(txt.split("\n").length).toBe(report.issues.length);
  });
});
