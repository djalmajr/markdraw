import { createSignal } from "solid-js";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu.tsx";

afterEach(cleanup);

describe("DropdownMenu", () => {
  it("abre, navega por teclado, confirma item e fecha", () => {
    const onSelect = vi.fn();
    const [open, setOpen] = createSignal(false);
    const screen = render(() => (
      <DropdownMenu
        open={open()}
        onOpenChange={(next) => setOpen(next)}
      >
        <DropdownMenuTrigger as="button" class="menu-trigger">
          Opções
        </DropdownMenuTrigger>
        <DropdownMenuContent class="custom-menu">
          <DropdownMenuItem onSelect={onSelect}>Primeiro</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem>Segundo</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ));

    const trigger = screen.getByRole("button", { name: "Opções" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    flush();

    const menu = screen.baseElement.querySelector<HTMLElement>(
      '[data-slot="menu-content"]'
    )!;
    expect(menu).toBeTruthy();
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.className).toContain("custom-menu");
    expect(menu.className).toContain("origin-[var(--transform-origin)]");
    expect(menu.className).toContain("data-[ending-style]:opacity-0");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);

    const first = screen.baseElement.querySelector<HTMLElement>(
      '[data-slot="menu-item"]'
    )!;
    expect(first.getAttribute("role")).toBe("menuitem");
    fireEvent.click(first);
    flush();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("mantém o contrato público de radio group e teclado", () => {
    const onChange = vi.fn();
    const [open, setOpen] = createSignal(false);
    const screen = render(() => (
      <DropdownMenu open={open()} onOpenChange={setOpen}>
        <DropdownMenuTrigger>Estilo</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="spaces:2" onChange={onChange}>
            <DropdownMenuRadioItem value="spaces:2">2</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="spaces:4">4</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    ));
    const trigger = screen.getByRole("button", { name: "Estilo" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    flush();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = screen.baseElement.querySelectorAll<HTMLElement>(
      '[data-slot="menu-radio-item"]'
    );
    expect(items.length).toBe(2);
    expect(items[0].getAttribute("role")).toBe("menuitemradio");
    expect(items[0].getAttribute("aria-checked")).toBe("true");
    fireEvent.click(items[1]);
    flush();
    expect(onChange.mock.calls[0][0]).toBe("spaces:4");
  });

  it("atualiza disabled e título do trigger após a montagem", () => {
    const [disabled, setDisabled] = createSignal(true);
    const screen = render(() => (
      <DropdownMenu>
        <DropdownMenuTrigger
          as="button"
          disabled={disabled()}
          title={disabled() ? "Antes" : "Depois"}
        >
          Opções
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Primeiro</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ));
    const trigger = screen.getByRole("button", {
      name: "Opções",
    }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.title).toBe("Antes");

    setDisabled(false);
    flush();
    expect(trigger.disabled).toBe(false);
    expect(trigger.title).toBe("Depois");
  });
});
