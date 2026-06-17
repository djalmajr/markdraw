import { createSignal, type Accessor } from "solid-js";

// Shared zoom + pan interaction core, extracted from DiagramViewer so the image
// viewer (and any future viewer) get the SAME behaviour: cursor-anchored
// wheel/pinch zoom, drag-to-pan via pointer capture, and a multiplicative
// button step. The hook owns the math + the `{scale, tx, ty}` state but is
// deliberately APPLY-AGNOSTIC: the consumer decides how the values reach the DOM
// (DiagramViewer resizes the SVG for vector crispness; the image viewer applies
// `transform: translate(tx,ty) scale(scale)`). That keeps one source of truth
// for the interaction while each surface renders the way it needs to.

export interface PanZoomOptions {
  /** Smallest allowed scale multiplier (1 = 100%). Default 0.2. */
  minScale?: number;
  /** Largest allowed scale multiplier. Default 8. */
  maxScale?: number;
  /** Multiplicative step for the zoom buttons / keyboard. Default 1.25. */
  buttonFactor?: number;
}

export interface PanZoom {
  scale: Accessor<number>;
  tx: Accessor<number>;
  ty: Accessor<number>;
  dragging: Accessor<boolean>;
  /** Ref callback for the pannable container — needed for cursor-anchored zoom. */
  setContainer: (el: HTMLElement | undefined) => void;
  /** Zoom by `factor`, anchored at (ax, ay) in container-local px (center if omitted). */
  zoomBy: (factor: number, ax?: number, ay?: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  /** Spread onto the container element to wire wheel + drag-pan. */
  handlers: {
    onWheel: (e: WheelEvent) => void;
    onPointerDown: (e: PointerEvent) => void;
    onPointerMove: (e: PointerEvent) => void;
    onPointerUp: (e: PointerEvent) => void;
    onPointerCancel: (e: PointerEvent) => void;
  };
  readonly minScale: number;
  readonly maxScale: number;
}

export function createPanZoom(opts: PanZoomOptions = {}): PanZoom {
  const minScale = opts.minScale ?? 0.2;
  const maxScale = opts.maxScale ?? 8;
  const buttonFactor = opts.buttonFactor ?? 1.25;

  const [scale, setScale] = createSignal(1);
  const [tx, setTx] = createSignal(0);
  const [ty, setTy] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);

  let container: HTMLElement | undefined;
  let dragStart = { x: 0, y: 0, tx: 0, ty: 0 };

  const clamp = (s: number) => Math.max(minScale, Math.min(maxScale, s));

  function reset() {
    setScale(1);
    setTx(0);
    setTy(0);
  }

  // Keep the anchor (ax, ay) fixed under the scale change. The scaled element is
  // assumed centered in the container, so its center (untransformed) is the
  // container center (cx, cy); with `translate(t) scale(s)` a point p maps to
  // cx + t + s*p, and solving to fix the anchor gives:
  //   t' = a - c - (s'/s) * (a - c - t)
  function zoomBy(factor: number, ax?: number, ay?: number) {
    if (!container) return;
    const oldScale = scale();
    const newScale = clamp(oldScale * factor);
    if (newScale === oldScale) return;
    const rect = container.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const px = ax ?? cx;
    const py = ay ?? cy;
    const ratio = newScale / oldScale;
    setTx(px - cx - ratio * (px - cx - tx()));
    setTy(py - cy - ratio * (py - cy - ty()));
    setScale(newScale);
  }

  const zoomIn = () => zoomBy(buttonFactor);
  const zoomOut = () => zoomBy(1 / buttonFactor);

  function onWheel(e: WheelEvent) {
    if (!container) return;
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    // Smooth exponential zoom — feels natural for both wheel and trackpad pinch.
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomBy(factor, e.clientX - rect.left, e.clientY - rect.top);
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    setDragging(true);
    dragStart = { x: e.clientX, y: e.clientY, tx: tx(), ty: ty() };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging()) return;
    setTx(dragStart.tx + (e.clientX - dragStart.x));
    setTy(dragStart.ty + (e.clientY - dragStart.y));
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging()) return;
    setDragging(false);
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }

  return {
    scale,
    tx,
    ty,
    dragging,
    setContainer: (el) => (container = el),
    zoomBy,
    zoomIn,
    zoomOut,
    reset,
    handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
    minScale,
    maxScale,
  };
}
