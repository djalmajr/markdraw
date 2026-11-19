import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
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
