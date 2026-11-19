import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";

import { Toggle } from "./toggle.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

describe("Toggle", () => {
  it("renders as a button with the pressed ARIA state", () => {
    const { getByRole } = render(() => <Toggle>Bold</Toggle>);
    const btn = getByRole("button");
    expect(btn.tagName.toLowerCase()).toBe("button");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  it("invokes onChange with the new pressed state on click", () => {
    const log: boolean[] = [];
    const { getByRole } = render(() => (
      <Toggle onChange={(p: boolean) => log.push(p)}>X</Toggle>
    ));
    const btn = getByRole("button");
    fireEvent.click(btn);
    flush();
    expect(log[0]).toBe(true);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.hasAttribute("data-pressed")).toBe(true);
    fireEvent.click(btn);
    flush();
    expect(log[1]).toBe(false);
  });

  it("is a native button (Enter/Space activation is browser-native)", () => {
    const { getByRole } = render(() => <Toggle>X</Toggle>);
    const btn = getByRole("button");
    expect(btn.tagName.toLowerCase()).toBe("button");
    expect(btn.getAttribute("type")).toBe("button");
  });

  it("respects pressed prop (controlled mode)", () => {
    const { getByRole } = render(() => <Toggle pressed>X</Toggle>);
    const btn = getByRole("button");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.hasAttribute("data-pressed")).toBe(true);
  });

  it("applies size variants", () => {
    const { getByRole } = render(() => <Toggle size="lg">L</Toggle>);
    expect(getByRole("button").className).toContain("h-7");
  });

  it("applies the outline variant", () => {
    const { getByRole } = render(() => <Toggle variant="outline">O</Toggle>);
    expect(getByRole("button").className).toContain("border");
  });

  it("can replace Kobalte's `as={Toggle}` tooltip trigger via render", () => {
    const log: boolean[] = [];
    const { getByRole } = render(() => (
      <Tooltip>
        <TooltipTrigger
          aria-label="Star"
          render={(triggerProps) => (
            <Toggle {...triggerProps} size="sm" onChange={(p) => log.push(p)}>
              X
            </Toggle>
          )}
        />
        <TooltipContent>Hint</TooltipContent>
      </Tooltip>
    ));
    const btn = getByRole("button");
    expect(btn.getAttribute("aria-label")).toBe("Star");
    fireEvent.click(btn);
    flush();
    expect(log).toEqual([true]);
  });

  it("stays disabled when disabled is set", () => {
    const log: boolean[] = [];
    const { getByRole } = render(() => (
      <Toggle disabled onChange={(p: boolean) => log.push(p)}>X</Toggle>
    ));
    const btn = getByRole("button");
    expect(btn.hasAttribute("disabled")).toBe(true);
    fireEvent.click(btn);
    flush();
    expect(log).toEqual([]);
  });
});
