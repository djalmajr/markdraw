import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";

import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from "./tabs.tsx";

function Example(props: { onChange?: (value: string) => void; value?: string }) {
  return (
    <Tabs value={props.value} onChange={props.onChange}>
      <TabsList aria-label="Editor mode">
        <TabsTrigger value="edit">Edit</TabsTrigger>
        <TabsTrigger value="split">Split</TabsTrigger>
        <TabsTrigger value="preview" disabled>
          Preview
        </TabsTrigger>
        <TabsIndicator />
      </TabsList>
      <TabsContent value="edit">Editor panel</TabsContent>
      <TabsContent value="split">Split panel</TabsContent>
    </Tabs>
  );
}

describe("Tabs — public API used by toolbar.tsx", () => {
  it("renders a labelled tablist, tabs and their data-selected state", () => {
    const { getByRole, getByText } = render(() => <Example />);
    const list = getByRole("tablist");
    expect(list.getAttribute("aria-label")).toBe("Editor mode");

    const edit = getByRole("tab", { name: "Edit" });
    const split = getByRole("tab", { name: "Split" });
    expect(edit.getAttribute("aria-selected")).toBe("true");
    expect(edit.hasAttribute("data-selected")).toBe(true);
    expect(split.getAttribute("aria-selected")).toBe("false");
    expect(split.hasAttribute("data-selected")).toBe(false);
    expect(getByText("Editor panel")).toBeTruthy();
  });

  it("calls the Kobalte-style onChange(value) callback on click and updates ARIA", () => {
    const seen: string[] = [];
    const { getByRole } = render(() => <Example onChange={(v) => seen.push(v)} />);
    fireEvent.click(getByRole("tab", { name: "Split" }));
    flush();
    expect(seen).toEqual(["split"]);
    expect(getByRole("tab", { name: "Split" }).getAttribute("aria-selected")).toBe("true");
    expect(getByRole("tab", { name: "Edit" }).getAttribute("aria-selected")).toBe("false");
  });

  it("moves selection with the arrow keys and ignores a disabled tab", () => {
    const seen: string[] = [];
    const { getByRole } = render(() => <Example onChange={(v) => seen.push(v)} />);
    const edit = getByRole("tab", { name: "Edit" });
    edit.focus();
    fireEvent.keyDown(edit, { key: "ArrowRight" });
    flush();
    expect(seen).toEqual(["split"]);
    expect(document.activeElement).toBe(getByRole("tab", { name: "Split" }));

    fireEvent.click(getByRole("tab", { name: "Preview" }));
    flush();
    expect(seen).toEqual(["split"]);
    expect(getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("false");
  });

  it("keeps Kobalte's activationMode='manual': arrows move focus without selecting", () => {
    const seen: string[] = [];
    const { getByRole } = render(() => (
      <Tabs activationMode="manual" onChange={(v) => seen.push(v)}>
        <TabsList aria-label="Editor mode">
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
      </Tabs>
    ));
    const a = getByRole("tab", { name: "A" });
    a.focus();
    fireEvent.keyDown(a, { key: "ArrowRight" });
    flush();
    expect(document.activeElement).toBe(getByRole("tab", { name: "B" }));
    expect(a.getAttribute("aria-selected")).toBe("true");
    expect(seen).toEqual([]);
  });

  it("keeps a disabled root inert: no callback and disabled triggers", () => {
    const seen: string[] = [];
    const { getByRole } = render(() => (
      <Tabs disabled onChange={(v) => seen.push(v)}>
        <TabsList aria-label="Editor mode">
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
      </Tabs>
    ));
    const b = getByRole("tab", { name: "B" });
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(b.hasAttribute("data-disabled")).toBe(true);
    fireEvent.click(b);
    flush();
    expect(seen).toEqual([]);
    expect(b.getAttribute("aria-selected")).toBe("false");
  });

  it("keeps Kobalte's forceMount: inactive panels stay mounted", () => {
    const { getByText, container } = render(() => (
      <Tabs defaultValue="a">
        <TabsList aria-label="Editor mode">
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">panel A</TabsContent>
        <TabsContent value="b" forceMount>
          panel B
        </TabsContent>
      </Tabs>
    ));
    flush();
    expect(getByText("panel B")).toBeTruthy();
    const panels = container.querySelectorAll('[data-slot="tabs-panel"]');
    expect(panels.length).toBe(2);
    expect(getByText("panel B").hasAttribute("data-selected")).toBe(false);
  });

  it("honours a controlled value and exposes the SDK indicator/panel parts", () => {
    const [value, setValue] = createSignal("edit");
    const { getByRole, container } = render(() => (
      <Example value={value()} onChange={setValue} />
    ));
    fireEvent.click(getByRole("tab", { name: "Split" }));
    flush();
    expect(value()).toBe("split");
    expect(getByRole("tab", { name: "Split" }).getAttribute("aria-selected")).toBe("true");

    const indicator = container.querySelector('[data-slot="tabs-indicator"]');
    expect(indicator).toBeTruthy();
    // Like Kobalte, the SDK mounts only the selected panel by default.
    const panels = container.querySelectorAll('[data-slot="tabs-panel"]');
    expect(panels.length).toBe(1);
    expect(panels[0].textContent).toBe("Split panel");
  });
});
