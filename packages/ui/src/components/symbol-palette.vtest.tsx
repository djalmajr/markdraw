import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { Heading } from "@markdraw/core/headings.ts";
import { SymbolPalette } from "./symbol-palette.tsx";

afterEach(cleanup);

const HEADINGS: Heading[] = [
  { level: 1, text: "Introduction", line: 0 },
  { level: 2, text: "Overview", line: 4 },
  { level: 2, text: "Examples", line: 12 },
  { level: 3, text: "Edge cases", line: 20 },
];

describe("SymbolPalette", () => {
  it("renders one option per heading when opened", () => {
    render(() => (
      <SymbolPalette open headings={HEADINGS} onSelect={() => {}} onClose={() => {}} />
    ));
    expect(screen.getAllByRole("option").length).toBe(HEADINGS.length);
  });

  it("renders the empty-items state when the document has no headings", () => {
    render(() => (
      <SymbolPalette open headings={[]} onSelect={() => {}} onClose={() => {}} />
    ));
    expect(screen.getByText(/No headings in this document/i)).not.toBeNull();
  });

  it("typing narrows by case-insensitive substring on heading text", () => {
    render(() => (
      <SymbolPalette open headings={HEADINGS} onSelect={() => {}} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Type a heading/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "EDGE" } });
    const options = screen.getAllByRole("option");
    expect(options.length).toBe(1);
    expect(options[0]?.textContent).toContain("Edge cases");
  });

  it("Enter dispatches onSelect with the active Heading object", () => {
    const onSelect = vi.fn();
    render(() => (
      <SymbolPalette open headings={HEADINGS} onSelect={onSelect} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Type a heading/i) as HTMLInputElement;
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toEqual(HEADINGS[1]);
  });

  it("Escape calls onClose without selecting", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(() => (
      <SymbolPalette open headings={HEADINGS} onSelect={onSelect} onClose={onClose} />
    ));
    const input = screen.getByPlaceholderText(/Type a heading/i) as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("each row indents by level (visual hierarchy)", () => {
    // Level 1 → 0px, level 2 → 16px, level 3 → 32px. The palette uses
    // inline `padding-left` on the name span — read it back.
    const { baseElement } = render(() => (
      <SymbolPalette open headings={HEADINGS} onSelect={() => {}} onClose={() => {}} />
    ));
    const nameSpans = Array.from(
      baseElement.querySelectorAll<HTMLElement>(".quick-open-row-name"),
    );
    expect(nameSpans[0]?.style.paddingLeft).toBe("0px");
    expect(nameSpans[1]?.style.paddingLeft).toBe("16px");
    expect(nameSpans[3]?.style.paddingLeft).toBe("32px");
  });

  it("displays the line number meta (1-indexed for the human reader)", () => {
    render(() => (
      <SymbolPalette open headings={HEADINGS} onSelect={() => {}} onClose={() => {}} />
    ));
    const introRow = screen.getAllByRole("option").find((el) =>
      el.textContent?.includes("Introduction"),
    );
    expect(introRow?.textContent).toContain("line 1");

    const overviewRow = screen.getAllByRole("option").find((el) =>
      el.textContent?.includes("Overview"),
    );
    expect(overviewRow?.textContent).toContain("line 5");
  });
});
