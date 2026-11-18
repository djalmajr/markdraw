import { createSignal } from "solid-js";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog.tsx";

afterEach(cleanup);

describe("AlertDialog", () => {
  it("mantém o contrato controlado, ARIA, backdrop e animação de saída", () => {
    const onOpenChange = vi.fn();
    const [open, setOpen] = createSignal(true);
    const screen = render(() => (
      <AlertDialog
        open={open()}
        onOpenChange={(next) => {
          onOpenChange(next);
          setOpen(next);
        }}
      >
        <AlertDialogTrigger>Abrir</AlertDialogTrigger>
        <AlertDialogContent class="custom-alert">
          <AlertDialogTitle>Confirmar?</AlertDialogTitle>
          <AlertDialogDescription>Esta ação não pode ser desfeita.</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>
    ));

    const dialog = screen.baseElement.querySelector<HTMLElement>(
      '[data-slot="alert-dialog-content"]'
    )!;
    const backdrop = screen.baseElement.querySelector<HTMLElement>(
      '[data-slot="alert-dialog-backdrop"]'
    )!;
    expect(dialog).toBeTruthy();
    expect(backdrop).toBeTruthy();
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(dialog.className).toContain("custom-alert");
    expect(dialog.className).toContain("data-[ending-style]:opacity-0");
    expect(backdrop.className).toContain("data-[ending-style]:opacity-0");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    flush();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(open()).toBe(false);
  });

  it("abre pelo trigger e mantém título e descrição como public API", () => {
    const [open, setOpen] = createSignal(false);
    const screen = render(() => (
      <AlertDialog open={open()} onOpenChange={setOpen}>
        <AlertDialogTrigger class="open-alert">Excluir</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle class="alert-title">Excluir arquivo?</AlertDialogTitle>
          <AlertDialogDescription class="alert-desc">Sem volta.</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>
    ));
    const trigger = screen.getByRole("button", { name: "Excluir" });
    expect(trigger.className).toContain("open-alert");
    fireEvent.click(trigger);
    flush();
    expect(open()).toBe(true);
    expect(
      screen.baseElement.querySelector(".alert-title")?.textContent
    ).toBe("Excluir arquivo?");
    expect(
      screen.baseElement.querySelector(".alert-desc")?.textContent
    ).toBe("Sem volta.");
  });
});
