import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { PaneSplitter } from "./pane-splitter.tsx";

afterEach(cleanup);

function makeContainer(width: number): { el: HTMLElement; ref: () => HTMLElement } {
  const el = document.createElement("div");
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, right: width, bottom: 100, width, height: 100 } as DOMRect),
  });
  return { el, ref: () => el };
}

describe("PaneSplitter", () => {
  it("renders with the role=separator + aria-valuenow reflecting the ratio", () => {
    const { container } = render(() => (
      <PaneSplitter ratio={0.42} onResize={() => {}} />
    ));
    const sep = container.querySelector('[role="separator"]')!;
    expect(sep).not.toBeNull();
    expect(sep.getAttribute("aria-valuenow")).toBe("42");
    expect(sep.getAttribute("aria-orientation")).toBe("vertical");
  });

  it("dragging fires onResize with the fractional clientX/container width", () => {
    const { el, ref } = makeContainer(1000);
    const onResize = vi.fn();
    const { container } = render(() => (
      <PaneSplitter ratio={0.5} container={ref} onResize={onResize} />
    ));
    const handle = container.querySelector(".pane-splitter")!;

    // Mousedown starts the drag.
    fireEvent.mouseDown(handle, { clientX: 500 });
    // The first mousemove must fire onResize even when no clientX
    // change happened (caller drives feedback off this).
    fireEvent.mouseMove(document, { clientX: 700 });
    expect(onResize).toHaveBeenLastCalledWith(0.7);

    fireEvent.mouseMove(document, { clientX: 300 });
    expect(onResize).toHaveBeenLastCalledWith(0.3);

    fireEvent.mouseUp(document);
    // After mouseup, additional moves should NOT fire — the drag ended.
    fireEvent.mouseMove(document, { clientX: 100 });
    expect(onResize).toHaveBeenCalledTimes(2);

    // Keep eslint happy about the unused element variable.
    expect(el).toBe(ref());
  });

  it("clamps ratio to [0.1, 0.9] so neither pane collapses to 0", () => {
    const { ref } = makeContainer(1000);
    const onResize = vi.fn();
    const { container } = render(() => (
      <PaneSplitter ratio={0.5} container={ref} onResize={onResize} />
    ));
    const handle = container.querySelector(".pane-splitter")!;
    fireEvent.mouseDown(handle, { clientX: 500 });
    // Way past the right edge.
    fireEvent.mouseMove(document, { clientX: 9999 });
    expect(onResize).toHaveBeenLastCalledWith(0.9);
    // Past the left edge.
    fireEvent.mouseMove(document, { clientX: -50 });
    expect(onResize).toHaveBeenLastCalledWith(0.1);
    fireEvent.mouseUp(document);
  });

  it("toggles .pane-splitter-dragging during drag", () => {
    const { ref } = makeContainer(1000);
    const { container } = render(() => (
      <PaneSplitter ratio={0.5} container={ref} onResize={() => {}} />
    ));
    const handle = container.querySelector(".pane-splitter")!;
    expect(handle.classList.contains("pane-splitter-dragging")).toBe(false);
    fireEvent.mouseDown(handle, { clientX: 500 });
    flush();
    expect(handle.classList.contains("pane-splitter-dragging")).toBe(true);
    fireEvent.mouseUp(document);
    flush();
    expect(handle.classList.contains("pane-splitter-dragging")).toBe(false);
  });

  it("removes document drag listeners when unmounted mid-drag", () => {
    const { ref } = makeContainer(1000);
    const onResize = vi.fn();
    const { container, unmount } = render(() => (
      <PaneSplitter ratio={0.5} container={ref} onResize={onResize} />
    ));
    const handle = container.querySelector(".pane-splitter")!;
    fireEvent.mouseDown(handle, { clientX: 500 });
    unmount();
    fireEvent.mouseMove(document, { clientX: 700 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it("double-click resets the ratio to 0.5", () => {
    const onResize = vi.fn();
    const { container } = render(() => (
      <PaneSplitter ratio={0.3} onResize={onResize} />
    ));
    const handle = container.querySelector(".pane-splitter")!;
    fireEvent.dblClick(handle);
    expect(onResize).toHaveBeenCalledWith(0.5);
  });

  it("ignores drag when the container has zero width (avoids division by zero)", () => {
    const { ref } = makeContainer(0);
    const onResize = vi.fn();
    const { container } = render(() => (
      <PaneSplitter ratio={0.5} container={ref} onResize={onResize} />
    ));
    const handle = container.querySelector(".pane-splitter")!;
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 200 });
    expect(onResize).not.toHaveBeenCalled();
    fireEvent.mouseUp(document);
  });
});
