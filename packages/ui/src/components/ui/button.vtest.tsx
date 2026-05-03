import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@solidjs/testing-library";
import { Button } from "./button.tsx";

describe("Button", () => {
  it("renders children inside a button element by default", () => {
    const { getByRole } = render(() => <Button>Click me</Button>);
    const btn = getByRole("button");
    expect(btn.tagName.toLowerCase()).toBe("button");
    expect(btn.textContent).toBe("Click me");
  });

  it("invokes onClick", () => {
    let clicks = 0;
    const { getByRole } = render(() => (
      <Button onClick={() => (clicks += 1)}>Go</Button>
    ));
    fireEvent.click(getByRole("button"));
    expect(clicks).toBe(1);
  });

  it("disabled buttons do not invoke onClick", () => {
    let clicks = 0;
    const { getByRole } = render(() => (
      <Button disabled onClick={() => (clicks += 1)}>
        Off
      </Button>
    ));
    fireEvent.click(getByRole("button"));
    expect(clicks).toBe(0);
  });

  it("applies size and variant classes", () => {
    const { getByRole } = render(() => (
      <Button size="lg" variant="destructive">
        Delete
      </Button>
    ));
    const btn = getByRole("button");
    expect(btn.className).toContain("bg-destructive");
    expect(btn.className).toContain("h-11");
  });
});
