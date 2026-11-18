import type { JSX } from "@solidjs/web"
import { omit, type Component } from "solid-js"

import {
  Tooltip as TooltipPrimitive,
  TooltipContent as TooltipContentPrimitive,
  TooltipTrigger as TooltipTriggerPrimitive,
} from "@ui-sdk/solid/tooltip"

import { cn } from "@markdraw/core/utils.ts"

/** ui-sdk's Trigger renders a `button`, like Kobalte's did. */
const TooltipTrigger = TooltipTriggerPrimitive

type TooltipProps = {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children?: JSX.Element
}

/** Kobalte's root took `gutter`; ui-sdk names the same gap `sideOffset` and
 *  puts it on the content part, so the default lives in `TooltipContent`. */
const Tooltip: Component<TooltipProps> = (props) => {
  return <TooltipPrimitive {...props} />
}

type TooltipContentProps = {
  class?: string | undefined
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  sideOffset?: number
  children?: JSX.Element
}

const TooltipContent = (props: TooltipContentProps) => {
  const others = omit(props, "class", "children", "sideOffset")
  return (
    <TooltipContentPrimitive
      sideOffset={props.sideOffset ?? 4}
      // Kobalte exposed `--kb-popover-content-transform-origin`; ui-sdk exposes
      // the same point as `--transform-origin` on the content element.
      class={cn(
        "z-50 origin-[var(--transform-origin)] overflow-hidden rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-none animate-in fade-in-0 zoom-in-95",
        props.class
      )}
      {...others}
    >
      {props.children}
    </TooltipContentPrimitive>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent }
