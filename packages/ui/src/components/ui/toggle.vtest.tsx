import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@solidjs/testing-library";
import { Toggle } from "./toggle.tsx";

describe("Toggle", () => {
  it("renders as a button", () => {
    const { getByRole } = render(() => <Toggle>Bold</Toggle>);
    const btn = getByRole("button");
    expect(btn.tagName.toLowerCase()).toBe("button");
  });

  it("invokes onChange with the new pressed state on click", () => {
    const log: boolean[] = [];
    const { getByRole } = render(() => (
      <Toggle onChange={(p: boolean) => log.push(p)}>X</Toggle>
    ));
    fireEvent.click(getByRole("button"));
    expect(log[0]).toBe(true);
    fireEvent.click(getByRole("button"));
    expect(log[1]).toBe(false);
  });

  it("respects pressed prop (controlled mode)", () => {
    const { getByRole } = render(() => <Toggle pressed>X</Toggle>);
    expect(getByRole("button").getAttribute("data-pressed")).not.toBeNull();
  });

  it("applies size variants", () => {
    const { getByRole } = render(() => <Toggle size="lg">L</Toggle>);
    expect(getByRole("button").className).toContain("h-10");
  });

  it("applies the outline variant", () => {
    const { getByRole } = render(() => <Toggle variant="outline">O</Toggle>);
    expect(getByRole("button").className).toContain("border");
  });
});
