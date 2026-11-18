import type { ComponentProps, JSX } from "@solidjs/web";
import { createContext, merge, omit, useContext } from "solid-js";

import { Field as FieldPrimitive, FieldDescription, FieldError, FieldLabel } from "@ui-sdk/solid/field";
import { Input } from "@ui-sdk/solid/input";
import { Textarea } from "@ui-sdk/solid/textarea";
import { cva } from "class-variance-authority";

import { cn } from "@markdraw/core/utils.ts";

/** The old Kobalte root owned `value`/`onChange` and fed them to its Input and
 *  TextArea. The ui-sdk Field only ties a control to its label/description, so
 *  the shared value props are published to the parts through this context. */
type TextFieldContextValue = {
  value: () => string | undefined
  defaultValue: () => string | undefined
  onChange: (value: string) => void
  name: () => string | undefined
  disabled: () => boolean | undefined
  readOnly: () => boolean | undefined
  required: () => boolean | undefined
}

const TextFieldContext = createContext<TextFieldContextValue | null>(null);

type TextFieldProps = {
  value?: string
  defaultValue?: string
  /** Kobalte's callback name; receives the new string value. */
  onChange?: (value: string) => void
  name?: string
  validationState?: "valid" | "invalid"
  disabled?: boolean
  readOnly?: boolean
  required?: boolean
  class?: string | undefined
  children?: JSX.Element
}

const TextField = (props: TextFieldProps) => {
  const others = omit(props, "class", "children", "value", "defaultValue", "onChange", "validationState", "readOnly")
  return (
    <TextFieldContext
      value={{
        value: () => props.value,
        defaultValue: () => props.defaultValue,
        onChange: (value) => props.onChange?.(value),
        name: () => props.name,
        disabled: () => props.disabled,
        readOnly: () => props.readOnly,
        required: () => props.required,
      }}
    >
      <FieldPrimitive
        invalid={props.validationState === "invalid"}
        class={cn("flex flex-col gap-1", props.class)}
        {...others}
      >
        {props.children}
      </FieldPrimitive>
    </TextFieldContext>
  )
}

type TextFieldInputProps = Omit<
  ComponentProps<"input">,
  "onChange" | "onValueChange" | "readOnly" | "style"
> & {
  /** Kobalte spelling; the SDK's native prop is lowercase `readonly`. */
  readOnly?: boolean
  style?: string | JSX.CSSProperties
  type?:
    | "button"
    | "checkbox"
    | "color"
    | "date"
    | "datetime-local"
    | "email"
    | "file"
    | "hidden"
    | "image"
    | "month"
    | "number"
    | "password"
    | "radio"
    | "range"
    | "reset"
    | "search"
    | "submit"
    | "tel"
    | "text"
    | "time"
    | "url"
    | "week"
  value?: string
  defaultValue?: string
  onValueChange?: ComponentProps<typeof Input>["onValueChange"]
  class?: string | undefined
}

const TextFieldInput = (rawProps: TextFieldInputProps) => {
  const context = useContext(TextFieldContext)
  const props = merge({ type: "text" as const }, rawProps)
  const others = omit(props, "type", "class", "value", "defaultValue", "onValueChange", "readOnly")
  return (
    <Input
      type={props.type}
      value={props.value ?? context?.value()}
      defaultValue={props.defaultValue ?? context?.defaultValue()}
      name={props.name ?? context?.name()}
      disabled={props.disabled ?? context?.disabled()}
      readonly={props.readOnly ?? context?.readOnly()}
      required={props.required ?? context?.required()}
      onValueChange={(value, details) => {
        context?.onChange(value)
        props.onValueChange?.(value, details)
      }}
      class={cn(
        "flex h-6 w-full rounded-[2px] border border-input bg-background px-2 py-0.5 text-xs ring-offset-background file:border-0 file:bg-transparent file:text-xs file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 data-[invalid]:border-error-foreground data-[invalid]:text-error-foreground",
        props.class
      )}
      {...others}
    />
  )
}

type TextFieldTextAreaProps = Omit<
  ComponentProps<"textarea">,
  "onChange" | "onValueChange" | "readOnly" | "style" | "onSubmit"
> & {
  readOnly?: boolean
  style?: string | JSX.CSSProperties
  onSubmit?: ComponentProps<typeof Textarea>["onSubmit"]
  value?: string
  defaultValue?: string
  onValueChange?: ComponentProps<typeof Textarea>["onValueChange"]
  class?: string | undefined
}

const TextFieldTextArea = (props: TextFieldTextAreaProps) => {
  const context = useContext(TextFieldContext)
  const others = omit(props, "class", "value", "defaultValue", "onValueChange", "readOnly")
  return (
    <Textarea
      value={props.value ?? context?.value()}
      defaultValue={props.defaultValue ?? context?.defaultValue()}
      name={props.name ?? context?.name()}
      disabled={props.disabled ?? context?.disabled()}
      readonly={props.readOnly ?? context?.readOnly()}
      required={props.required ?? context?.required()}
      onValueChange={(value, details) => {
        context?.onChange(value)
        props.onValueChange?.(value, details)
      }}
      class={cn(
        "flex min-h-14 w-full rounded-[2px] border border-input bg-background px-2 py-1 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50",
        props.class
      )}
      {...others}
    />
  )
}

const labelVariants = cva(
  "text-xs font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
  {
    variants: {
      variant: {
        label: "data-[invalid]:text-destructive",
        description: "font-normal text-muted-foreground",
        error: "text-xs text-destructive"
      }
    },
    defaultVariants: {
      variant: "label"
    }
  }
)

type TextFieldLabelProps = { class?: string | undefined; children?: JSX.Element }

const TextFieldLabel = (props: TextFieldLabelProps) => {
  const others = omit(props, "class", "children")
  return <FieldLabel class={cn(labelVariants(), props.class)} {...others}>{props.children}</FieldLabel>
}

type TextFieldDescriptionProps = { class?: string | undefined; children?: JSX.Element }

const TextFieldDescription = (props: TextFieldDescriptionProps) => {
  const others = omit(props, "class", "children")
  return (
    <FieldDescription class={cn(labelVariants({ variant: "description" }), props.class)} {...others}>
      {props.children}
    </FieldDescription>
  )
}

type TextFieldErrorMessageProps = { class?: string | undefined; children?: JSX.Element }

const TextFieldErrorMessage = (props: TextFieldErrorMessageProps) => {
  const others = omit(props, "class", "children")
  return (
    <FieldError class={cn(labelVariants({ variant: "error" }), props.class)} {...others}>
      {props.children}
    </FieldError>
  )
}

export {
  TextField,
  TextFieldInput,
  TextFieldTextArea,
  TextFieldLabel,
  TextFieldDescription,
  TextFieldErrorMessage
}
