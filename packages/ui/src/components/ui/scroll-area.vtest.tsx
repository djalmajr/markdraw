import { describe, expect, it } from "vitest";
import { render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { ScrollArea, thumbGeometry } from "./scroll-area.tsx";

describe("thumbGeometry", () => {
  it("returns no thumb when the content fits (no overflow)", () => {
    expect(thumbGeometry(100, 100, 0).overflow).toBe(false);
    expect(thumbGeometry(100, 80, 0).overflow).toBe(false);
    // Mutation: a `>=` here would show a phantom thumb at exact fit.
    expect(thumbGeometry(100, 101, 0).overflow).toBe(false); // within the +1 epsilon
  });

  it("sizes the thumb by the visible/total ratio", () => {
    // track 100, content 200 → ratio 0.5 → size 50.
    const t = thumbGeometry(100, 200, 0);
    expect(t.overflow).toBe(true);
    expect(t.size).toBeCloseTo(50);
    expect(t.offset).toBe(0); // at top
  });

  it("maps scroll position linearly onto the thumb travel", () => {
    // track 100, content 200 → size 50, travel 50, maxScroll 100.
    // scrolled 50/100 → offset = 0.5 * 50 = 25.
    expect(thumbGeometry(100, 200, 50).offset).toBeCloseTo(25);
    // fully scrolled → offset = travel (thumb at the very bottom, not past it).
    expect(thumbGeometry(100, 200, 100).offset).toBeCloseTo(50);
  });

  it("floors the thumb at the minimum and clamps offset within the track", () => {
    // Huge content → tiny ratio, but thumb never smaller than minThumb.
    const t = thumbGeometry(100, 100000, 99999, 20);
    expect(t.size).toBe(20);
    expect(t.offset).toBeGreaterThanOrEqual(0);
    expect(t.offset).toBeLessThanOrEqual(100 - 20);
  });

  it("scales the thumb onto an inset/padded bar track, not the full viewport", () => {
    // Same metrics, but the bar is 20px shorter than the viewport (padding +
    // corner). Thumb size scales to the shorter track and travel stays inside it.
    const full = thumbGeometry(100, 200, 200, 20, 100);
    const inset = thumbGeometry(100, 200, 200, 20, 80);
    expect(inset.size).toBeLessThan(full.size);
    // Mutation: ignoring barTrack would let the thumb overshoot the padded bar.
    expect(inset.offset).toBeLessThanOrEqual(80 - inset.size + 0.001);
  });

  it("never divides by zero or returns NaN", () => {
    for (const t of [thumbGeometry(0, 0, 0), thumbGeometry(100, NaN, 10), thumbGeometry(0, 100, 0)]) {
      expect(Number.isNaN(t.size)).toBe(false);
      expect(Number.isNaN(t.offset)).toBe(false);
    }
  });
});

describe("ScrollArea", () => {
  it("renders children inside a viewport with the native scrollbar hidden", () => {
    const { getByText, container } = render(() => (
      <ScrollArea class="h-40">
        <p>scrollable content</p>
      </ScrollArea>
    ));
    expect(getByText("scrollable content")).toBeTruthy();
    // Mutation: dropping the scrollbar-hiding utilities would show the native
    // (per-OS, inconsistent) scrollbar — the whole point of the component.
    const viewport = container.querySelector('[class*="[scrollbar-width:none]"]');
    expect(viewport).toBeTruthy();
  });

  it("renders one bar for a single orientation and two for 'both'", () => {
    const v = render(() => <ScrollArea>x</ScrollArea>);
    // vertical bar uses w-2.5, horizontal uses h-2.5
    expect(v.container.querySelectorAll('[class*="w-2.5"]').length).toBe(1);
    expect(v.container.querySelectorAll('[class*="h-2.5"]').length).toBe(0);

    const both = render(() => <ScrollArea orientation="both">x</ScrollArea>);
    expect(both.container.querySelectorAll('[class*="w-2.5"]').length).toBe(1);
    expect(both.container.querySelectorAll('[class*="h-2.5"]').length).toBe(1);
  });

  it("exposes the scrolling viewport via viewportRef (for auto-scroll hosts)", () => {
    let vp: HTMLDivElement | undefined;
    render(() => (
      <ScrollArea viewportRef={(el) => (vp = el)}>
        <p>content</p>
      </ScrollArea>
    ));
    expect(vp).toBeInstanceOf(HTMLElement);
    // The host can drive native scroll (e.g. scroll-to-bottom) through it.
    expect(typeof vp!.scrollTop).toBe("number");
  });

  it("uses SDK parts and keeps type='always' overflow-only (no phantom bar)", () => {
    const { container } = render(() => (
      <ScrollArea type="always">
        <p>fits</p>
      </ScrollArea>
    ));
    flush();
    const root = container.querySelector('[data-slot="scroll-area"]');
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]');
    const content = container.querySelector('[data-slot="scroll-area-content"]');
    const bar = container.querySelector('[data-slot="scroll-area-scrollbar"]');
    const thumb = container.querySelector('[data-slot="scroll-area-thumb"]');
    expect(root).toBeTruthy();
    expect(viewport).toBeTruthy();
    expect(content).toBeTruthy();
    expect(bar).toBeTruthy();
    expect(thumb).toBeTruthy();
    // Mutation: passing the SDK's "always" straight through keeps the scrollbar
    // displayed with no thumb when nothing overflows. Markdraw's "always" is
    // "auto": the SDK sets `display: none` on an overflowing-axis bar that fits.
    expect((bar as HTMLElement).style.display).toBe("none");
    expect(bar!.hasAttribute("data-visible")).toBe(false);
  });
});
