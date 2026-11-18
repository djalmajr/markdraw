import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";

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
  it("renders the label text and a switch with ARIA state", () => {
    const { getByText, getByRole } = renderSwitch();
    expect(getByText("Sync")).not.toBeNull();
    const sw = getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.hasAttribute("data-unchecked")).toBe(true);
  });

  it("toggles checked state on click and notifies onChange", () => {
    const log: boolean[] = [];
    const { getByRole } = renderSwitch({ onChange: (v: boolean) => log.push(v) });
    const sw = getByRole("switch");
    fireEvent.click(sw);
    flush();
    expect(log).toEqual([true]);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.hasAttribute("data-checked")).toBe(true);
    fireEvent.click(sw);
    flush();
    expect(log).toEqual([true, false]);
  });

  it("is a native button control (Enter/Space activation is browser-native)", () => {
    const { getByRole } = renderSwitch();
    const sw = getByRole("switch");
    expect(sw.tagName.toLowerCase()).toBe("button");
    expect(sw.getAttribute("type")).toBe("button");
  });

  it("respects controlled checked prop", () => {
    const { getByRole } = renderSwitch({ checked: true });
    const sw = getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.hasAttribute("data-checked")).toBe(true);
    expect(sw.querySelector('[data-slot="switch-thumb"]')?.hasAttribute("data-checked")).toBe(true);
  });

  it("disables interaction when disabled prop is set", () => {
    const log: boolean[] = [];
    const { getByRole } = renderSwitch({
      disabled: true,
      onChange: (v: boolean) => log.push(v),
    });
    const sw = getByRole("switch");
    expect(sw.hasAttribute("disabled")).toBe(true);
    fireEvent.click(sw);
    flush();
    expect(log).toEqual([]);
  });
});
