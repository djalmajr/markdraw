// Pure element factories — ported from the Trapio prototype's hand-rolled
// builders (scripts/gen-excalidraw.ts), but with NO module-global element array:
// each factory takes a build context (the id/seed counters) and RETURNS an
// element. The caller decides where to collect them. This is what makes the
// generator reusable and DOM-free — building an element is just data assembly.

import { createIds, createSeeds, type IdGen, type SeedGen } from "./ids.ts";
import type {
  ArrowElement,
  ArrowPoint,
  BoundingBox,
  Binding,
  ElementBase,
  RectangleElement,
  TextElement,
} from "./types.ts";

/** Per-diagram counters threaded through every factory so ids/seeds stay
 *  monotonic and deterministic within one build. */
export interface BuildCtx {
  id: IdGen;
  seed: SeedGen;
}

export function createCtx(): BuildCtx {
  return { id: createIds(), seed: createSeeds() };
}

const DEFAULT_STROKE = "#1e1e1e";

/** Text metrics without a DOM. Excalidraw measures glyphs against the real font;
 *  with no canvas we approximate width as `chars * fontSize * CHAR_WIDTH_FACTOR`
 *  (a monospace-ish heuristic ported from Trapio). Good enough for boxes whose
 *  width is driven by layout; documented as a known fidelity gap vs the editor. */
export const CHAR_WIDTH_FACTOR = 0.58;
export const LINE_HEIGHT = 1.25;

export function measureText(str: string, fontSize: number): { width: number; height: number } {
  const lines = str.split("\n");
  const longest = lines.reduce((max, l) => Math.max(max, l.length), 0);
  return {
    width: longest * fontSize * CHAR_WIDTH_FACTOR,
    height: lines.length * fontSize * LINE_HEIGHT,
  };
}

/** Shared element fields (Excalidraw's "common" block). Each call burns two
 *  seeds (seed + versionNonce) so distinct elements never collide. */
function common(ctx: BuildCtx): Pick<
  ElementBase,
  | "angle"
  | "fillStyle"
  | "strokeWidth"
  | "strokeStyle"
  | "roughness"
  | "opacity"
  | "groupIds"
  | "frameId"
  | "seed"
  | "versionNonce"
  | "version"
  | "isDeleted"
  | "boundElements"
  | "updated"
  | "link"
  | "locked"
> {
  return {
    angle: 0,
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    seed: ctx.seed(),
    versionNonce: ctx.seed(),
    version: 1,
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
  };
}

export interface RectOpts {
  bg?: string;
  stroke?: string;
  dash?: boolean;
  /** `false` → sharp corners (Excalidraw `roundness: null`). Default rounded. */
  rounded?: boolean;
  strokeWidth?: number;
  groupIds?: string[];
}

export function rect(ctx: BuildCtx, x: number, y: number, w: number, h: number, opts: RectOpts = {}): RectangleElement {
  return {
    id: ctx.id(),
    type: "rectangle",
    x,
    y,
    width: w,
    height: h,
    strokeColor: opts.stroke ?? DEFAULT_STROKE,
    backgroundColor: opts.bg ?? "transparent",
    roundness: opts.rounded === false ? null : { type: 3 },
    ...common(ctx),
    strokeStyle: opts.dash ? "dashed" : "solid",
    strokeWidth: opts.strokeWidth ?? 2,
    groupIds: opts.groupIds ?? [],
  };
}

export interface TextOpts {
  size?: number;
  color?: string;
  align?: "left" | "center" | "right";
  family?: number;
  groupIds?: string[];
}

export function text(ctx: BuildCtx, x: number, y: number, str: string, opts: TextOpts = {}): TextElement {
  const size = opts.size ?? 16;
  const { width, height } = measureText(str, size);
  return {
    id: ctx.id(),
    type: "text",
    x,
    y,
    width,
    height,
    strokeColor: opts.color ?? DEFAULT_STROKE,
    backgroundColor: "transparent",
    roundness: null,
    ...common(ctx),
    groupIds: opts.groupIds ?? [],
    fontSize: size,
    fontFamily: opts.family ?? 2,
    textAlign: opts.align ?? "left",
    verticalAlign: "top",
    containerId: null,
    originalText: str,
    text: str,
    lineHeight: LINE_HEIGHT,
    baseline: Math.round(size * 0.8),
    autoResize: true,
  };
}

export interface ArrowOpts {
  color?: string;
  dash?: boolean;
  startBinding?: Binding | null;
  endBinding?: Binding | null;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  groupIds?: string[];
}

/** Build an arrow from absolute `points` (each `[x,y]`). The element's x/y is the
 *  first point; stored points are made relative to it (Excalidraw's convention),
 *  and width/height are the points' bounding extent. */
export function arrow(ctx: BuildCtx, points: ArrowPoint[], opts: ArrowOpts = {}): ArrowElement {
  if (points.length < 2) throw new Error("arrow() needs at least 2 points");
  const [ox, oy] = points[0];
  const rel: ArrowPoint[] = points.map(([px, py]) => [px - ox, py - oy]);
  const xs = rel.map((p) => p[0]);
  const ys = rel.map((p) => p[1]);
  return {
    id: ctx.id(),
    type: "arrow",
    x: ox,
    y: oy,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    strokeColor: opts.color ?? "#495057",
    backgroundColor: "transparent",
    roundness: { type: 2 },
    ...common(ctx),
    strokeStyle: opts.dash ? "dashed" : "solid",
    groupIds: opts.groupIds ?? [],
    points: rel,
    lastCommittedPoint: null,
    startBinding: opts.startBinding ?? null,
    endBinding: opts.endBinding ?? null,
    startArrowhead: opts.startArrowhead ?? null,
    endArrowhead: opts.endArrowhead ?? "arrow",
  };
}

export interface BoxOpts {
  /** Explicit height; auto-computed from body line count when omitted. */
  h?: number;
  bg?: string;
  stroke?: string;
  titleColor?: string;
  bodyColor?: string;
  titleSize?: number;
  bodySize?: number;
  groupIds?: string[];
}

export interface BoxResult {
  rect: RectangleElement;
  title: TextElement;
  body?: TextElement;
  /** Effective height (computed or passed). */
  height: number;
  /** rect, title, and (optional) body in draw order. */
  elements: Array<RectangleElement | TextElement>;
  /** The box's outer bounds — handy for layout/routing. */
  bounds: BoundingBox;
}

/** Composite: a titled card (rect + title text + optional body text), mirroring
 *  the Trapio `box()` helper. Height auto-computes from the body line count when
 *  `h` is omitted: `44 + lines*18 + 10` (header band + per-line body + padding). */
export function box(
  ctx: BuildCtx,
  x: number,
  y: number,
  w: number,
  title: string,
  bodyStr: string,
  opts: BoxOpts = {},
): BoxResult {
  const bodyLines = bodyStr ? bodyStr.split("\n").length : 0;
  const h = opts.h ?? 44 + bodyLines * 18 + 10;
  // Each element gets its OWN groupIds array. Sharing one reference across the
  // rect/title/body means a later `.push` (e.g. assigning group membership in
  // layout.ts) lands on all three at once — triple-counting the id. Copy per use.
  const groupIds = opts.groupIds ?? [];
  const r = rect(ctx, x, y, w, h, { bg: opts.bg, stroke: opts.stroke, groupIds: [...groupIds] });
  const titleEl = text(ctx, x + 14, y + 12, title, {
    size: opts.titleSize ?? 16,
    color: opts.titleColor ?? DEFAULT_STROKE,
    groupIds: [...groupIds],
  });
  const elements: Array<RectangleElement | TextElement> = [r, titleEl];
  let bodyEl: TextElement | undefined;
  if (bodyStr) {
    bodyEl = text(ctx, x + 14, y + 40, bodyStr, {
      size: opts.bodySize ?? 12.5,
      color: opts.bodyColor ?? "#343a40",
      groupIds: [...groupIds],
    });
    elements.push(bodyEl);
  }
  return { rect: r, title: titleEl, body: bodyEl, height: h, elements, bounds: { x, y, width: w, height: h } };
}

/** Two-way bind an arrow to its endpoint shapes so the arrow follows when either
 *  shape moves (the key difference from Trapio, whose arrows were unbound and
 *  drifted on any relayout). Mutates the shapes' `boundElements`. */
export function bindArrow(arr: ArrowElement, from: ElementBase, to: ElementBase, gap = 4): void {
  arr.startBinding = { elementId: from.id, focus: 0, gap };
  arr.endBinding = { elementId: to.id, focus: 0, gap };
  from.boundElements.push({ id: arr.id, type: "arrow" });
  to.boundElements.push({ id: arr.id, type: "arrow" });
}
