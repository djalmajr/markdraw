import {
  type JSX,
  createSignal,
  mergeProps,
  onCleanup,
  onMount,
  Show,
  splitProps,
} from "solid-js";

import { cn } from "@markdraw/core/utils.ts";

/**
 * ScrollArea — a cross-platform overlay scrollbar (shadcn/Radix-style), built
 * from scratch because there's no maintained SolidJS scroll-area primitive
 * (Kobalte/Corvu don't ship one).
 *
 * The native scrollbar is hidden on the scrolling viewport; a custom thumb is
 * sized + positioned from the scroll metrics and overlaid, so scrollbars look
 * identical on macOS / Windows / Linux (and never reserve layout width). Wheel,
 * touch, and keyboard scrolling stay native — only the visual bar is ours.
 *
 * Common use mirrors shadcn: size the root, content goes inside.
 *   <ScrollArea class="h-72"> <div class="p-4">…</div> </ScrollArea>
 */

type Visibility = "hover" | "scroll" | "always" | "auto";
type Orientation = "vertical" | "horizontal" | "both";

export type ScrollAreaProps = Omit<JSX.HTMLAttributes<HTMLDivElement>, "ref"> & {
  class?: string;
  /** Extra classes for the scrolling viewport. */
  viewportClass?: string;
  /** Extra classes for the measured content wrapper — put layout that must
   *  apply to the children's immediate parent here (flex column, gap, padding),
   *  since children are nested one level inside the viewport. */
  contentClass?: string;
  /** When the bars are shown. Default "hover" (visible on hover or while
   *  scrolling, auto-hidden otherwise). "always"/"auto" = visible whenever the
   *  content overflows; "scroll" = only while actively scrolling. */
  type?: Visibility;
  /** Which scrollbars to manage. Default "vertical". */
  orientation?: Orientation;
  /** ms of idle before auto-hide (hover/scroll). Default 600. */
  scrollHideDelay?: number;
  /** Ref to the scrolling viewport element. */
  viewportRef?: (el: HTMLDivElement) => void;
  children?: JSX.Element;
};

const MIN_THUMB = 20;
/** The bar's inner padding (`p-0.5` = 2px each side) — the thumb travels inside
 *  it, so the geometry subtracts it from the track. */
const PAD = 2;
/** The cross-axis bar thickness (`w-2.5`/`h-2.5` = 10px) — subtracted from the
 *  other axis's track in `orientation="both"` so the bars don't overlap. */
const BAR = 10;

type Thumb = { size: number; offset: number; overflow: boolean };
const NO_THUMB: Thumb = { size: 0, offset: 0, overflow: false };

/**
 * Pure thumb geometry for one axis. Exported for unit tests (happy-dom reports
 * 0 for clientHeight/scrollHeight, so the math can't be exercised by rendering).
 *
 * `viewport`/`content` are the real scroll metrics (drive overflow + the
 * visible/total ratio); `barTrack` is the thumb's pixel travel length (the bar
 * minus padding, minus the other bar in `both` mode), separate so the thumb
 * never overshoots the padded/inset track. `size` is the ratio scaled onto the
 * bar (floored at `minThumb`, capped at the track); `offset` is the scroll
 * position mapped linearly onto the travel and clamped inside it.
 */
export function thumbGeometry(
  viewport: number,
  content: number,
  scrollPos: number,
  minThumb = MIN_THUMB,
  barTrack = viewport,
): Thumb {
  if (!(content > viewport + 1)) return NO_THUMB; // no overflow (also handles 0/NaN)
  const track = Math.max(0, barTrack);
  const ratio = viewport / content;
  const size = Math.min(track, Math.max(minThumb, track * ratio));
  const maxScroll = content - viewport;
  const travel = track - size;
  const offset = maxScroll > 0 ? Math.max(0, Math.min(travel, (scrollPos / maxScroll) * travel)) : 0;
  return { size, offset, overflow: true };
}

