import { createEffect, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { createPanZoom } from "../composables/create-pan-zoom.ts";
import { ZoomControls } from "./zoom-controls.tsx";

// Full-screen modal lightbox for a raster image, with the SAME zoom + pan as the
// diagram/mermaid viewer (shared createPanZoom + ZoomControls). Opened by passing
// an image `src`; closes via Esc / the close button. Reuses the diagram-viewer
// overlay/canvas chrome so the two read identically — the only difference is the
// apply mechanism: a raster image scales via `transform` (vs the SVG's resize).

interface ImageLightboxProps {
  /** Image URL to display, or null when closed. */
  src: string | null;
  onClose: () => void;
  portalHost?: HTMLElement;
}

export function ImageLightbox(props: ImageLightboxProps) {
  const pz = createPanZoom({ minScale: 0.2, maxScale: 8 });
  let canvasRef: HTMLDivElement | undefined;

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

  // Reset zoom/pan and move focus into the modal when a new image opens.
  createEffect(() => {
    if (!props.src) return;
    pz.reset();
    queueMicrotask(() => canvasRef?.focus());
  });

  // Lock body scroll + global keyboard shortcuts while open.
  createEffect(() => {
    if (!props.src) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKeyDown);
    });
  });

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) props.onClose();
  }

  const overlay = (
    <Show when={props.src}>
      <div
        class="diagram-viewer-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Image viewer"
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
          <img
            class="image-lightbox-img"
            src={props.src!}
            alt=""
            draggable={false}
            style={`transform: translate(${pz.tx()}px, ${pz.ty()}px) scale(${pz.scale()})`}
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
