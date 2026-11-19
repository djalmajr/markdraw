import { type JSX, type ValidComponent, Dynamic } from "@solidjs/web"
import { omit, type Component } from "solid-js"

import {
  Tooltip as TooltipPrimitive,
  TooltipContent as TooltipContentPrimitive,
  TooltipTrigger as TooltipTriggerPrimitive,
} from "@ui-sdk/solid/tooltip"

import { cn } from "@markdraw/core/utils.ts"

type TooltipProps = {
  /** Kobalte's name for the SDK's `delay`. */
  openDelay?: number
  closeDelay?: number
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children?: JSX.Element
  [key: string]: any
}

/** ui-sdk's Trigger renders a `button`, like Kobalte's did. */
const asRender = (
  as: ValidComponent | undefined,
  render: ((props: Record<string, any>, state: any) => JSX.Element) | undefined
) =>
  render ??
  (as
    ? (partProps: Record<string, any>) => <Dynamic component={as} {...partProps} />
    : undefined)

const TooltipTrigger = (props: {
  as?: ValidComponent
  render?: (props: Record<string, any>, state: any) => JSX.Element
  [key: string]: any
}) => {
  const others = omit(props, "as", "render")
  return (
    <TooltipTriggerPrimitive render={asRender(props.as, props.render)} {...others} />
  )
}

const Tooltip: Component<TooltipProps> = (props) => (
  <TooltipPrimitive
    delay={props.delay ?? props.openDelay}
    closeDelay={props.closeDelay}
    {...omit(props, "delay", "openDelay", "closeDelay")}
  />
)

type TooltipContentProps = {
  class?: string | undefined
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  sideOffset?: number
  children?: JSX.Element
  [key: string]: any
}

const TooltipContent = (props: TooltipContentProps) => {
  const others = omit(props, "class", "children", "sideOffset")
  return (
    <TooltipContentPrimitive
      // Kobalte's `gutter` became the SDK's `sideOffset` on the content part.
      sideOffset={props.sideOffset ?? 4}
      class={cn(
        "z-50 origin-[var(--transform-origin)] overflow-hidden rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-none outline-none transition-[opacity,scale] duration-150 ease-out data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95 data-[instant]:transition-none motion-reduce:transition-opacity motion-reduce:data-[starting-style]:scale-100 motion-reduce:data-[ending-style]:scale-100",
        props.class
      )}
      {...others}
    >
      {props.children}
    </TooltipContentPrimitive>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent }
