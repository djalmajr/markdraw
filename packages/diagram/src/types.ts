// Minimal, hand-rolled TypeScript model of the Excalidraw on-disk element schema
// — only the fields this generator actually emits. We deliberately do NOT depend
// on @excalidraw/excalidraw for these types: its runtime entry pulls react-dom
// and touches `window` at module scope (so it can't be imported in Bun/Node),
// and installing it only for `.d.ts` would drag a heavy tree into a package whose
// whole point is to stay dependency-light and DOM-free. Conformance to the real
// schema is held by golden snapshots + the validator, pinned to the guest's
// Excalidraw 0.18.1 (apps/desktop/.cache/frame/apps/app-excalidraw).

/** Excalidraw's element-corner roundness, or `null` for sharp corners. */
export type Roundness = { type: number } | null;

/** Back-reference an element keeps to the arrows/labels bound to it. Excalidraw
 *  uses this to move bound arrows when the container moves. */
export interface BoundElementRef {
  id: string;
  type: "arrow" | "text";
}

/** Fields shared by every element kind we emit. */
export interface ElementBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: "solid" | "hachure" | "cross-hatch";
  strokeWidth: number;
  strokeStyle: "solid" | "dashed" | "dotted";
  roughness: number;
  opacity: number;
  groupIds: string[];
  frameId: string | null;
  roundness: Roundness;
  seed: number;
  versionNonce: number;
  version: number;
  isDeleted: boolean;
  boundElements: BoundElementRef[];
  updated: number;
  link: string | null;
  locked: boolean;
}

export interface RectangleElement extends ElementBase {
  type: "rectangle";
}

export interface TextElement extends ElementBase {
  type: "text";
  fontSize: number;
  fontFamily: number;
  textAlign: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  containerId: string | null;
  originalText: string;
  text: string;
  lineHeight: number;
  baseline: number;
  autoResize: boolean;
}

/** A point in an arrow's local coordinate space (relative to the arrow's x/y). */
export type ArrowPoint = [number, number];

/** Binds an arrow endpoint to a shape so the arrow follows when the shape moves.
 *  `focus` (-1..1) is the relative position along the bound edge; `gap` is the
 *  pixel gap Excalidraw keeps between the arrowhead and the shape. */
export interface Binding {
  elementId: string;
  focus: number;
  gap: number;
}

export interface ArrowElement extends ElementBase {
  type: "arrow";
  points: ArrowPoint[];
  lastCommittedPoint: ArrowPoint | null;
  startBinding: Binding | null;
  endBinding: Binding | null;
  startArrowhead: string | null;
  endArrowhead: string | null;
}

export type ExcalidrawElement = RectangleElement | TextElement | ArrowElement;

/** The on-disk `.excalidraw` envelope. */
export interface ExcalidrawScene {
  type: "excalidraw";
  version: number;
  source: string;
  elements: ExcalidrawElement[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

/** Axis-aligned bounding box used by layout, routing, and the validator. */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
