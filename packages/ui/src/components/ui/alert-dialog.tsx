import type { JSX } from "@solidjs/web"
import { omit } from "solid-js"

import {
  AlertDialog as AlertDialogPrimitive,
  AlertDialogBackdrop as AlertDialogBackdropPrimitive,
  AlertDialogContent as AlertDialogContentPrimitive,
  AlertDialogDescription as AlertDialogDescriptionPrimitive,
  AlertDialogTitle as AlertDialogTitlePrimitive,
  AlertDialogTrigger as AlertDialogTriggerPrimitive,
} from "@ui-sdk/solid/alert-dialog"

import { cn } from "@markdraw/core/utils.ts"

/** Same `open` / `onOpenChange` pair Kobalte's root used. */
const AlertDialog = (props: {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children?: JSX.Element
  [key: string]: any
}) => <AlertDialogPrimitive {...props} />

const AlertDialogTrigger = (props: { [key: string]: any }) => (
  <AlertDialogTriggerPrimitive {...props} />
)

/** Kobalte called this part `Overlay`; ui-sdk calls it `Backdrop`. */
const AlertDialogOverlay = (props: {
  class?: string | undefined
  [key: string]: any
}) => {
  const others = omit(props, "class")
  return (
    <AlertDialogBackdropPrimitive
      class={cn(
        "fixed inset-0 z-50 bg-foreground/[0.18] backdrop-blur-[2px] transition-opacity duration-200 ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 motion-reduce:transition-none",
        props.class
      )}
      {...others}
    />
  )
}

/** Kobalte rendered the overlay inside the content's portal. The SDK has no
 *  portal part, so keep the same DOM result by rendering the backdrop beside
 *  the content. */
const AlertDialogContent = (props: {
  class?: string | undefined
  children?: JSX.Element
  [key: string]: any
}) => {
  const others = omit(props, "class", "children")
  return (
    <>
      <AlertDialogOverlay />
      <AlertDialogContentPrimitive
        class={cn(
          "fixed left-1/2 top-1/2 z-50 grid w-full max-w-md -translate-x-1/2 -translate-y-1/2 origin-center gap-3 border bg-background p-4 shadow-none outline-none transition-[opacity,scale] duration-200 ease-out data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95 motion-reduce:transition-opacity motion-reduce:data-[starting-style]:scale-100 motion-reduce:data-[ending-style]:scale-100 sm:rounded-[2px]",
          props.class
        )}
        {...others}
      >
        {props.children}
      </AlertDialogContentPrimitive>
    </>
  )
}

const AlertDialogTitle = (props: {
  class?: string | undefined
  children?: JSX.Element
  [key: string]: any
}) => {
  const others = omit(props, "class", "children")
  return (
    <AlertDialogTitlePrimitive class={cn("text-sm font-semibold", props.class)} {...others}>
      {props.children}
    </AlertDialogTitlePrimitive>
  )
}

const AlertDialogDescription = (props: {
  class?: string | undefined
  children?: JSX.Element
  [key: string]: any
}) => {
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
