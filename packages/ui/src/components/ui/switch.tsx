import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";

import { FieldDescription, FieldError } from "@ui-sdk/solid/field";
import { Switch as SwitchPrimitive, SwitchThumb as SwitchThumbPrimitive } from "@ui-sdk/solid/switch";

import { cn } from "@markdraw/core/utils.ts";

type SwitchRootProps = {
  disabled?: boolean
  name?: string
  value?: string
  checked?: boolean
  defaultChecked?: boolean
  /** Kobalte's callback name; the ui-sdk calls it `onCheckedChange`. */
  onChange?: (checked: boolean) => void
  readOnly?: boolean
  required?: boolean
  validationState?: "valid" | "invalid"
  "aria-label"?: string
  "aria-labelledby"?: string
  "aria-describedby"?: string
  id?: string
  class?: string | undefined
  children?: JSX.Element
}

/** The ui-sdk Switch is the control itself (a `role="switch"` button with a
 *  hidden native input). `relative` keeps that absolute input anchored here,
 *  as it was with the old wrapper, so clicking in a scrolled list doesn't
 *  scroll the list to a stale input position. */
const Switch = (props: SwitchRootProps) => {
  const others = omit(props, "class", "children", "onChange", "validationState")
  return (
    <SwitchPrimitive
      class={cn("relative", props.class)}
      onCheckedChange={(checked) => props.onChange?.(checked)}
      aria-invalid={props.validationState === "invalid" ? "true" : undefined}
      {...others}
    >
      {props.children}
    </SwitchPrimitive>
  )
}

const SwitchDescription = (props: { class?: string; children?: JSX.Element }) => (
  <FieldDescription class={cn("text-xs font-normal text-muted-foreground", props.class)}>
    {props.children}
  </FieldDescription>
)

const SwitchErrorMessage = (props: { class?: string; children?: JSX.Element }) => (
  <FieldError class={cn("text-xs text-destructive", props.class)}>{props.children}</FieldError>
)

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

type SwitchControlProps = {
  class?: string | undefined
  children?: JSX.Element
  size?: SwitchSize
}

/** The visual track. The interactive element is the root Switch, so this is
 *  only the box around the thumb; the SDK supplies the hidden input. */
const SwitchControl = (props: SwitchControlProps) => (
  <span
    class={cn(
      "inline-flex shrink-0 cursor-pointer items-center rounded-[2px] border border-input bg-input p-[1px] transition-[color,background-color,border-color,box-shadow] data-[disabled]:cursor-not-allowed data-[checked]:border-primary data-[checked]:bg-primary data-[disabled]:opacity-50",
      CONTROL_SIZE[props.size ?? "default"],
      props.class
    )}
  >
    {props.children}
  </span>
)

type SwitchThumbProps = {
  class?: string | undefined
  size?: SwitchSize
}

const SwitchThumb = (props: SwitchThumbProps) => (
  <SwitchThumbPrimitive
    class={cn(
      "pointer-events-none block translate-x-0 rounded-[2px] bg-background shadow-none ring-0 transition-transform",
      THUMB_SIZE[props.size ?? "default"],
      props.class
    )}
  />
)

type SwitchLabelProps = {
  class?: string | undefined
  children?: JSX.Element
}

const SwitchLabel = (props: SwitchLabelProps) => (
  <label
    class={cn(
      "text-xs font-medium leading-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-70",
      props.class
    )}
  >
    {props.children}
  </label>
)

export { Switch, SwitchControl, SwitchThumb, SwitchLabel, SwitchDescription, SwitchErrorMessage }
