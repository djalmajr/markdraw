import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { AiPlan } from "./ai-plan.tsx";

afterEach(cleanup);

const ITEMS = [
  { done: true, text: "Read the brief" },
  { done: false, text: "Draft the outline" },
  { done: false, text: "Review with the user" },
];

describe("AiPlan", () => {
  it("renders one checkbox row per item with its text and done state", () => {
    const { baseElement } = render(() => (
      <AiPlan items={ITEMS} onClear={() => {}} onToggleItem={() => {}} />
    ));
    const rows = baseElement.querySelectorAll(".ai-plan-item");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Read the brief");
    expect(rows[2]!.textContent).toContain("Review with the user");
    const boxes = baseElement.querySelectorAll<HTMLInputElement>(".ai-plan-checkbox");
    expect(boxes[0]!.checked).toBe(true);
    expect(boxes[1]!.checked).toBe(false);
    // The done row carries the strike-through modifier class.
    expect(rows[0]!.classList.contains("ai-plan-item-done")).toBe(true);
    expect(rows[1]!.classList.contains("ai-plan-item-done")).toBe(false);
  });

  it("shows the done/total counter in the header", () => {
    // Mutation: counting total/total (or hardcoding 0) would lie about
    // progress — 1 of the 3 fixture items is done.
    const { baseElement } = render(() => (
      <AiPlan items={ITEMS} onClear={() => {}} onToggleItem={() => {}} />
    ));
    expect(baseElement.querySelector(".ai-plan-counter")!.textContent).toBe("1/3");
  });

  it("clicking an item's checkbox fires onToggleItem with its index", () => {
    const onToggleItem = vi.fn();
    const { baseElement } = render(() => (
      <AiPlan items={ITEMS} onClear={() => {}} onToggleItem={onToggleItem} />
    ));
    const boxes = baseElement.querySelectorAll<HTMLInputElement>(".ai-plan-checkbox");
    fireEvent.click(boxes[1]!);
    expect(onToggleItem).toHaveBeenCalledTimes(1);
    expect(onToggleItem).toHaveBeenCalledWith(1);
  });

  it("the clear (X) button fires onClear", () => {
    const onClear = vi.fn();
    const { baseElement } = render(() => (
      <AiPlan items={ITEMS} onClear={onClear} onToggleItem={() => {}} />
    ));
    fireEvent.click(baseElement.querySelector(".ai-plan-clear")!);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("the header toggle collapses the list but keeps the counter; toggling again restores it", () => {
    const { baseElement } = render(() => (
      <AiPlan items={ITEMS} onClear={() => {}} onToggleItem={() => {}} />
    ));
    const toggle = baseElement.querySelector(".ai-plan-toggle")!;
    fireEvent.click(toggle);
    expect(baseElement.querySelector(".ai-plan-items")).toBeNull();
    expect(baseElement.querySelector(".ai-plan-counter")!.textContent).toBe("1/3");
    fireEvent.click(toggle);
    expect(baseElement.querySelectorAll(".ai-plan-item")).toHaveLength(3);
  });
});
