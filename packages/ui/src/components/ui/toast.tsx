import type { ComponentProps } from "@solidjs/web";
import { omit } from "solid-js";

import {
  Toast as ToastPrimitive,
  ToastClose as ToastClosePrimitive,
  ToastDescription as ToastDescriptionPrimitive,
  ToastRegion,
  ToastTitle as ToastTitlePrimitive,
  toast,
} from "@ui-sdk/solid/toast";
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

import { cn } from "@markdraw/core/utils.ts";

const toastVariants = cva(
  "group pointer-events-auto relative flex w-full select-none items-center justify-between overflow-hidden rounded-md border bg-popover px-3 py-2 pr-7 text-xs text-popover-foreground shadow-none transition-all data-[swiping]:translate-x-[var(--toast-swipe-x)] data-[swiping]:transition-none data-[starting-style]:animate-in data-[ending-style]:animate-out data-[ending-style]:fade-out-80 data-[ending-style]:slide-out-to-right-full data-[starting-style]:slide-in-from-top-full data-[starting-style]:sm:slide-in-from-bottom-full motion-reduce:animate-none",
  {
    variants: {
      variant: {
        default: "default",
        destructive: "destructive",
        success: "success",
        warning: "warning",
        error: "error",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);
type ToastVariant = NonNullable<VariantProps<typeof toastVariants>["variant"]>;

/** The SDK names toast categories `type`; the public API keeps `variant`. */
const variantToType: Record<ToastVariant, "default" | "success" | "warning" | "error"> = {
  default: "default",
  destructive: "error",
  success: "success",
  warning: "warning",
  error: "error",
};

type ToasterProps = {
  class?: string;
};

/** Mounted once in `app-shell.tsx` (where the Kobalte Toaster used to be).
 *  The SDK renders the region in the top layer, so no Portal is needed. */
const Toaster = (props: ToasterProps) => {
  return (
    <ToastRegion
      class={cn(
        "z-[100] max-h-screen w-full p-3 md:max-w-[360px]",
        props.class,
      )}
    >
      {(item) => (
        <Toast variant={(item.data as { variant?: ToastVariant } | undefined)?.variant}>
          <div class="grid gap-1">
            <ToastTitle />
            <ToastDescription />
          </div>
          <ToastClose />
        </Toast>
      )}
    </ToastRegion>
  );
};

type ToastProps = ComponentProps<typeof ToastPrimitive> &
  VariantProps<typeof toastVariants> & { class?: string };

const Toast = (props: ToastProps) => {
  const others = omit(props, "class", "variant");
  return (
    <ToastPrimitive
      class={cn(toastVariants({ variant: props.variant }), props.class)}
      {...others}
    />
  );
};

type ToastCloseProps = ComponentProps<typeof ToastClosePrimitive> & { class?: string };

const ToastClose = (props: ToastCloseProps) => {
  const others = omit(props, "class");
  return (
    <ToastClosePrimitive
      class={cn(
        "absolute right-1.5 top-1.5 rounded-md p-1 text-foreground/50 opacity-0 ring-inset transition-opacity focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring group-hover:opacity-100 group-[.destructive]:text-destructive-foreground group-[.error]:text-error-foreground group-[.success]:text-success-foreground group-[.warning]:text-warning-foreground",
        props.class
      )}
      {...others}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="size-3.5"
      >
        <path d="M18 6l-12 12" />
        <path d="M6 6l12 12" />
      </svg>
    </ToastClosePrimitive>
  );
};

type ToastTitleProps = ComponentProps<typeof ToastTitlePrimitive> & { class?: string };

const ToastTitle = (props: ToastTitleProps) => {
  const others = omit(props, "class");
  return <ToastTitlePrimitive class={cn("text-xs font-semibold", props.class)} {...others} />;
};

type ToastDescriptionProps = ComponentProps<typeof ToastDescriptionPrimitive> & { class?: string };

const ToastDescription = (props: ToastDescriptionProps) => {
  const others = omit(props, "class");
  return <ToastDescriptionPrimitive class={cn("text-xs opacity-90", props.class)} {...others} />;
};

/** The SDK types toast content as JSX, but an element created outside a
 *  component renders as an empty ToastTitle in happy-dom. The only app caller
 *  passes strings; keep this imperative API text-only so announcements work. */
function showToast(props: {
  title?: string
  description?: string
  variant?: ToastVariant
  duration?: number
}) {
  toast({
    title: props.title,
    description: props.description,
    duration: props.duration,
    type: variantToType[props.variant ?? "default"],
    data: { variant: props.variant },
  });
}

export { Toaster, Toast, ToastClose, ToastTitle, ToastDescription, showToast }
export type { ToastVariant }
