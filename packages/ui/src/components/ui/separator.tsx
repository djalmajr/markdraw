import type { ValidComponent } from "@solidjs/web";
import { omit } from "solid-js";
import type { PolymorphicProps } from "@kobalte/core/polymorphic"
import * as SeparatorPrimitive from "@kobalte/core/separator"

import { cn } from "@markdraw/core/utils.ts"

type SeparatorRootProps<T extends ValidComponent = "hr"> =
  SeparatorPrimitive.SeparatorRootProps<T> & { class?: string | undefined }

const Separator = <T extends ValidComponent = "hr">(
  props: PolymorphicProps<T, SeparatorRootProps<T>>
) => {
  const others = omit(props, "class", "orientation")
  return (
    <SeparatorPrimitive.Root
      orientation={props.orientation ?? "horizontal"}
      class={cn(
        "shrink-0 bg-border",
        props.orientation === "vertical" ? "h-full w-px" : "h-px w-full",
        props.class
      )}
      {...others}
    />
  )
}

export { Separator }
