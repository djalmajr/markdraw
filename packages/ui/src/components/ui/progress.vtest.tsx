import { describe, expect, it } from "vitest";
import { render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";

import { Progress } from "./progress.tsx";

describe("Progress — public API used by update-available-dialog.tsx", () => {
  it("maps minValue/maxValue to the SDK range and renders the track and fill", () => {
    const { getByRole, getByTestId, container } = render(() => (
      <Progress value={50} minValue={0} maxValue={200} data-testid="download" />
    ));
    const bar = getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("200");
    expect(getByTestId("download")).toBe(bar);

    const track = container.querySelector('[data-slot="progress-track"]');
    const fill = container.querySelector('[data-slot="progress-indicator"]');
    expect(track).toBeTruthy();
    expect(fill).toBeTruthy();
    expect(fill!.className).toContain("progress-fill");
    expect((fill as HTMLElement).style.width).toBe("25%");
    // Old Kobalte names must not leak into the DOM.
    expect(bar.hasAttribute("minvalue")).toBe(false);
    expect(bar.hasAttribute("maxvalue")).toBe(false);
  });

  it("renders an indeterminate sweep with no value when indeterminate is set", () => {
    const { getByRole, container } = render(() => (
      <Progress indeterminate maxValue={undefined} data-testid="hop" />
    ));
    const bar = getByRole("progressbar");
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.hasAttribute("data-indeterminate")).toBe(true);
    const fill = container.querySelector('[data-slot="progress-indicator"]') as HTMLElement;
    expect(fill.hasAttribute("data-indeterminate")).toBe(true);
    expect(fill.style.width).toBe("");
  });

  it("keeps children and follows a changing value", () => {
    const [value, setValue] = createSignal(10);
    const { getByRole, getByText } = render(() => (
      <Progress value={value()} aria-label="Downloading">
        <span>bytes</span>
      </Progress>
    ));
    expect(getByText("bytes")).toBeTruthy();
    expect(getByRole("progressbar", { name: "Downloading" }).getAttribute("aria-valuenow")).toBe("10");
    setValue(80);
    flush();
    expect(getByRole("progressbar", { name: "Downloading" }).getAttribute("aria-valuenow")).toBe("80");
  });
});
