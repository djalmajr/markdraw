// The layout engine: a PURE function `spec -> positioned elements`. This is the
// piece the Trapio prototype never had — there, every box sat at a hand-tuned
// absolute coordinate. Here the spec only says WHICH lane a node lives in and in
// WHAT order; the engine assigns x (from the lane) and y (stacked within the
// lane), auto-sizes node height from its text, and frames groups. Routing of
// edges happens in a second pass (routing.ts) over this result.

import { box, rect, text, type BuildCtx } from "./factories.ts";
import type { DiagramSpec, GroupSpec, NodeSpec } from "./spec.ts";
import type { BoundingBox, ExcalidrawElement, RectangleElement, TextElement } from "./types.ts";

/** A node after placement: its spec, its outer bounds, and the elements drawn. */
export interface PlacedNode {
  id: string;
  spec: NodeSpec;
  bounds: BoundingBox;
  rect: RectangleElement;
  title: TextElement;
  body?: TextElement;
}

export interface ResolvedLane {
  id: string;
  title?: string;
  /** Left edge x of the lane's column. */
  x: number;
  width: number;
}

export interface PlacedGroup {
  id: string;
  spec: GroupSpec;
  bounds: BoundingBox;
  rect: RectangleElement;
}

export interface LayoutResult {
  /** Drawn back-to-front: group frames, title, then node cards. Arrows are
   *  appended later by the router. */
  elements: ExcalidrawElement[];
  nodes: Map<string, PlacedNode>;
  lanes: ResolvedLane[];
  groups: PlacedGroup[];
  /** Bounding box of all placed content (excludes the title block's left bleed). */
  bounds: BoundingBox;
}

export interface LayoutDefaults {
  laneWidth: number;
  laneGap: number;
  nodeGap: number;
  originX: number;
  originY: number;
  titleHeight: number;
  laneHeaderHeight: number;
  groupPad: number;
  groupTitlePad: number;
}

export const LAYOUT_DEFAULTS: LayoutDefaults = {
  laneWidth: 280,
  laneGap: 90, // gutter wide enough for the router to thread arrows between lanes
  nodeGap: 28,
  originX: 0,
  originY: 0,
  titleHeight: 80,
  laneHeaderHeight: 28,
  groupPad: 16,
  groupTitlePad: 22,
};

/** Resolve the lane order + geometry. Explicit `spec.lanes` set the order and
 *  any per-lane width/title; any lane referenced by a node but absent from the
 *  explicit list is appended in first-seen order (so the engine never drops a
 *  node — the validator can still flag the omission). */
function resolveLanes(spec: DiagramSpec, d: LayoutDefaults): ResolvedLane[] {
  const order: string[] = [];
  const meta = new Map<string, { title?: string; width?: number }>();
  for (const lane of spec.lanes ?? []) {
    if (!meta.has(lane.id)) order.push(lane.id);
    meta.set(lane.id, { title: lane.title, width: lane.width });
  }
  for (const node of spec.nodes) {
    if (!meta.has(node.lane)) {
      order.push(node.lane);
      meta.set(node.lane, {});
    }
  }
  const laneWidth = spec.styleHints?.laneWidth ?? d.laneWidth;
  const laneGap = spec.styleHints?.laneGap ?? d.laneGap;
  let x = spec.styleHints?.origin?.x ?? d.originX;
  const lanes: ResolvedLane[] = [];
  for (const id of order) {
    const m = meta.get(id) ?? {};
    const width = m.width ?? laneWidth;
    lanes.push({ id, title: m.title, x, width });
    x += width + laneGap;
  }
  return lanes;
}

/** Lay a spec out into positioned elements. Deterministic: same spec + same
 *  context counters → byte-identical output. */
