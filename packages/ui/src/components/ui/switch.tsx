import type { JSX, ValidComponent } from "solid-js"
import { splitProps } from "solid-js"

import type { PolymorphicProps } from "@kobalte/core"
import * as SwitchPrimitive from "@kobalte/core/switch"

import { cn } from "@markdraw/core/utils.ts"

type SwitchRootProps = SwitchPrimitive.SwitchRootProps & {
  class?: string | undefined
  children?: JSX.Element
}

/** Switch root. kobalte renders a visually-hidden `<input>` as
 *  `position: absolute`; without a positioned root it anchors to the nearest
 *  positioned ancestor (e.g. a `fixed` modal), so a real click on a switch in a
 *  SCROLLED list makes the browser scroll-into-view to that stale position —
 *  jumping the list and leaving a blank gap. `relative` anchors the input to the
 *  switch itself, keeping the scroll put. */
const Switch = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, SwitchRootProps>
) => {
  const [local, others] = splitProps(props as SwitchRootProps, ["class", "children"])
  return (
    <SwitchPrimitive.Root class={cn("relative", local.class)} {...others}>
      {local.children}
    </SwitchPrimitive.Root>
  )
}
const SwitchDescription = SwitchPrimitive.Description
const SwitchErrorMessage = SwitchPrimitive.ErrorMessage

/** Switch size variants — the compact squared switch is the default DS shape. */
type SwitchSize = "default" | "sm"
const CONTROL_SIZE: Record<SwitchSize, string> = {
  default: "h-4 w-[29px]",
  sm: "h-4 w-[29px]",
}
const THUMB_SIZE: Record<SwitchSize, string> = {
  default: "size-3 data-[checked]:translate-x-[13px]",
  sm: "size-3 data-[checked]:translate-x-[13px]",
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
          "inline-flex shrink-0 cursor-pointer items-center rounded-[2px] border border-input bg-input p-[1px] transition-[color,background-color,border-color,box-shadow] data-[disabled]:cursor-not-allowed data-[checked]:border-primary data-[checked]:bg-primary data-[disabled]:opacity-50",
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
        "pointer-events-none block translate-x-0 rounded-[2px] bg-background shadow-none ring-0 transition-transform",
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
        "text-xs font-medium leading-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-70",
        local.class
      )}
      {...others}
    />
  )
}

export { Switch, SwitchControl, SwitchThumb, SwitchLabel, SwitchDescription, SwitchErrorMessage }
