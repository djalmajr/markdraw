import type { ComponentProps, JSX } from "@solidjs/web";
import { omit } from "solid-js";

import { Toggle as TogglePrimitive } from "@ui-sdk/solid/toggle";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@markdraw/core/utils.ts";

const toggleVariants = cva(
  "inline-flex items-center justify-center rounded-[2px] text-xs font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50 data-[pressed]:bg-primary/15 data-[pressed]:text-primary",
  {
    variants: {
      variant: {
        default: "bg-transparent hover:bg-accent hover:text-accent-foreground",
        outline: "border border-input bg-background shadow-none data-[pressed]:border-primary/30"
      },
      size: {
        default: "h-6 px-2",
        sm: "h-[22px] px-1.5",
        lg: "h-7 px-2.5"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
)

/** Native button props, minus `onChange` (the old Kobalte callback) which the
 *  wrapper maps to the ui-sdk's `onPressedChange`. `pressed`/`defaultPressed`
 *  and the variants keep their previous names so callers do not change. */
type ToggleProps = Omit<
  ComponentProps<"button">,
  "onChange" | "value" | "disabled" | "style" | "type" | "aria-pressed"
> &
  VariantProps<typeof toggleVariants> & {
    /** Group value; the SDK accepts only a string here. */
    value?: string
    disabled?: boolean
    style?: string | JSX.CSSProperties
    pressed?: boolean
    defaultPressed?: boolean
    onChange?: (pressed: boolean) => void
    class?: string | undefined
    children?: JSX.Element
  }

const Toggle = (props: ToggleProps) => {
  const others = omit(props, "class", "variant", "size", "onChange", "children", "pressed", "defaultPressed")
  return (
    <TogglePrimitive
      class={cn(toggleVariants({ variant: props.variant, size: props.size }), props.class)}
      pressed={props.pressed}
      defaultPressed={props.defaultPressed}
      onPressedChange={(pressed) => props.onChange?.(pressed)}
      {...others}
    >
      {props.children}
    </TogglePrimitive>
  )
}

export type { ToggleProps }
export { toggleVariants, Toggle }
