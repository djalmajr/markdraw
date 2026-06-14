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
  /** When set, a middle "deny" button appears, enabling a three-way choice
   *  (e.g. Save / Don't save / Cancel). Use `confirmThree` to read it. */
  denyLabel?: string;
  variant?: "default" | "destructive";
}

type ConfirmResult = "confirm" | "deny" | "cancel";

let showFn: ((opts: ConfirmOptions) => Promise<ConfirmResult>) | null = null;

/**
 * Imperative confirm dialog. Returns a Promise that resolves to
 * true (confirmed) or false (cancelled/denied/dismissed).
 *
 * Requires `<ConfirmDialog />` to be mounted in the component tree.
 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  if (!showFn) return Promise.resolve(false);
  return showFn(opts).then((r) => r === "confirm");
}

/**
 * Three-way variant — resolves "confirm" | "deny" | "cancel". Pass `denyLabel`
 * to render the middle button (e.g. Save / Don't save / Cancel). Dismissing the
 * dialog (Esc / backdrop) resolves "cancel", the safe no-op.
 */
export function confirmThree(opts: ConfirmOptions & { denyLabel: string }): Promise<ConfirmResult> {
  if (!showFn) return Promise.resolve("cancel");
  return showFn(opts);
}

export function ConfirmDialog() {
  const [open, setOpen] = createSignal(false);
  const [options, setOptions] = createSignal<ConfirmOptions>({
    title: "",
  });
  let resolveFn: ((value: ConfirmResult) => void) | null = null;

  showFn = (opts) => {
    setOptions(opts);
    setOpen(true);
    return new Promise<ConfirmResult>((resolve) => {
      resolveFn = resolve;
    });
  };

  function settle(value: ConfirmResult) {
    setOpen(false);
    resolveFn?.(value);
    resolveFn = null;
  }

  return (
    <AlertDialog open={open()} onOpenChange={(isOpen) => { if (!isOpen) settle("cancel"); }}>
      <AlertDialogContent>
        <AlertDialogTitle>{options().title}</AlertDialogTitle>
        <Show when={options().description}>
          <AlertDialogDescription>{options().description}</AlertDialogDescription>
        </Show>
        <div class="flex justify-end gap-2 mt-2">
          <Button variant="outline" size="sm" onClick={() => settle("cancel")}>
            {options().cancelLabel ?? "Cancel"}
          </Button>
          <Show when={options().denyLabel}>
            <Button variant="outline" size="sm" onClick={() => settle("deny")}>
              {options().denyLabel}
            </Button>
          </Show>
          <Button
            variant={options().variant === "destructive" ? "destructive" : "default"}
            size="sm"
            onClick={() => settle("confirm")}
          >
            {options().confirmLabel ?? "Confirm"}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
