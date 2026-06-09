import type { JSX, ValidComponent } from "solid-js"
import { splitProps } from "solid-js"

import type { PolymorphicProps } from "@kobalte/core"
import * as SwitchPrimitive from "@kobalte/core/switch"

import { cn } from "@asciimark/core/utils.ts"

const Switch = SwitchPrimitive.Root
const SwitchDescription = SwitchPrimitive.Description
const SwitchErrorMessage = SwitchPrimitive.ErrorMessage

/** Switch size variants — keep all toggles in the app visually consistent.
 *  `sm` is the list/compact size; `default` is the standalone size. */
type SwitchSize = "default" | "sm"
const CONTROL_SIZE: Record<SwitchSize, string> = {
  default: "h-6 w-11",
  sm: "h-5 w-9",
}
const THUMB_SIZE: Record<SwitchSize, string> = {
  default: "size-5 data-[checked]:translate-x-5",
  sm: "size-4 data-[checked]:translate-x-4",
}

type SwitchControlProps = SwitchPrimitive.SwitchControlProps & {
  class?: string | undefined
  children?: JSX.Element
  size?: SwitchSize
}

const SwitchControl = <T extends ValidComponent = "input">(
  props: PolymorphicProps<T, SwitchControlProps>
) => {
  const [local, others] = splitProps(props as SwitchControlProps, ["class", "children", "size"])
  return (
    <>
      <SwitchPrimitive.Input
        class={cn(
          "[&:focus-visible+div]:outline-none [&:focus-visible+div]:ring-2 [&:focus-visible+div]:ring-ring [&:focus-visible+div]:ring-offset-2 [&:focus-visible+div]:ring-offset-background"
        )}
      />
      <SwitchPrimitive.Control
        class={cn(
          "inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent bg-input transition-[color,background-color,box-shadow] data-[disabled]:cursor-not-allowed data-[checked]:bg-primary data-[disabled]:opacity-50",
          CONTROL_SIZE[local.size ?? "default"],
          local.class
        )}
        {...others}
      >
        {local.children}
      </SwitchPrimitive.Control>
    </>
  )
}

type SwitchThumbProps = SwitchPrimitive.SwitchThumbProps & {
  class?: string | undefined
  size?: SwitchSize
}

const SwitchThumb = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, SwitchThumbProps>
) => {
  const [local, others] = splitProps(props as SwitchThumbProps, ["class", "size"])
  return (
    <SwitchPrimitive.Thumb
      class={cn(
        "pointer-events-none block translate-x-0 rounded-full bg-background shadow-sm ring-0 transition-transform",
        THUMB_SIZE[local.size ?? "default"],
        local.class
      )}
      {...others}
    />
  )
}

type SwitchLabelProps = SwitchPrimitive.SwitchLabelProps & { class?: string | undefined }

const SwitchLabel = <T extends ValidComponent = "label">(
  props: PolymorphicProps<T, SwitchLabelProps>
) => {
  const [local, others] = splitProps(props as SwitchLabelProps, ["class"])
  return (
    <SwitchPrimitive.Label
      class={cn(
        "text-sm font-medium leading-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-70",
        local.class
      )}
      {...others}
    />
  )
}

export { Switch, SwitchControl, SwitchThumb, SwitchLabel, SwitchDescription, SwitchErrorMessage }
