import { describe, expect, it } from "vitest";
import { render } from "@solidjs/testing-library";
import { Separator } from "./separator.tsx";

describe("Separator", () => {
  it("renders as horizontal hr by default", () => {
    const { container } = render(() => <Separator />);
    const sep = container.querySelector('[data-orientation="horizontal"]');
    expect(sep).not.toBeNull();
    expect(sep!.className).toContain("h-px");
    expect(sep!.className).toContain("w-full");
  });

  it("renders vertical when orientation is vertical", () => {
    const { container } = render(() => <Separator orientation="vertical" />);
    const sep = container.querySelector('[data-orientation="vertical"]');
    expect(sep).not.toBeNull();
    expect(sep!.className).toContain("h-full");
    expect(sep!.className).toContain("w-px");
  });

  it("merges user class with the orientation class", () => {
    const { container } = render(() => <Separator class="my-custom" />);
    const sep = container.querySelector('[data-orientation="horizontal"]');
    expect(sep!.className).toContain("my-custom");
    expect(sep!.className).toContain("h-px");
  });
});
