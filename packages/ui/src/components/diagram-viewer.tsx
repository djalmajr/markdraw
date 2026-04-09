import { createEffect, onCleanup, Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import IconX from "~icons/lucide/x";
import IconZoomIn from "~icons/lucide/zoom-in";
import IconZoomOut from "~icons/lucide/zoom-out";
import IconRotateCcw from "~icons/lucide/rotate-ccw";

interface DiagramViewerProps {
  /** outerHTML of the SVG to display, or null when closed */
  svg: string | null;
  onClose: () => void;
  portalHost?: HTMLElement;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const BUTTON_FACTOR = 1.25;

export function DiagramViewer(props: DiagramViewerProps) {
  const [scale, setScale] = createSignal(1);
  const [tx, setTx] = createSignal(0);
  const [ty, setTy] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);
  // Base SVG dimensions in pixels at scale=1, computed after the SVG is injected.
  // Scaling is applied directly to the SVG's width/height (not via CSS transform)
  // so the browser re-rasterizes the vector at each zoom level — keeps it crisp.
  const [baseW, setBaseW] = createSignal(0);
  const [baseH, setBaseH] = createSignal(0);

  let containerRef: HTMLDivElement | undefined;
  let transformRef: HTMLDivElement | undefined;
  let closeBtnRef: HTMLButtonElement | undefined;

  let dragStart = { x: 0, y: 0, tx: 0, ty: 0 };

  function reset() {
    setScale(1);
    setTx(0);
    setTy(0);
  }

  function getSvgEl(): SVGSVGElement | null {
    return transformRef?.querySelector("svg") ?? null;
  }

  function clamp(s: number) {
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
  }

  /**
   * Zoom by `factor`, anchored at (ax, ay) in container-local pixels.
   * Without an anchor, zooms around the container center.
   *
   * Math: transform-origin sits at the wrapper's center, which (untransformed)
   * coincides with the container's center (cx, cy). With
   * `transform: translate(tx,ty) scale(s)`, a wrapper-local point p maps to
   * container coords (cx + tx + s*p). To keep an anchor (ax, ay) fixed under
   * a scale change s -> s', we solve for tx', ty':
   *   tx' = ax - cx - (s'/s) * (ax - cx - tx)
   */
  function zoomBy(factor: number, ax?: number, ay?: number) {
    if (!containerRef) return;
    const oldScale = scale();
    const newScale = clamp(oldScale * factor);
    if (newScale === oldScale) return;

    const rect = containerRef.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const px = ax ?? cx;
    const py = ay ?? cy;

    const ratio = newScale / oldScale;
    setTx(px - cx - ratio * (px - cx - tx()));
    setTy(py - cy - ratio * (py - cy - ty()));
    setScale(newScale);
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (!containerRef) return;
    const rect = containerRef.getBoundingClientRect();
    // Smooth exponential zoom: feels natural with both wheel and trackpad pinch
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

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomBy(BUTTON_FACTOR);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomBy(1 / BUTTON_FACTOR);
    } else if (e.key === "0") {
      e.preventDefault();
      reset();
    }
  }

  // Reset state and inject SVG when a new diagram is opened
  createEffect(() => {
    const svg = props.svg;
    if (!svg) return;
    reset();
    queueMicrotask(() => {
      if (!transformRef) return;
      transformRef.innerHTML = svg;
      const svgEl = getSvgEl();
      if (svgEl) {
        // Compute intrinsic dimensions from viewBox or width/height attributes,
        // then fit within 80vw/80vh as the base (scale=1).
        const vb = svgEl.viewBox?.baseVal;
        const intrinsicW = vb && vb.width ? vb.width : svgEl.width.baseVal.value || 800;
        const intrinsicH = vb && vb.height ? vb.height : svgEl.height.baseVal.value || 600;
        const fit = Math.min(
          (window.innerWidth * 0.8) / intrinsicW,
          (window.innerHeight * 0.8) / intrinsicH,
          1,
        );
        const bw = intrinsicW * fit;
        const bh = intrinsicH * fit;
        setBaseW(bw);
        setBaseH(bh);
        svgEl.style.width = `${bw}px`;
        svgEl.style.height = `${bh}px`;
        svgEl.style.maxWidth = "none";
        svgEl.style.maxHeight = "none";
      }
      closeBtnRef?.focus();
    });
  });

  // Apply scale by resizing the SVG itself — keeps the rendering crisp at any zoom.
  createEffect(() => {
    const s = scale();
    const bw = baseW();
    const bh = baseH();
    if (!bw || !bh) return;
    const svgEl = getSvgEl();
    if (svgEl) {
      svgEl.style.width = `${bw * s}px`;
      svgEl.style.height = `${bh * s}px`;
    }
  });

  // Lock body scroll while open
  createEffect(() => {
    if (!props.svg) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    onCleanup(() => {
      document.body.style.overflow = prev;
    });
  });

  // Global Esc + keyboard shortcuts
  createEffect(() => {
    if (!props.svg) return;
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      props.onClose();
    }
  }

  const overlay = (
    <Show when={props.svg}>
      <div
        class="diagram-viewer-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Diagram viewer"
        onClick={handleBackdropClick}
      >
        <div class="diagram-viewer-toolbar">
          <button
            class="diagram-viewer-btn"
            aria-label="Zoom out"
            title="Zoom out (-)"
            onClick={() => zoomBy(1 / BUTTON_FACTOR)}
          >
            <IconZoomOut width={16} height={16} />
          </button>
          <span class="diagram-viewer-zoom">{Math.round(scale() * 100)}%</span>
          <button
            class="diagram-viewer-btn"
            aria-label="Zoom in"
            title="Zoom in (+)"
            onClick={() => zoomBy(BUTTON_FACTOR)}
          >
            <IconZoomIn width={16} height={16} />
          </button>
          <button
            class="diagram-viewer-btn"
            aria-label="Reset"
            title="Reset (0)"
            onClick={reset}
          >
            <IconRotateCcw width={16} height={16} />
          </button>
          <button
            class="diagram-viewer-btn"
            aria-label="Close"
            title="Close (Esc)"
            ref={(el) => (closeBtnRef = el)}
            onClick={props.onClose}
          >
            <IconX width={16} height={16} />
          </button>
        </div>
        <div
          class="diagram-viewer-canvas"
          classList={{ "diagram-viewer-grabbing": dragging() }}
          ref={(el) => (containerRef = el)}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div
            class="diagram-viewer-transform"
            ref={(el) => (transformRef = el)}
            style={`transform: translate(${tx()}px, ${ty()}px)`}
          />
        </div>
      </div>
    </Show>
  );

  if (props.portalHost) {
    return <Portal mount={props.portalHost}>{overlay}</Portal>;
  }
  return <Portal>{overlay}</Portal>;
}
