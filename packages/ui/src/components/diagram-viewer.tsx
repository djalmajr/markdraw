import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { createPanZoom } from "../composables/create-pan-zoom.ts";
import { ZoomControls } from "./zoom-controls.tsx";

interface DiagramViewerProps {
  /** outerHTML of the SVG to display, or null when closed */
  svg: string | null;
  onClose: () => void;
  portalHost?: HTMLElement;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;

export function DiagramViewer(props: DiagramViewerProps) {
  // Zoom + pan via the shared hook (same interaction as the image viewer).
  const pz = createPanZoom({ minScale: MIN_SCALE, maxScale: MAX_SCALE });

  // Base SVG dimensions in pixels at scale=1, computed after the SVG is injected.
  // Scaling is applied to the SVG's own width/height (not CSS transform) so the
  // browser re-rasterizes the vector at each zoom level — keeps it crisp. Pan is
  // the wrapper's translate.
  const [baseW, setBaseW] = createSignal(0);
  const [baseH, setBaseH] = createSignal(0);

  let transformRef: HTMLDivElement | undefined;
  let canvasRef: HTMLDivElement | undefined;

  function getSvgEl(): SVGSVGElement | null {
    return transformRef?.querySelector("svg") ?? null;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      pz.zoomIn();
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      pz.zoomOut();
    } else if (e.key === "0") {
      e.preventDefault();
      pz.reset();
    }
  }

  // Reset state and inject SVG when a new diagram is opened.
  createEffect(() => {
    const svg = props.svg;
    if (!svg) return;
    pz.reset();
    queueMicrotask(() => {
      if (!transformRef) return;
      transformRef.innerHTML = svg;
      const svgEl = getSvgEl();
      if (svgEl) {
        // Intrinsic dimensions from viewBox or width/height attrs, fit within
        // 80vw/80vh as the base (scale=1).
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
      // Move focus into the modal so Esc/±/0 land and focus isn't left behind.
      canvasRef?.focus();
    });
  });

  // Apply scale by resizing the SVG itself — keeps the rendering crisp at any zoom.
  createEffect(() => {
    const s = pz.scale();
    const bw = baseW();
    const bh = baseH();
    if (!bw || !bh) return;
    const svgEl = getSvgEl();
    if (svgEl) {
      svgEl.style.width = `${bw * s}px`;
      svgEl.style.height = `${bh * s}px`;
    }
  });

  // Lock body scroll while open.
  createEffect(() => {
    if (!props.svg) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    onCleanup(() => {
      document.body.style.overflow = prev;
    });
  });

  // Global Esc + keyboard shortcuts.
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
        <ZoomControls
          class="diagram-viewer-toolbar"
          scale={pz.scale()}
          onZoomIn={pz.zoomIn}
          onZoomOut={pz.zoomOut}
          onReset={pz.reset}
          onClose={props.onClose}
        />
        <div
          class="diagram-viewer-canvas"
          classList={{ "diagram-viewer-grabbing": pz.dragging() }}
          tabindex={-1}
          ref={(el) => {
            canvasRef = el;
            pz.setContainer(el);
          }}
          onWheel={pz.handlers.onWheel}
          onPointerDown={pz.handlers.onPointerDown}
          onPointerMove={pz.handlers.onPointerMove}
          onPointerUp={pz.handlers.onPointerUp}
          onPointerCancel={pz.handlers.onPointerCancel}
        >
          <div
            class="diagram-viewer-transform"
            ref={(el) => (transformRef = el)}
            style={`transform: translate(${pz.tx()}px, ${pz.ty()}px)`}
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
