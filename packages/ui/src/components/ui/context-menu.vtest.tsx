import { createSignal } from "solid-js";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "./context-menu.tsx";

afterEach(cleanup);

describe("ContextMenu", () => {
  it("abre com clique direito, expõe ARIA e executa o item", () => {
    const onSelect = vi.fn();
    const [open, setOpen] = createSignal(false);
    const screen = render(() => (
      <ContextMenu open={open()} onOpenChange={setOpen} gutter={4}>
        <ContextMenuTrigger as="div" class="context-area" tabindex="0">
          Área
        </ContextMenuTrigger>
        <ContextMenuContent class="custom-context">
          <ContextMenuItem onSelect={onSelect}>
            Renomear <ContextMenuShortcut>⌘R</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem>Excluir</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    ));

    const area = screen.getByText("Área");
    expect(area.getAttribute("data-slot")).toBe("menu-context-trigger");
    fireEvent.contextMenu(area, { clientX: 10, clientY: 10 });
    flush();

    const menu = screen.baseElement.querySelector<HTMLElement>(
      '[data-slot="menu-content"]'
    )!;
    expect(menu).toBeTruthy();
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.className).toContain("custom-context");
    expect(menu.className).toContain("data-[ending-style]:opacity-0");
    expect(
      screen.baseElement.querySelector("kbd")?.textContent
    ).toBe("⌘R");

    const items = screen.baseElement.querySelectorAll<HTMLElement>(
      '[data-slot="menu-item"]'
    );
    expect(items.length).toBe(2);
    expect(items[0].getAttribute("role")).toBe("menuitem");
    fireEvent.click(items[0]);
    flush();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(open()).toBe(false);
  });

  it("abre quando o evento contextmenu tem origem de teclado", () => {
    const [open, setOpen] = createSignal(false);
    const screen = render(() => (
      <ContextMenu open={open()} onOpenChange={setOpen}>
        <ContextMenuTrigger as="div" tabindex="0">
          Linha
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Abrir</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    ));
    const area = screen.getByText("Linha");
    // O navegador transforma Shift+F10 em `contextmenu` com button 0.
    fireEvent.contextMenu(area, { button: 0, clientX: 0, clientY: 0 });
    flush();
    expect(open()).toBe(true);
  });

  it("atualiza classe e título do trigger após a montagem", () => {
    const [selected, setSelected] = createSignal(true);
    const screen = render(() => (
      <ContextMenu>
        <ContextMenuTrigger
          as="div"
          class={selected() ? "selecionada" : ""}
          title={selected() ? "Antes" : "Depois"}
          tabindex="0"
        >
          Linha
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Abrir</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    ));
    const area = screen.getByText("Linha");
    expect(area.className).toContain("selecionada");
    expect(area.title).toBe("Antes");

    setSelected(false);
    flush();
    expect(area.className).not.toContain("selecionada");
    expect(area.title).toBe("Depois");
  });
});
