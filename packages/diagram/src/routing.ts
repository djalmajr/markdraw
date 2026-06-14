// Edge routing + binding. Runs as a second pass over a LayoutResult: for each
// spec edge it picks anchor points on the two node cards, threads an orthogonal
// path between them (straight when the anchors align, an L/Z otherwise), and —
// crucially, unlike the Trapio prototype — BINDS the arrow to both shapes so it
// follows when a node is moved. Color/dash come from the edge kind via a palette.

import { arrow, bindArrow, text, type BuildCtx } from "./factories.ts";
import type { LayoutResult, PlacedNode } from "./layout.ts";
import type { EdgeKind, EdgeSpec } from "./spec.ts";
import type { ArrowElement, ArrowPoint, ExcalidrawElement, TextElement } from "./types.ts";

export const EDGE_PALETTE: Record<EdgeKind, string> = {
  request: "#1971c2",
  auth: "#e8590c",
  control: "#7048e8",
  data: "#2f9e44",
  default: "#495057",
};

export interface RoutedEdge {
  edge: EdgeSpec;
  arrow: ArrowElement;
  label?: TextElement;
  /** Absolute route points (before the arrow stores them relative to its x/y). */
  points: ArrowPoint[];
}

export interface SkippedEdge {
  edge: EdgeSpec;
  reason: string;
}

export interface RouteResult {
  /** Arrows then labels, in draw order (appended on top of the layout). */
  elements: ExcalidrawElement[];
  routed: RoutedEdge[];
  skipped: SkippedEdge[];
}

function center(n: PlacedNode): { x: number; y: number } {
  return { x: n.bounds.x + n.bounds.width / 2, y: n.bounds.y + n.bounds.height / 2 };
}

/** Compute an orthogonal route between two node cards. Horizontal lanes route
 *  through the gutter between them; same-column nodes route vertically. Returns
 *  absolute points, collapsing to a straight segment when the anchors align. */
function orthogonalRoute(from: PlacedNode, to: PlacedNode): ArrowPoint[] {
  const fc = center(from);
  const tc = center(to);
  const horizontal = Math.abs(tc.x - fc.x) >= Math.abs(tc.y - fc.y);

  if (horizontal) {
    const goingRight = tc.x >= fc.x;
    const startX = goingRight ? from.bounds.x + from.bounds.width : from.bounds.x;
    const endX = goingRight ? to.bounds.x : to.bounds.x + to.bounds.width;
    const startY = fc.y;
    const endY = tc.y;
    if (startY === endY) return [[startX, startY], [endX, endY]];
    const midX = (startX + endX) / 2;
    return [
      [startX, startY],
      [midX, startY],
      [midX, endY],
      [endX, endY],
    ];
  }

  const goingDown = tc.y >= fc.y;
  const startY = goingDown ? from.bounds.y + from.bounds.height : from.bounds.y;
  const endY = goingDown ? to.bounds.y : to.bounds.y + to.bounds.height;
  const startX = fc.x;
  const endX = tc.x;
  if (startX === endX) return [[startX, startY], [endX, endY]];
  const midY = (startY + endY) / 2;
  return [
    [startX, startY],
    [startX, midY],
    [endX, midY],
    [endX, endY],
  ];
}

function midpoint(points: ArrowPoint[]): { x: number; y: number } {
  // Geometric middle of the polyline by arclength — keeps labels near the visual
  // center even on L/Z routes.
  const segLengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    segLengths.push(len);
    total += len;
  }
  let target = total / 2;
  for (let i = 0; i < segLengths.length; i++) {
    if (target <= segLengths[i] || i === segLengths.length - 1) {
      const t = segLengths[i] === 0 ? 0 : target / segLengths[i];
      return {
        x: points[i][0] + (points[i + 1][0] - points[i][0]) * t,
        y: points[i][1] + (points[i + 1][1] - points[i][1]) * t,
      };
    }
    target -= segLengths[i];
  }
  return { x: points[0][0], y: points[0][1] };
}

export interface RouteOpts {
  /** Pixel gap Excalidraw keeps between arrowhead and shape. */
  gap?: number;
}

export function route(ctx: BuildCtx, layoutResult: LayoutResult, edges: EdgeSpec[], opts: RouteOpts = {}): RouteResult {
  const gap = opts.gap ?? 2;
  const elements: ExcalidrawElement[] = [];
  const labels: TextElement[] = [];
  const routed: RoutedEdge[] = [];
  const skipped: SkippedEdge[] = [];

  for (const edge of edges) {
    if (edge.from === edge.to) {
      skipped.push({ edge, reason: "self-edge (not routed)" });
      continue;
    }
    const from = layoutResult.nodes.get(edge.from);
    const to = layoutResult.nodes.get(edge.to);
    if (!from || !to) {
      skipped.push({ edge, reason: `dangling endpoint: ${!from ? edge.from : edge.to} not found` });
      continue;
    }
    const points = orthogonalRoute(from, to);
    const color = edge.color ?? EDGE_PALETTE[edge.kind ?? "default"];
    const arr = arrow(ctx, points, { color, dash: edge.dash });
    bindArrow(arr, from.rect, to.rect, gap);
    elements.push(arr);
    let label: TextElement | undefined;
    if (edge.label) {
      const m = midpoint(points);
      label = text(ctx, m.x + 6, m.y - 16, edge.label, { size: 11, color });
      labels.push(label);
    }
    routed.push({ edge, arrow: arr, label, points });
  }

  // Labels drawn after all arrows so they sit on top.
  elements.push(...labels);
  return { elements, routed, skipped };
}
