import { createEffect, omit, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

import {
  ScrollArea as ScrollAreaPrimitive,
  ScrollAreaContent,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from "@ui-sdk/solid/scroll-area";

import { cn } from "@markdraw/core/utils.ts";

/**
 * ScrollArea — a cross-platform overlay scrollbar (shadcn/Radix-style).
 *
 * The native scrollbar is hidden on the scrolling viewport; the SDK's custom
 * thumb is sized + positioned from its own scroll metrics and overlaid, so
 * scrollbars look identical on macOS / Windows / Linux (and never reserve
 * layout width). Wheel, touch, and keyboard scrolling stay native.
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

type Thumb = { size: number; offset: number; overflow: boolean };
const NO_THUMB: Thumb = { size: 0, offset: 0, overflow: false };

/**
 * Pure thumb geometry for one axis. Kept exported for the existing contract
 * (the SDK now measures the thumb itself, so the component no longer calls it).
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
  const others = omit(
    props,
    "class",
    "viewportClass",
    "contentClass",
    "type",
    "orientation",
    "scrollHideDelay",
    "viewportRef",
    "children",
    "style",
  );

  const wantsV = () => props.orientation === "vertical" || props.orientation === "both" || !props.orientation;
  const wantsH = () => props.orientation === "horizontal" || props.orientation === "both";

  // The SDK viewport sets an inline `overflow: auto` shorthand, which beats
  // utility classes. Pin the axis policy as important inline longhands so a
  // vertical-only area never gains horizontal scroll (and vice versa).
  const axisPolicy = () => ({
    x: wantsV() && !wantsH() ? "hidden" : "auto",
    y: wantsH() && !wantsV() ? "hidden" : "auto",
  });
  let viewportEl: HTMLDivElement | undefined;
  const applyAxisPolicy = (el: HTMLDivElement) => {
    const { x, y } = axisPolicy();
    el.style.setProperty("overflow-x", x, "important");
    el.style.setProperty("overflow-y", y, "important");
  };
  createEffect(
    axisPolicy,
    (axes) => {
      if (viewportEl) {
        viewportEl.style.setProperty("overflow-x", axes.x, "important");
        viewportEl.style.setProperty("overflow-y", axes.y, "important");
      }
    }
  );

  return (
    <ScrollAreaPrimitive
      // The SDK's "always" shows a bar even without overflow; Markdraw has
      // always meant "keep the bar visible when there is something to scroll".
      // "auto" is the SDK's overflow-only mode.
      type={props.type === "always" ? "auto" : props.type}
      scrollHideDelay={props.scrollHideDelay ?? 600}
      class={cn("relative overflow-hidden border-0", props.class)}
      style={props.style as string | JSX.CSSProperties | undefined}
      {...others}
    >
      <ScrollAreaViewport
        ref={(el: HTMLDivElement) => {
          viewportEl = el;
          props.viewportRef?.(el);
          applyAxisPolicy(el);
        }}
        class={cn(
          "h-full w-full border-0 p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          wantsH() && !wantsV() ? "overflow-x-auto overflow-y-hidden" : "",
          wantsV() && !wantsH() ? "overflow-y-auto overflow-x-hidden" : "",
          props.orientation === "both" ? "overflow-auto" : "",
          props.viewportClass,
        )}
      >
        {/* The SDK's content wrapper; `min-w-full`/`min-h-full` keep it ≥
            viewport so short content still fills, `w-max` lets it grow past the
            viewport for horizontal scrolling. */}
        <ScrollAreaContent
          class={cn("min-h-full min-w-full p-0", wantsH() && "w-max", props.contentClass)}
        >
          {props.children}
        </ScrollAreaContent>
      </ScrollAreaViewport>

      <Show when={wantsV()}>
        <ScrollAreaScrollbar
          orientation="vertical"
          class={cn(
            "visible right-0 top-0 z-10 w-2.5 touch-none select-none p-0.5 opacity-0 pointer-events-none transition-opacity duration-150 data-[visible]:pointer-events-auto data-[visible]:opacity-100",
            props.orientation === "both" ? "bottom-2.5" : "h-full",
          )}
        >
          <ScrollAreaThumb class="relative w-full flex-none rounded-[2px] bg-muted-foreground/30 transition-colors hover:bg-muted-foreground/50 data-[dragging]:bg-muted-foreground/50" />
        </ScrollAreaScrollbar>
      </Show>

      <Show when={wantsH()}>
        <ScrollAreaScrollbar
          orientation="horizontal"
          class={cn(
            "visible bottom-0 left-0 z-10 h-2.5 w-full touch-none select-none p-0.5 opacity-0 pointer-events-none transition-opacity duration-150 data-[visible]:pointer-events-auto data-[visible]:opacity-100",
            props.orientation === "both" ? "right-2.5" : "",
          )}
        >
          <ScrollAreaThumb class="relative h-full rounded-[2px] bg-muted-foreground/30 transition-colors hover:bg-muted-foreground/50 data-[dragging]:bg-muted-foreground/50" />
        </ScrollAreaScrollbar>
      </Show>
    </ScrollAreaPrimitive>
  );
};

export { ScrollArea };
