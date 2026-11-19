import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { SearchOverlay } from "./search-overlay.tsx";

afterEach(cleanup);

function host(): HTMLDivElement {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return element;
}

describe("SearchOverlay", () => {
  it("ports into a host that changes after mount, and back inline when removed", () => {
    const first = host();
    const second = host();
    const [portalHost, setPortalHost] = createSignal<HTMLElement | undefined>(first);
    try {
      const view = render(() => (
        <SearchOverlay visible portalHost={portalHost()} onClose={() => {}} />
      ));
      expect(first.querySelector(".search-overlay")).not.toBeNull();
      expect(view.container.querySelector(".search-overlay")).toBeNull();

      setPortalHost(second);
      flush();
      expect(first.querySelector(".search-overlay")).toBeNull();
      expect(second.querySelector(".search-overlay")).not.toBeNull();

      setPortalHost(undefined);
      flush();
      expect(second.querySelector(".search-overlay")).toBeNull();
      expect(view.container.querySelector(".search-overlay")).not.toBeNull();
    } finally {
      first.remove();
      second.remove();
    }
  });

  it("reflects visible changes after mount", () => {
    const [visible, setVisible] = createSignal(false);
    const onSearchChange = vi.fn();
    const view = render(() => (
      <SearchOverlay
        visible={visible()}
        onSearchChange={onSearchChange}
        onClose={() => {}}
      />
    ));
    const overlay = view.container.querySelector(".search-overlay")!;
    expect(overlay.classList.contains("search-overlay-hidden")).toBe(true);

    setVisible(true);
    flush();
    expect(overlay.classList.contains("search-overlay-hidden")).toBe(false);
    expect(onSearchChange).toHaveBeenCalledWith("", {
      ignoreCase: true,
      ignoreDiacritics: true,
    });

    setVisible(false);
    flush();
    expect(overlay.classList.contains("search-overlay-hidden")).toBe(true);
  });

  it("preserves focus, query and selection when moving between hosts and inline", async () => {
    const first = host();
    const second = host();
    const [portalHost, setPortalHost] = createSignal<HTMLElement | undefined>(first);
    const view = render(() => (
      <SearchOverlay visible portalHost={portalHost()} onClose={() => {}} />
    ));
    try {
      await Promise.resolve();
      const initialInput = first.querySelector("input")!;
      expect(document.activeElement).toBe(initialInput);
      fireEvent.input(initialInput, { target: { value: "needle" } });
      flush();
      initialInput.setSelectionRange(2, 5);

      for (const [next, label] of [
        [second, "first-to-second"],
        [undefined, "host-to-inline"],
        [first, "inline-to-host"],
      ] as const) {
        setPortalHost(next);
        flush();
        await Promise.resolve();
        const parent = next ?? view.container;
        const movedInput = parent.querySelector("input") as HTMLInputElement;
        expect(document.querySelectorAll(".search-overlay"), label).toHaveLength(1);
        expect(document.activeElement, label).toBe(movedInput);
        expect(movedInput.value, label).toBe("needle");
        expect(movedInput.selectionStart, label).toBe(2);
        expect(movedInput.selectionEnd, label).toBe(5);
      }
    } finally {
      view.unmount();
      first.remove();
      second.remove();
    }
  });

  it("does not steal focus when the input was not focused before a host change", async () => {
    const first = host();
    const second = host();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const [portalHost, setPortalHost] = createSignal<HTMLElement | undefined>(first);
    const view = render(() => (
      <SearchOverlay visible portalHost={portalHost()} onClose={() => {}} />
    ));
    try {
      await Promise.resolve();
      outside.focus();
      expect(document.activeElement).toBe(outside);

      for (const next of [second, undefined, first]) {
        setPortalHost(next);
        flush();
        await Promise.resolve();
        expect(document.querySelectorAll(".search-overlay")).toHaveLength(1);
        expect(document.activeElement).toBe(outside);
      }
    } finally {
      view.unmount();
      outside.remove();
      first.remove();
      second.remove();
    }
  });

  it("does not emit STRICT_READ_UNTRACKED for portalHost or visible", () => {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });
    const first = host();
    const second = host();
    try {
      const [portalHost, setPortalHost] = createSignal<HTMLElement | undefined>(first);
      const [visible, setVisible] = createSignal(false);
      const view = render(() => (
        <SearchOverlay
          visible={visible()}
          portalHost={portalHost()}
          onClose={() => {}}
        />
      ));
      setVisible(true);
      flush();
      setPortalHost(second);
      flush();
      setVisible(false);
      flush();
      view.unmount();
    } finally {
      warn.mockRestore();
      first.remove();
      second.remove();
    }
    expect(warnings.filter((line) => line.includes("[STRICT_READ_UNTRACKED]"))).toEqual([]);
  });
});
