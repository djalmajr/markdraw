import { createContext, omit, useContext } from "solid-js";
import { Dynamic, type JSX, type ValidComponent } from "@solidjs/web";

import {
  Popover as PopoverPrimitive,
  PopoverContent as PopoverContentPrimitive,
  PopoverTrigger as PopoverTriggerPrimitive,
} from "@ui-sdk/solid/popover";

import { cn } from "@markdraw/core/utils.ts"

type Side = "top" | "right" | "bottom" | "left"
type Align = "start" | "center" | "end"

type PopoverLayout = {
  gutter?: number
  placement?: string
}

/** Kobalte put these on the root; the SDK puts them on the content part. */
const PopoverLayoutContext = createContext<() => PopoverLayout>(() => ({}))

const placementToSideAlign = (
  placement: string | undefined
): { side?: Side; align?: Align } => {
  if (!placement) return {}
  const [side, align] = placement.split("-")
  const resolvedSide =
    side === "top" || side === "right" || side === "bottom" || side === "left"
      ? side
      : undefined
  const resolvedAlign =
    align === "start" || align === "center" || align === "end" ? align : undefined
  return {
    ...(resolvedSide ? { side: resolvedSide } : {}),
    ...(resolvedAlign ? { align: resolvedAlign } : {}),
  }
}

const asRender = (
  as: ValidComponent | undefined,
  render: ((props: Record<string, any>, state: any) => JSX.Element) | undefined
) =>
  render ??
  (as
    ? (props: Record<string, any>) => <Dynamic component={as} {...props} />
    : undefined)

const Popover = (props: {
  gutter?: number
  placement?: string
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children?: JSX.Element
  [key: string]: any
}) => (
  <PopoverLayoutContext
    value={() => ({ gutter: props.gutter, placement: props.placement })}
  >
    <PopoverPrimitive {...omit(props, "gutter", "placement")} />
  </PopoverLayoutContext>
)

const PopoverTrigger = (props: {
  as?: ValidComponent
  render?: (props: Record<string, any>, state: any) => JSX.Element
  [key: string]: any
}) => {
  const others = omit(props, "as", "render")
  return (
    <PopoverTriggerPrimitive render={asRender(props.as, props.render)} {...others} />
  )
}

const PopoverContent = (props: {
  class?: string | undefined
  side?: Side
  align?: Align
  sideOffset?: number
  children?: JSX.Element
  [key: string]: any
}) => {
  const layout = useContext(PopoverLayoutContext)
  const placement = () => placementToSideAlign(layout().placement)
  const others = omit(props, "class", "side", "align", "sideOffset")
  return (
    <PopoverContentPrimitive
      side={props.side ?? placement().side}
      align={props.align ?? placement().align}
      sideOffset={props.sideOffset ?? layout().gutter ?? 4}
      class={cn(
        "z-50 w-72 origin-[var(--transform-origin)] rounded-md border bg-popover p-3 text-popover-foreground shadow-none outline-none transition-[opacity,scale] duration-150 ease-out data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95 motion-reduce:transition-opacity motion-reduce:data-[starting-style]:scale-100 motion-reduce:data-[ending-style]:scale-100",
        props.class
      )}
      {...others}
    />
  )
}

export { Popover, PopoverTrigger, PopoverContent }
