import { Show } from "solid-js";
import IconZoomIn from "~icons/lucide/zoom-in";
import IconZoomOut from "~icons/lucide/zoom-out";
import IconRotateCcw from "~icons/lucide/rotate-ccw";
import IconScan from "~icons/lucide/scan";
import IconX from "~icons/lucide/x";

// Shared, presentational zoom control row used by every zoom+pan surface (the
// image pane, the diagram/mermaid lightbox, …) so they all read the same:
// [zoom out] [percentage] [zoom in] + optional trailing buttons (fit / reset /
// close) the surface opts into. The interaction itself comes from createPanZoom;
// this is just the chrome.

export interface ZoomControlsProps {
  /** Current scale multiplier (1 = 100%) — drives the default percentage label. */
  scale: number;
  /** Override the label (e.g. "Fit" while an image is in fit-to-window mode). */
  label?: string;
  onZoomIn: () => void;
  onZoomOut: () => void;
  zoomInDisabled?: boolean;
  zoomOutDisabled?: boolean;
  /** Fit-to-window/width (scan icon) — image/PDF surfaces. */
  onFit?: () => void;
  /** Reset to the default view (rotate-ccw icon) — the lightbox. */
  onReset?: () => void;
  /** Close (x icon) — modal lightboxes only. */
  onClose?: () => void;
  zoomInLabel?: string;
  zoomOutLabel?: string;
  fitLabel?: string;
  resetLabel?: string;
  closeLabel?: string;
  /** Extra class on the row (positioning differs per surface). */
  class?: string;
}

export function ZoomControls(props: ZoomControlsProps) {
  return (
    <div class={`zoom-controls${props.class ? ` ${props.class}` : ""}`}>
      <button
        class="zoom-controls-btn"
        aria-label={props.zoomOutLabel ?? "Zoom out"}
        title={`${props.zoomOutLabel ?? "Zoom out"} (−)`}
        disabled={props.zoomOutDisabled}
        onClick={props.onZoomOut}
      >
        <IconZoomOut width={14} height={14} />
      </button>
      <span class="zoom-controls-label">{props.label ?? `${Math.round(props.scale * 100)}%`}</span>
      <button
        class="zoom-controls-btn"
        aria-label={props.zoomInLabel ?? "Zoom in"}
        title={`${props.zoomInLabel ?? "Zoom in"} (+)`}
        disabled={props.zoomInDisabled}
        onClick={props.onZoomIn}
      >
        <IconZoomIn width={14} height={14} />
      </button>
      <Show when={props.onFit}>
        <button
          class="zoom-controls-btn"
          aria-label={props.fitLabel ?? "Fit"}
          title={props.fitLabel ?? "Fit"}
          onClick={() => props.onFit?.()}
        >
          <IconScan width={14} height={14} />
        </button>
      </Show>
      <Show when={props.onReset}>
        <button
          class="zoom-controls-btn"
          aria-label={props.resetLabel ?? "Reset"}
          title={`${props.resetLabel ?? "Reset"} (0)`}
          onClick={() => props.onReset?.()}
        >
          <IconRotateCcw width={14} height={14} />
        </button>
      </Show>
      <Show when={props.onClose}>
        <button
          class="zoom-controls-btn"
          aria-label={props.closeLabel ?? "Close"}
          title={`${props.closeLabel ?? "Close"} (Esc)`}
          onClick={() => props.onClose?.()}
        >
          <IconX width={14} height={14} />
        </button>
      </Show>
    </div>
  );
}