export function layout(ctx: BuildCtx, spec: DiagramSpec, defaults: Partial<LayoutDefaults> = {}): LayoutResult {
  const d = { ...LAYOUT_DEFAULTS, ...defaults };
  const nodeGap = spec.styleHints?.nodeGap ?? d.nodeGap;
  const originY = spec.styleHints?.origin?.y ?? d.originY;

  const lanes = resolveLanes(spec, d);
  const laneById = new Map(lanes.map((l) => [l.id, l]));

  const titleElements: TextElement[] = [];
  let topY = originY;
  if (spec.title) {
    titleElements.push(text(ctx, lanes[0]?.x ?? d.originX, topY, spec.title.text, { size: 28 }));
    if (spec.title.subtitle) {
      titleElements.push(text(ctx, lanes[0]?.x ?? d.originX, topY + 38, spec.title.subtitle, { size: 14, color: "#868e96" }));
    }
    topY += d.titleHeight;
  }

  const hasLaneHeaders = lanes.some((l) => l.title);
  const laneHeaderElements: TextElement[] = [];
  if (hasLaneHeaders) {
    for (const lane of lanes) {
      if (lane.title) laneHeaderElements.push(text(ctx, lane.x, topY, lane.title, { size: 13, color: "#495057" }));
    }
    topY += d.laneHeaderHeight;
  }

  // Stack nodes within each lane, top→down, in spec order.
  const laneCursor = new Map<string, number>(lanes.map((l) => [l.id, topY]));
  const nodes = new Map<string, PlacedNode>();
  const nodeElements: ExcalidrawElement[] = [];
  for (const node of spec.nodes) {
    const lane = laneById.get(node.lane);
    if (!lane) continue; // unreachable: resolveLanes guarantees coverage
    const y = laneCursor.get(lane.id) ?? topY;
    const built = box(ctx, lane.x, y, lane.width, node.title, node.body ?? "", {
      bg: node.style?.bg ?? "#f8f9fa",
      stroke: node.style?.stroke,
      titleColor: node.style?.titleColor,
      bodyColor: node.style?.bodyColor,
    });
    nodes.set(node.id, { id: node.id, spec: node, bounds: built.bounds, rect: built.rect, title: built.title, body: built.body });
    nodeElements.push(...built.elements);
    laneCursor.set(lane.id, y + built.height + nodeGap);
  }

  // Frame groups AFTER node placement (we need their member bounds). Drawn first
  // in z-order so they sit behind the node cards.
  const groups: PlacedGroup[] = [];
  const groupElements: ExcalidrawElement[] = [];
  for (const g of spec.groups ?? []) {
    const members = (g.nodes ?? []).map((id) => nodes.get(id)).filter((n): n is PlacedNode => n != null);
    if (members.length === 0) continue;
    const bounds = padBounds(unionBounds(members.map((m) => m.bounds)), d.groupPad, g.title ? d.groupTitlePad : d.groupPad);
    const r = rect(ctx, bounds.x, bounds.y, bounds.width, bounds.height, { dash: true, stroke: g.color ?? "#adb5bd" });
    groups.push({ id: g.id, spec: g, bounds, rect: r });
    groupElements.push(r);
    if (g.title) groupElements.push(text(ctx, bounds.x + 10, bounds.y + 6, g.title, { size: 12, color: g.color ?? "#868e96" }));
  }

  const contentBoxes = [
    ...[...nodes.values()].map((n) => n.bounds),
    ...groups.map((g) => g.bounds),
  ];
  const bounds = contentBoxes.length ? unionBounds(contentBoxes) : { x: originY, y: originY, width: 0, height: 0 };

  return {
    elements: [...groupElements, ...titleElements, ...laneHeaderElements, ...nodeElements],
    nodes,
    lanes,
    groups,
    bounds,
  };
}

function unionBounds(boxes: BoundingBox[]): BoundingBox {
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function padBounds(b: BoundingBox, pad: number, topPad: number): BoundingBox {
  return { x: b.x - pad, y: b.y - topPad, width: b.width + pad * 2, height: b.height + topPad + pad };
}
