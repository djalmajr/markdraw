import { createSignal, onCleanup } from "solid-js";

export interface PaneSplitterProps {
  /** Current ratio of the left pane width to the container width
   *  (0..1). The component treats this as a controlled value — it
   *  doesn't store ratio internally, only fires `onResize` so the
   *  caller (PaneManager) is the single source of truth. */
  ratio: number;
  /** Reference to the panes container element. The splitter measures
   *  its bounding rect on mousedown to translate clientX into a
   *  fractional ratio. Falls back to the splitter's own parent if
   *  unset. */
  container?: () => HTMLElement | undefined;
  onResize: (ratio: number) => void;
}

const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

/**
 * Vertical handle (4px wide) between two side-by-side panes. Drag with
 * the mouse to adjust the split ratio. Double-click resets to 0.5.
 *
 * The DOM contract:
 *   - `.pane-splitter` is the outer hit-target (8px wide, 4px visible
 *     line in the middle for forgiving clicks).
 *   - During drag, `.pane-splitter-dragging` toggles on so the cursor
 *     and the visible line stay highlighted globally.
 */
export function PaneSplitter(props: PaneSplitterProps) {
  const [dragging, setDragging] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;

  function onMouseDown(event: MouseEvent) {
    event.preventDefault();
    setDragging(true);

    const containerEl = props.container?.() ?? rootRef?.parentElement ?? null;
    if (!containerEl) {
      setDragging(false);
      return;
    }

    function onMove(e: MouseEvent) {
      const rect = containerEl!.getBoundingClientRect();
      if (rect.width <= 0) return;
      const fraction = (e.clientX - rect.left) / rect.width;
      const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, fraction));
      props.onResize(clamped);
    }

    function onUp() {
      setDragging(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);

    onCleanup(() => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    });
  }

  function onDoubleClick(event: MouseEvent) {
    event.preventDefault();
    props.onResize(0.5);
  }

  return (
    <div
      ref={rootRef}
      class={["pane-splitter", { "pane-splitter-dragging": dragging() }]}
      
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round(props.ratio * 100)}
      aria-valuemin={Math.round(MIN_RATIO * 100)}
      aria-valuemax={Math.round(MAX_RATIO * 100)}
      title="Drag to resize · double-click to reset"
      onMouseDown={onMouseDown}
      onDblClick={onDoubleClick}
    >
      <div class="pane-splitter-line" />
    </div>
  );
}
