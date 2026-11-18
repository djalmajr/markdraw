import type { JSX } from "@solidjs/web"
import { omit, type Component } from "solid-js"

import {
  AlertDialog as AlertDialogPrimitive,
  AlertDialogBackdrop as AlertDialogBackdropPrimitive,
  AlertDialogContent as AlertDialogContentPrimitive,
  AlertDialogDescription as AlertDialogDescriptionPrimitive,
  AlertDialogTitle as AlertDialogTitlePrimitive,
  AlertDialogTrigger as AlertDialogTriggerPrimitive,
} from "@ui-sdk/solid/alert-dialog"

import { cn } from "@markdraw/core/utils.ts"

/** ui-sdk's Alert Dialog takes the same `open` / `onOpenChange` pair as
 *  Kobalte's root, so the root and trigger are re-exported as they were. */
const AlertDialog = AlertDialogPrimitive
const AlertDialogTrigger = AlertDialogTriggerPrimitive

type AlertDialogOverlayProps = {
  class?: string | undefined
}

/** Kobalte called this part `Overlay`; ui-sdk calls it `Backdrop`. Kept under
 *  the old name because it is the module's public surface. */
const AlertDialogOverlay = (props: AlertDialogOverlayProps) => {
  return (
    <AlertDialogBackdropPrimitive
      class={cn(
        "fixed inset-0 z-50 bg-foreground/[0.18] backdrop-blur-[2px] data-[open]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[open]:fade-in-0",
        props.class
      )}
    />
  )
}

type AlertDialogContentProps = {
  class?: string | undefined
  children?: JSX.Element
}

/** Kobalte rendered the overlay from inside the content's portal; ui-sdk has
 *  no portal part (popups render in place, or into `container`), so the
 *  backdrop is rendered beside the content to keep the same DOM result. */
const AlertDialogContent = (props: AlertDialogContentProps) => {
  const others = omit(props, "class", "children")
  return (
    <>
      <AlertDialogOverlay />
      <AlertDialogContentPrimitive
        class={cn(
          "fixed left-1/2 top-1/2 z-50 grid w-full max-w-md -translate-x-1/2 -translate-y-1/2 gap-3 border bg-background p-4 shadow-none duration-200 data-[open]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:zoom-out-95 data-[open]:zoom-in-95 data-[closed]:slide-out-to-left-1/2 data-[closed]:slide-out-to-top-[48%] data-[open]:slide-in-from-left-1/2 data-[open]:slide-in-from-top-[48%] sm:rounded-[2px]",
          props.class
        )}
        {...others}
      >
        {props.children}
      </AlertDialogContentPrimitive>
    </>
  )
}

type AlertDialogTitleProps = {
  class?: string | undefined
  children?: JSX.Element
}

const AlertDialogTitle: Component<AlertDialogTitleProps> = (props) => {
  const others = omit(props, "class", "children")
  return (
    <AlertDialogTitlePrimitive class={cn("text-sm font-semibold", props.class)} {...others}>
      {props.children}
    </AlertDialogTitlePrimitive>
  )
}

type AlertDialogDescriptionProps = {
  class?: string | undefined
  children?: JSX.Element
}

const AlertDialogDescription: Component<AlertDialogDescriptionProps> = (props) => {
  const others = omit(props, "class", "children")
  return (
    <AlertDialogDescriptionPrimitive class={cn("text-xs text-muted-foreground", props.class)} {...others}>
      {props.children}
    </AlertDialogDescriptionPrimitive>
  )
}

export {
  AlertDialog,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
}
