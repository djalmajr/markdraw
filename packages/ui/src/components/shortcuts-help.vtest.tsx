import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { ShortcutsHelp } from "./shortcuts-help.tsx";

// ShortcutsHelp uses <Portal> like QuickOpen — query through `screen`.
afterEach(cleanup);

describe("ShortcutsHelp", () => {
  it("does not render when open=false", () => {
    render(() => <ShortcutsHelp open={false} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the dialog with all four canonical groups when open", () => {
    render(() => <ShortcutsHelp open onClose={() => {}} platform="mac" />);
    expect(screen.getByRole("dialog")).not.toBeNull();
    // Headings come from the group bar rendered above each list.
    for (const group of ["File", "Tabs", "Navigation", "Help"]) {
      expect(screen.getByText(group)).not.toBeNull();
    }
  });

  it("renders ⌘ on macOS and Ctrl on other platforms — same shortcut id swaps the modifier", () => {
    const macView = render(() => <ShortcutsHelp open onClose={() => {}} platform="mac" />);
    const macKbds = Array.from(macView.baseElement.querySelectorAll<HTMLElement>("kbd"));
    expect(macKbds.some((el) => el.textContent === "⌘")).toBe(true);
    expect(macKbds.some((el) => el.textContent === "Ctrl")).toBe(false);
    cleanup();

    const otherView = render(() => <ShortcutsHelp open onClose={() => {}} platform="other" />);
    const otherKbds = Array.from(otherView.baseElement.querySelectorAll<HTMLElement>("kbd"));
    expect(otherKbds.some((el) => el.textContent === "Ctrl")).toBe(true);
    expect(otherKbds.some((el) => el.textContent === "⌘")).toBe(false);
  });

  it("Escape calls onClose", () => {
    const onClose = vi.fn();
    render(() => <ShortcutsHelp open onClose={onClose} platform="mac" />);
    fireEvent.keyDown(document, { key: "Escape" });
    flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop calls onClose; clicking the panel does not", () => {
    const onClose = vi.fn();
    const { baseElement } = render(() => (
      <ShortcutsHelp open onClose={onClose} platform="mac" />
    ));

    const backdrop = baseElement.querySelector(".shortcuts-help-backdrop") as HTMLElement;
    const panel = baseElement.querySelector(".shortcuts-help-panel") as HTMLElement;

    fireEvent.mouseDown(panel);
    flush();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(backdrop);
    flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("includes the Quick Open and Show shortcuts entries — the catalog wires both", () => {
    render(() => <ShortcutsHelp open onClose={() => {}} platform="other" />);
    expect(screen.getByText(/Quick Open/i)).not.toBeNull();
    expect(screen.getByText(/Show keyboard shortcuts/i)).not.toBeNull();
  });
});
