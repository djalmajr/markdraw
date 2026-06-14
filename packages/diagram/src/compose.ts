// Scene composition helpers — pure geometry over already-built elements. Used by
// the host's "append" mode: generate a fresh diagram, then stack it below an
// existing scene's content without overlap. DOM-free and side-effect-free, so it
// is fully unit-testable (the host just feeds it the parsed file elements).

import type { BoundingBox, ExcalidrawElement } from "./types.ts";

interface HasBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Union bounding box of a set of elements, or null when empty. Each element's
 *  box is its (x, y, width, height) — true for rectangles, text, and arrows
 *  (whose width/height already describe their points' extent). */
export function elementsBounds(elements: readonly HasBox[]): BoundingBox | null {
  if (elements.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of elements) {
    minX = Math.min(minX, e.x);
    minY = Math.min(minY, e.y);
    maxX = Math.max(maxX, e.x + e.width);
    maxY = Math.max(maxY, e.y + e.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Shift every element by (dx, dy). Arrow `points` are relative to the arrow's
 *  own x/y, so moving x/y moves the whole arrow — no point rewriting needed.
 *  Bindings reference ids, which are untouched, so they survive the move. */
export function translateElements<T extends { x: number; y: number }>(elements: readonly T[], dx: number, dy: number): T[] {
  if (dx === 0 && dy === 0) return [...elements];
  return elements.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy }));
}

/** Append `incoming` below `existing`, leaving `gap` px between the two content
 *  blocks. Returns the merged element list (existing first, then the shifted
 *  incoming). When `existing` is empty, `incoming` is returned unshifted. */
export function composeBelow(
  existing: readonly ExcalidrawElement[],
  incoming: readonly ExcalidrawElement[],
  gap = 60,
): ExcalidrawElement[] {
  const eb = elementsBounds(existing as readonly HasBox[]);
  if (!eb) return [...incoming];
  const ib = elementsBounds(incoming as readonly HasBox[]);
  if (!ib) return [...existing];
  const dy = eb.y + eb.height + gap - ib.y;
  return [...existing, ...translateElements(incoming, 0, dy)];
}
