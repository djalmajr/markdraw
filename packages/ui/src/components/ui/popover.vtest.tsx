import { createSignal } from "solid-js";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";

afterEach(cleanup);

describe("Popover", () => {
  it("abre e fecha pelo gatilho, com ARIA e contrato público", () => {
    const onOpenChange = vi.fn();
    const [open, setOpen] = createSignal(false);
    const screen = render(() => (
      <Popover
        open={open()}
        onOpenChange={(next) => {
          onOpenChange(next);
          setOpen(next);
        }}
        placement="bottom-end"
        gutter={4}
      >
        <PopoverTrigger as="button" class="trigger-class">
          Detalhes
        </PopoverTrigger>
        <PopoverContent class="custom-popover">Corpo</PopoverContent>
      </Popover>
    ));

    const trigger = screen.getByRole("button", { name: "Detalhes" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.className).toContain("trigger-class");

    fireEvent.click(trigger);
    flush();

    const content = screen.baseElement.querySelector<HTMLElement>(
      '[data-slot="popover-content"]'
    )!;
    expect(content).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(content.id);
    expect(content.getAttribute("data-open")).toBe("");
    expect(content.getAttribute("data-align")).toBe("end");
    expect(content.getAttribute("data-side")).toBe("bottom");
    expect(content.className).toContain("custom-popover");
    expect(content.className).toContain("data-[ending-style]:opacity-0");
    expect(content.getAttribute("popover")).toBe("manual");
    expect(content.style.getPropertyValue("--transform-origin")).not.toBe("");
    expect(onOpenChange).toHaveBeenCalledWith(true);

    fireEvent.click(trigger);
    flush();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("fecha com Escape e preserva o conteúdo quando controlado", () => {
    const onOpenChange = vi.fn();
    const [open, setOpen] = createSignal(true);
    const screen = render(() => (
      <Popover
        open={open()}
        onOpenChange={(next) => {
          onOpenChange(next);
          setOpen(next);
        }}
      >
        <PopoverTrigger>Info</PopoverTrigger>
        <PopoverContent>Sempre aberto</PopoverContent>
      </Popover>
    ));
    const trigger = screen.getByRole("button", { name: "Info" });
    fireEvent.keyDown(document, { key: "Escape" });
    flush();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
