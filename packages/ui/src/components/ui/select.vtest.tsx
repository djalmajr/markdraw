import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@solidjs/testing-library";
import { flush } from "solid-js";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select.tsx";

const labels: Record<string, string> = {
  spaces: "Espaços",
  tabs: "Tabulações",
};

/** The sdk popup uses the top layer; happy-dom has no top layer, and
 *  testing-library hides popovers from role queries. Query the parts directly. */
function popup(trigger: Element) {
  return document.getElementById(trigger.getAttribute("aria-controls") ?? "") as HTMLElement;
}

function options(trigger: Element) {
  return [...(popup(trigger)?.querySelectorAll('[role="option"]') ?? [])];
}

function option(trigger: Element, text: string) {
  const found = options(trigger).find((el) => el.textContent?.includes(text));
  if (!found) throw new Error(`option ${text} not found in ${popup(trigger)?.outerHTML}`);
  return found as HTMLElement;
}

function renderSelect(props: Record<string, unknown> = {}) {
  return render(() => (
    <Select
      options={["spaces", "tabs"]}
      itemComponent={(itemProps) => (
        <SelectItem item={itemProps.item}>
          {labels[itemProps.item.rawValue] ?? itemProps.item.rawValue}
        </SelectItem>
      )}
      {...props}
    >
      <SelectTrigger aria-label="Indent">
        <SelectValue<string>>
          {(state) => labels[state.selectedOption() ?? ""] ?? state.selectedOption()}
        </SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  ));
}

describe("Select", () => {
  it("opens with a combobox trigger and a listbox of translated items", () => {
    const { getByRole } = renderSelect();
    const trigger = getByRole("combobox");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    flush();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const content = popup(trigger);
    expect(content.getAttribute("role")).toBe("listbox");
    expect(option(trigger, "Espaços")).not.toBeNull();
    expect(option(trigger, "Tabulações")).not.toBeNull();
  });

  it("reports the selected raw string through onChange and SelectValue", () => {
    const log: unknown[] = [];
    const { getByRole } = renderSelect({ onChange: (v: unknown) => log.push(v) });
    const trigger = getByRole("combobox");
    fireEvent.click(trigger);
    flush();
    fireEvent.click(option(trigger, "Tabulações"));
    flush();
    expect(log).toEqual(["tabs"]);
    expect(trigger.textContent).toContain("Tabulações");
  });

  it("keeps numeric values numeric, including formatted value labels", () => {
    const log: unknown[] = [];
    const { getByRole } = render(() => (
      <Select<number>
        value={2}
        options={[2, 4]}
        onChange={(v) => log.push(v)}
        itemComponent={(itemProps) => (
          <SelectItem item={itemProps.item}>{itemProps.item.rawValue}px</SelectItem>
        )}
      >
        <SelectTrigger>
          <SelectValue<number>>{(state) => `${state.selectedOption()}px`}</SelectValue>
        </SelectTrigger>
        <SelectContent />
      </Select>
    ));
    const trigger = getByRole("combobox");
    expect(trigger.textContent).toContain("2px");
    fireEvent.click(trigger);
    flush();
    fireEvent.click(option(trigger, "4px"));
    flush();
    expect(log).toEqual([4]);
  });

  it("marks the controlled value as selected with ARIA", () => {
    const { getByRole } = renderSelect({ value: "tabs" });
    const trigger = getByRole("combobox");
    expect(trigger.textContent).toContain("Tabulações");
    fireEvent.click(trigger);
    flush();
    expect(option(trigger, "Tabulações").getAttribute("aria-selected")).toBe("true");
  });

  it("skips disabled items on keyboard navigation", () => {
    const log: unknown[] = [];
    const { getByRole } = render(() => (
      <Select<string>
        options={["on", "off"]}
        onChange={(v) => log.push(v)}
        itemComponent={(itemProps) => (
          <SelectItem item={itemProps.item} disabled={itemProps.item.rawValue === "off"}>
            {itemProps.item.rawValue}
          </SelectItem>
        )}
      >
        <SelectTrigger>
          <SelectValue<string>>{(state) => state.selectedOption()}</SelectValue>
        </SelectTrigger>
        <SelectContent />
      </Select>
    ));
    const trigger = getByRole("combobox");
    fireEvent.click(trigger);
    flush();
    const content = popup(trigger);
    content.focus();
    expect(option(trigger, "off").getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(content, { key: "ArrowDown" });
    flush();
    fireEvent.keyDown(content, { key: "ArrowDown" });
    flush();
    fireEvent.keyDown(content, { key: "Enter" });
    flush();
    expect(log).toEqual(["on"]);
  });

  it("closes on Escape", () => {
    const { getByRole } = renderSelect();
    const trigger = getByRole("combobox");
    fireEvent.click(trigger);
    flush();
    fireEvent.keyDown(popup(trigger), { key: "Escape" });
    flush();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
