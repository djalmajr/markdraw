import type { ValidComponent } from "@solidjs/web";
import { omit } from "solid-js";
import type { PolymorphicProps } from "@kobalte/core/polymorphic"
import * as ToggleButtonPrimitive from "@kobalte/core/toggle-button"
import { cva } from "class-variance-authority"
import type { VariantProps } from "class-variance-authority"

import { cn } from "@markdraw/core/utils.ts"

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

type ToggleButtonRootProps<T extends ValidComponent = "button"> =
  ToggleButtonPrimitive.ToggleButtonRootProps<T> &
    VariantProps<typeof toggleVariants> & { class?: string | undefined }

const Toggle = <T extends ValidComponent = "button">(
  props: PolymorphicProps<T, ToggleButtonRootProps<T>>
) => {
  const others = omit(props, "class", "variant", "size")
  return (
    <ToggleButtonPrimitive.Root
      class={cn(toggleVariants({ variant: props.variant, size: props.size }), props.class)}
      {...others}
    />
  )
}

export type { ToggleButtonRootProps as ToggleProps }
export { toggleVariants, Toggle }
