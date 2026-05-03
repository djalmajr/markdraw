import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@solidjs/testing-library";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "./switch.tsx";

function renderSwitch(props: Record<string, unknown> = {}) {
  return render(() => (
    <Switch {...props}>
      <SwitchControl>
        <SwitchThumb />
      </SwitchControl>
      <SwitchLabel>Sync</SwitchLabel>
    </Switch>
  ));
}

describe("Switch", () => {
  it("renders the label text", () => {
    const { getByText } = renderSwitch();
    expect(getByText("Sync")).not.toBeNull();
  });

  it("toggles checked state on user click and notifies onChange", () => {
    const log: boolean[] = [];
    const { container } = renderSwitch({
      onChange: (v: boolean) => log.push(v),
    });
    const input = container.querySelector("input")!;
    fireEvent.click(input);
    expect(log[0]).toBe(true);
  });

  it("respects controlled checked prop", () => {
    const { container } = renderSwitch({ checked: true });
    const input = container.querySelector<HTMLInputElement>("input")!;
    expect(input.checked).toBe(true);
  });

  it("disables interaction when disabled prop is set", () => {
    const log: boolean[] = [];
    const { container } = renderSwitch({
      disabled: true,
      onChange: (v: boolean) => log.push(v),
    });
    const input = container.querySelector("input")!;
    fireEvent.click(input);
    expect(log).toEqual([]);
  });
});