const ScrollArea = (props: ScrollAreaProps) => {
  const merged = mergeProps(
    { type: "hover" as Visibility, orientation: "vertical" as Orientation, scrollHideDelay: 600 },
    props,
  );
  const [local, others] = splitProps(merged, [
    "class",
    "viewportClass",
    "contentClass",
    "type",
    "orientation",
    "scrollHideDelay",
    "viewportRef",
    "children",
  ]);

  let viewport!: HTMLDivElement;
  let content!: HTMLDivElement;

  const [v, setV] = createSignal<Thumb>(NO_THUMB);
  const [h, setH] = createSignal<Thumb>(NO_THUMB);
  const [hovering, setHovering] = createSignal(false);
  const [scrolling, setScrolling] = createSignal(false);

  const wantsV = () => local.orientation === "vertical" || local.orientation === "both";
  const wantsH = () => local.orientation === "horizontal" || local.orientation === "both";

  // Show the bar when its axis overflows AND the chosen visibility says so.
  const reveal = () => {
    if (local.type === "always" || local.type === "auto") return true;
    if (local.type === "scroll") return scrolling();
    return hovering() || scrolling(); // "hover"
  };

  // In "both" mode each bar is inset by the other's thickness, so its track is
  // shortened to match (keeps the thumb travel honest + frees the corner).
  const barTrack = (client: number) => client - 2 * PAD - (local.orientation === "both" ? BAR : 0);

  function recompute() {
    const el = viewport;
    if (!el) return;
    if (wantsV()) {
      setV(thumbGeometry(el.clientHeight, el.scrollHeight, el.scrollTop, MIN_THUMB, barTrack(el.clientHeight)));
    }
    if (wantsH()) {
      setH(thumbGeometry(el.clientWidth, el.scrollWidth, el.scrollLeft, MIN_THUMB, barTrack(el.clientWidth)));
    }
  }

  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  function flagScrolling() {
    setScrolling(true);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => setScrolling(false), local.scrollHideDelay);
  }

  function onScroll() {
    recompute();
    if (local.type === "hover" || local.type === "scroll") flagScrolling();
  }

  onMount(() => {
    local.viewportRef?.(viewport);
    recompute();
    // Recompute when the viewport OR its content changes size (dynamic lists,
    // images loading, window resize all flow through here).
    const ro = new ResizeObserver(() => recompute());
    ro.observe(viewport);
    ro.observe(content);
    onCleanup(() => ro.disconnect());
  });
  onCleanup(() => clearTimeout(hideTimer));

  // Drag the thumb: translate pointer delta into scrollTop/scrollLeft. Live
  // metrics are re-read each move so the mapping stays correct if the content or
  // viewport resizes mid-drag. Teardown runs on pointerup AND pointercancel
  // (touch interruption, lost capture) so listeners/closures never leak.
  function dragThumb(axis: "v" | "h", e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const el = viewport;
    const startPos = axis === "v" ? e.clientY : e.clientX;
    const startScroll = axis === "v" ? el.scrollTop : el.scrollLeft;
    const target = e.currentTarget as HTMLElement;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }

    const onMove = (ev: PointerEvent) => {
      const thumb = axis === "v" ? v() : h();
      const client = axis === "v" ? el.clientHeight : el.clientWidth;
      const scrollMax = axis === "v" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
      const travel = barTrack(client) - thumb.size;
      const delta = (axis === "v" ? ev.clientY : ev.clientX) - startPos;
      const next = travel > 0 ? startScroll + (delta / travel) * scrollMax : startScroll;
      if (axis === "v") el.scrollTop = next;
      else el.scrollLeft = next;
    };
    const teardown = (ev: PointerEvent) => {
      if (target.hasPointerCapture(ev.pointerId)) target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", teardown);
      target.removeEventListener("pointercancel", teardown);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", teardown);
    target.addEventListener("pointercancel", teardown);
  }

  // Click on the track (not the thumb) pages toward the click. The boundary
  // origin includes the bar's padding so it lines up with the thumb's top/left.
  function pageOnTrack(axis: "v" | "h", e: MouseEvent) {
    const el = viewport;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (axis === "v") {
      const before = e.clientY < rect.top + PAD + v().offset;
      el.scrollTop += (before ? -1 : 1) * el.clientHeight * 0.9;
    } else {
      const before = e.clientX < rect.left + PAD + h().offset;
      el.scrollLeft += (before ? -1 : 1) * el.clientWidth * 0.9;
    }
  }

  const barShown = (t: Thumb) => t.overflow && reveal();

  return (
    <div
      class={cn("relative overflow-hidden", local.class)}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      {...others}
    >
      <div
        ref={viewport}
        class={cn(
          "h-full w-full [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          wantsH() && !wantsV() ? "overflow-x-auto overflow-y-hidden" : "",
          wantsV() && !wantsH() ? "overflow-y-auto overflow-x-hidden" : "",
          local.orientation === "both" ? "overflow-auto" : "",
          local.viewportClass,
        )}
        onScroll={onScroll}
      >
        {/* Measured wrapper (ResizeObserver target). `min-w-full`/`min-h-full`
            keep it ≥ viewport so short content still fills; `w-max` lets it grow
            past the viewport for horizontal scrolling without shrinking content
            in the vertical-only case. */}
        <div
          ref={content}
          class={cn("min-h-full min-w-full", wantsH() && "w-max", local.contentClass)}
        >
          {local.children}
        </div>
      </div>

      {/* Vertical bar — inset from the bottom in "both" mode so it clears the
          horizontal bar's corner. */}
      <Show when={wantsV()}>
        <div
          class={cn(
            "absolute right-0 top-0 z-10 flex w-2.5 touch-none select-none p-0.5 transition-opacity duration-150",
            local.orientation === "both" ? "bottom-2.5" : "h-full",
            barShown(v()) ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) pageOnTrack("v", e);
          }}
        >
          <div
            class="relative flex-1 rounded-full bg-muted-foreground/30 transition-colors hover:bg-muted-foreground/50"
            style={{ height: `${v().size}px`, transform: `translateY(${v().offset}px)` }}
            onPointerDown={(e) => dragThumb("v", e)}
          />
        </div>
      </Show>

      {/* Horizontal bar — inset from the right in "both" mode to clear the
          vertical bar's corner. */}
      <Show when={wantsH()}>
        <div
          class={cn(
            "absolute bottom-0 left-0 z-10 flex h-2.5 touch-none select-none p-0.5 transition-opacity duration-150",
            local.orientation === "both" ? "right-2.5" : "w-full",
            barShown(h()) ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) pageOnTrack("h", e);
          }}
        >
          <div
            class="relative h-full rounded-full bg-muted-foreground/30 transition-colors hover:bg-muted-foreground/50"
            style={{ width: `${h().size}px`, transform: `translateX(${h().offset}px)` }}
            onPointerDown={(e) => dragThumb("h", e)}
          />
        </div>
      </Show>
    </div>
  );
};

export { ScrollArea };
