import { createSignal, Show } from "solid-js";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
}

let showFn: ((opts: ConfirmOptions) => Promise<boolean>) | null = null;

/**
 * Imperative confirm dialog. Returns a Promise that resolves to
 * true (confirmed) or false (cancelled).
 *
 * Requires `<ConfirmDialog />` to be mounted in the component tree.
 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  if (!showFn) return Promise.resolve(false);
  return showFn(opts);
}

export function ConfirmDialog() {
  const [open, setOpen] = createSignal(false);
  const [options, setOptions] = createSignal<ConfirmOptions>({
    title: "",
  });
  let resolveFn: ((value: boolean) => void) | null = null;

  showFn = (opts) => {
    setOptions(opts);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolveFn = resolve;
    });
  };

  function handleConfirm() {
    setOpen(false);
    resolveFn?.(true);
    resolveFn = null;
  }

  function handleCancel() {
    setOpen(false);
    resolveFn?.(false);
    resolveFn = null;
  }

  return (
    <AlertDialog open={open()} onOpenChange={(isOpen) => { if (!isOpen) handleCancel(); }}>
      <AlertDialogContent>
        <AlertDialogTitle>{options().title}</AlertDialogTitle>
        <Show when={options().description}>
          <AlertDialogDescription>{options().description}</AlertDialogDescription>
        </Show>
        <div class="flex justify-end gap-2 mt-2">
          <Button variant="outline" size="sm" onClick={handleCancel}>
            {options().cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant={options().variant === "destructive" ? "destructive" : "default"}
            size="sm"
            onClick={handleConfirm}
          >
            {options().confirmLabel ?? "Confirm"}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
