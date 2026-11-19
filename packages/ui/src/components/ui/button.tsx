import type { ComponentProps, JSX } from "@solidjs/web"
import { Show, omit } from "solid-js"

import { Button as ButtonPrimitive } from "@ui-sdk/solid/button"
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

import { cn } from "@markdraw/core/utils.ts"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[2px] text-xs font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline"
      },
      size: {
        default: "h-6 px-2 py-0.5",
        sm: "h-[22px] px-2",
        lg: "h-7 px-2.5",
        icon: "size-6"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
)

/** Native `button` props. The Kobalte `as`/polymorphism generic is gone: no
 *  call site used it, and ui-sdk renders a different tag through `render`. */
type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    class?: string | undefined
    children?: JSX.Element
    /** Show a spinner and disable the button while an async action runs. */
    loading?: boolean
  }

/** `class`, `variant`, `size`, `loading`, `children` and `disabled` are ours;
 *  everything else (native props, event handlers) spreads onto the part. */
const Button = (props: ButtonProps) => {
  // The DOM prop type admits `false`/RemoveAttribute on `type`, `style`, etc.;
  // the ui-sdk part only accepts real HTML values.
  const others = omit(
    props,
    "variant",
    "size",
    "class",
    "loading",
    "children",
    "disabled",
    "style",
  ) as Omit<ComponentProps<typeof ButtonPrimitive>, "class" | "disabled" | "children" | "style">
  return (
    <ButtonPrimitive
      class={cn(buttonVariants({ variant: props.variant, size: props.size }), props.class)}
      disabled={!!(props.loading || props.disabled)}
      style={props.style as string | JSX.CSSProperties | undefined}
      {...others}
    >
      <Show when={props.loading}>
        {/* Inline lucide `loader-circle` — keeps this shared primitive consumable
            by builds without unplugin-icons (e.g. the marketing site), matching
            the inline-svg convention of the sibling Kobalte wrappers. */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="size-3.5 animate-spin"
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      </Show>
      {props.children}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants }
export type { ButtonProps }
