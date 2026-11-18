import { createSignal } from "solid-js";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

afterEach(cleanup);

describe("Tooltip", () => {
  it("expõe o contrato controlado, ARIA e classes de entrada/saída", () => {
    const onOpenChange = vi.fn();
    const [open, setOpen] = createSignal(true);
    const screen = render(() => (
      <Tooltip
        open={open()}
        onOpenChange={(next) => {
          onOpenChange(next);
          setOpen(next);
        }}
      >
        <TooltipTrigger as="button" class="tip-trigger">
          Ajuda
        </TooltipTrigger>
        <TooltipContent class="custom-tip" side="top" sideOffset={7}>
          Dica importante
        </TooltipContent>
      </Tooltip>
    ));

    const trigger = screen.getByRole("button", { name: "Ajuda" });
    const content = screen.baseElement.querySelector<HTMLElement>(
      '[data-slot="tooltip-content"]'
    )!;
    expect(trigger.className).toContain("tip-trigger");
    expect(content).toBeTruthy();
    expect(content.getAttribute("role")).toBe("tooltip");
    expect(content.textContent).toBe("Dica importante");
    expect(content.className).toContain("custom-tip");
    expect(content.className).toContain("origin-[var(--transform-origin)]");
    expect(content.className).toContain("data-[starting-style]:opacity-0");
    expect(content.className).toContain("data-[ending-style]:opacity-0");
    expect(content.className).toContain("data-[instant]:transition-none");
    expect(content.style.getPropertyValue("--transform-origin")).not.toBe("");
    expect(trigger.getAttribute("aria-describedby") ?? trigger.getAttribute("aria-labelledby")).toBe(content.id);

    fireEvent.keyDown(document, { key: "Escape" });
    flush();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(open()).toBe(false);
  });

  it("abre no foco do teclado respeitando openDelay", () => {
    const screen = render(() => (
      <Tooltip openDelay={0}>
        <TooltipTrigger as="button">Info</TooltipTrigger>
        <TooltipContent>Dica rápida</TooltipContent>
      </Tooltip>
    ));
    const trigger = screen.getByRole("button", { name: "Info" });
    fireEvent.focus(trigger);
    flush();
    expect(
      screen.baseElement.querySelector('[data-slot="tooltip-content"]')
    ).toBeTruthy();
  });

  it("atualiza as props do trigger quando o sinal muda após a montagem", () => {
    const [disabled, setDisabled] = createSignal(true);
    const screen = render(() => (
      <Tooltip open>
        <TooltipTrigger
          as="button"
          disabled={disabled()}
          title={disabled() ? "Antes" : "Depois"}
        >
          Ajuda
        </TooltipTrigger>
        <TooltipContent>Dica</TooltipContent>
      </Tooltip>
    ));
    const trigger = screen.getByRole("button", {
      name: "Ajuda",
    }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.title).toBe("Antes");

    setDisabled(false);
    flush();
    expect(trigger.disabled).toBe(false);
    expect(trigger.title).toBe("Depois");
  });
});
