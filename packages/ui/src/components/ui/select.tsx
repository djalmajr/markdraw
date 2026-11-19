import type { JSX } from "@solidjs/web";
import { createContext, createEffect, createSignal, For, omit, useContext, type Accessor } from "solid-js";

import {
  Select as SelectPrimitive,
  SelectContent as SelectContentPrimitive,
  SelectItem as SelectItemPrimitive,
  SelectItemIndicator as SelectItemIndicatorPrimitive,
  SelectTrigger as SelectTriggerPrimitive,
  SelectValue as SelectValuePrimitive,
} from "@ui-sdk/solid/select";
import IconCheck from "~icons/lucide/check"
import IconChevronDown from "~icons/lucide/chevron-down"

import { cn } from "@markdraw/core/utils.ts"

/** The old Kobalte collection node, kept as the shape handed to
 *  `itemComponent` so existing callers keep using `item.rawValue`. */
type SelectItemNode<T> = {
  type: "item"
  key: string
  rawValue: T
  textValue: string
  disabled: boolean
  level: number
  index: number
}

type SelectContextValue<T> = {
  options: Accessor<SelectItemNode<T>[]>
  itemComponent: () => ((props: { item: SelectItemNode<T> }) => JSX.Element) | undefined
  keyFor: (value: T) => string
  fromKey: (key: string) => T | undefined
  disabledKeys: Accessor<Set<string>>
  setDisabled: (key: string, disabled: boolean) => void
}

const SelectContext = createContext<SelectContextValue<any> | null>(null);

type SelectProps<T> = {
  value?: T | null
  defaultValue?: T | null
  /** Kobalte's callback name; receives the raw option, or null when cleared. */
  onChange?: (value: T | null) => void
  options: T[]
  itemComponent?: (props: { item: SelectItemNode<T> }) => JSX.Element
  placeholder?: string
  disabled?: boolean
  required?: boolean
  name?: string
  class?: string | undefined
  children?: JSX.Element
}

/** Adapter over the ui-sdk Select. The sdk identifies options by string, so
 *  raw values (including numbers) are keyed here and mapped back on change. */
const Select = <T,>(props: SelectProps<T>) => {
  const keyFor = (value: T) => String(value)
  const fromKey = (key: string) => props.options.find((option) => keyFor(option) === key)
  const nodes = () => props.options.map((rawValue, index) => ({
    type: "item" as const,
    key: keyFor(rawValue),
    rawValue,
    textValue: String(rawValue),
    disabled: false,
    level: 0,
    index,
  }))
  const [disabledKeys, setDisabledKeys] = createSignal(new Set<string>())
  const setDisabled = (key: string, disabled: boolean) => setDisabledKeys((previous) => {
    if (previous.has(key) === disabled) return previous
    const next = new Set(previous)
    if (disabled) next.add(key)
    else next.delete(key)
    return next
  })
  const context: SelectContextValue<T> = {
    options: nodes,
    itemComponent: () => props.itemComponent,
    keyFor,
    fromKey,
    disabledKeys,
    setDisabled,
  }
  const selectedKey = () => props.value === undefined || props.value === null ? undefined : keyFor(props.value)
  const defaultKey = () => props.defaultValue == null ? undefined : keyFor(props.defaultValue)
  return (
    <SelectContext value={context}>
      <SelectPrimitive<string>
        items={nodes().map((node) => ({
          value: node.key,
          label: node.textValue,
          disabled: disabledKeys().has(node.key),
        }))}
        value={selectedKey()}
        defaultValue={defaultKey()}
        onValueChange={(key) => props.onChange?.(typeof key === "string" ? fromKey(key) ?? null : null)}
        placeholder={props.placeholder}
        disabled={props.disabled}
        required={props.required}
        name={props.name}
      >
        {props.children}
      </SelectPrimitive>
    </SelectContext>
  )
}

type SelectTriggerProps = {
  class?: string | undefined
  children?: JSX.Element
  "aria-label"?: string
}

const SelectTrigger = (props: SelectTriggerProps) => {
  const others = omit(props, "class", "children")
  return (
    <SelectTriggerPrimitive
      class={cn(
        "flex h-6 w-full items-center justify-between rounded-[2px] border border-input bg-background px-2 py-0.5 text-xs ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 data-[invalid]:border-error-foreground data-[invalid]:text-error-foreground [&>span]:line-clamp-1",
        props.class
      )}
      {...others}
    >
      {props.children}
      <IconChevronDown class="size-3 shrink-0 opacity-50" />
    </SelectTriggerPrimitive>
  )
}

type SelectContentProps = {
  class?: string | undefined
  children?: JSX.Element
}

const SelectContent = (props: SelectContentProps) => {
  const context = useContext(SelectContext)
  const others = omit(props, "class", "children")
  return (
    <SelectContentPrimitive
      class={cn(
        "relative z-50 min-w-[8rem] origin-[var(--transform-origin)] overflow-hidden rounded-[2px] border bg-popover p-1 text-popover-foreground shadow-none outline-none transition-[opacity,scale,transform] duration-150 ease-out data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 motion-reduce:transition-none",
        props.class
      )}
      {...others}
    >
      <For each={context?.options()}>
        {(node) => context?.itemComponent()?.({ item: node }) ?? (
          <SelectItem item={node}>{node.textValue}</SelectItem>
        )}
      </For>
      {props.children}
    </SelectContentPrimitive>
  )
}

type SelectItemProps<T> = {
  item?: SelectItemNode<T>
  value?: T
  label?: string
  disabled?: boolean
  class?: string | undefined
  children?: JSX.Element
}

const SelectItem = <T,>(props: SelectItemProps<T>) => {
  const context = useContext(SelectContext)
  const rawValue = () => (props.item ? props.item.rawValue : props.value) as T
  const key = () => context ? context.keyFor(rawValue()) : String(rawValue())
  const disabled = () => props.disabled ?? props.item?.disabled ?? false
  // The sdk's keyboard delegate reads `items` on the root, so a disabled part
  // has to be published there (in an effect, never in the render body).
  createEffect(
    () => [key(), disabled()] as const,
    ([itemKey, itemDisabled]) => {
      context?.setDisabled(itemKey, itemDisabled)
    }
  )
  return (
    <SelectItemPrimitive<string>
      value={key()}
      label={props.label ?? props.item?.textValue}
      disabled={disabled()}
      class={cn(
        "relative flex w-full cursor-default select-none items-center rounded-[2px] py-0.5 pl-6 pr-2 text-xs outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        props.class
      )}
    >
      <span class="absolute left-2 flex size-3 items-center justify-center">
        <SelectItemIndicatorPrimitive>
          <IconCheck class="size-3" />
        </SelectItemIndicatorPrimitive>
      </span>
      {props.children}
    </SelectItemPrimitive>
  )
}

type SelectValueProps<T> = {
  children?: JSX.Element | ((state: { selectedOption: Accessor<T | undefined> }) => JSX.Element)
  class?: string | undefined
}

const SelectValue = <T,>(props: SelectValueProps<T>) => {
  const context = useContext(SelectContext)
  return (
    <SelectValuePrimitive class={props.class}>
      {(state) => typeof props.children === "function"
        ? props.children({ selectedOption: () => context?.fromKey(String(state.value)) as T | undefined })
        : props.children}
    </SelectValuePrimitive>
  )
}

/** The sdk root owns the hidden native select (pass `name` to it), so this
 *  compatibility export renders nothing; no caller uses the old part. */
const SelectHiddenSelect = () => null;

export { Select, SelectContent, SelectHiddenSelect, SelectItem, SelectTrigger, SelectValue }
