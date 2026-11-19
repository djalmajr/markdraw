import { createContext, omit, useContext } from "solid-js";
import { Dynamic, type JSX, type ValidComponent } from "@solidjs/web";

import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "@ui-sdk/solid/menu";

import { cn } from "@markdraw/core/utils.ts"

const MenuLayoutContext = createContext<() => { gutter?: number }>(() => ({}))

const DropdownMenuGroup = MenuGroup
const DropdownMenuGroupLabel = MenuGroupLabel
const DropdownMenuSub = MenuSub
// The SDK requires `value` on these parts; our wrapper keeps Kobalte's looser
// public signature so existing call sites keep compiling.
const CheckboxItem = MenuCheckboxItem as (props: any) => JSX.Element
const RadioItem = MenuRadioItem as (props: any) => JSX.Element

const asRender = (
  as: ValidComponent | undefined,
  render: ((props: Record<string, any>, state: any) => JSX.Element) | undefined
) =>
  render ??
  (as
    ? (props: Record<string, any>) => <Dynamic component={as} {...props} />
    : undefined)

/** Kobalte called this `gutter`; the SDK takes `sideOffset` on the content. */
const DropdownMenu = (props: { gutter?: number; [key: string]: any }) => (
  <MenuLayoutContext value={() => ({ gutter: props.gutter })}>
    <Menu {...omit(props, "gutter")} />
  </MenuLayoutContext>
)

const DropdownMenuTrigger = (props: {
  as?: ValidComponent
  render?: (props: Record<string, any>, state: any) => JSX.Element
  [key: string]: any
}) => {
  const others = omit(props, "as", "render")
  return <MenuTrigger render={asRender(props.as, props.render)} {...others} />
}

const closeAutoFocusToFinalFocus = (
  onCloseAutoFocus: ((event: Event) => void) | undefined,
  finalFocus: any
) => {
  if (finalFocus !== undefined) return finalFocus
  if (!onCloseAutoFocus) return undefined
  return () => {
    let prevented = false
    onCloseAutoFocus({
      preventDefault: () => {
        prevented = true
      },
    } as unknown as Event)
    return prevented ? "none" : "trigger"
  }
}

const contentClasses =
  "z-50 min-w-[8rem] origin-[var(--transform-origin)] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-none outline-none transition-[opacity,scale] duration-150 ease-out data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95 motion-reduce:transition-opacity motion-reduce:data-[starting-style]:scale-100 motion-reduce:data-[ending-style]:scale-100"

const DropdownMenuContent = (props: {
  class?: string | undefined
  sideOffset?: number
  onCloseAutoFocus?: (event: Event) => void
  [key: string]: any
}) => {
  const layout = useContext(MenuLayoutContext)
  const others = omit(
    props,
    "class",
    "sideOffset",
    "onCloseAutoFocus",
    "finalFocus"
  )
  return (
    <MenuContent
      sideOffset={props.sideOffset ?? layout().gutter ?? 4}
      finalFocus={closeAutoFocusToFinalFocus(
        props.onCloseAutoFocus,
        props.finalFocus
      )}
      class={cn(contentClasses, props.class)}
      {...others}
    />
  )
}

const DropdownMenuItem = (props: {
  class?: string | undefined
  as?: ValidComponent
  render?: (props: Record<string, any>, state: any) => JSX.Element
  [key: string]: any
}) => {
  const others = omit(props, "class", "as", "render")
  return (
    <MenuItem
      class={cn(
        "relative flex cursor-default select-none items-center gap-1.5 rounded-sm px-2 py-1 text-xs outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        props.class
      )}
      render={asRender(props.as, props.render)}
      {...others}
    />
  )
}

const DropdownMenuSeparator = (props: {
  class?: string | undefined
  as?: ValidComponent
  render?: (props: Record<string, any>, state: any) => JSX.Element
  [key: string]: any
}) => {
  const others = omit(props, "class", "as", "render")
  return (
    <MenuSeparator
      class={cn("-mx-1 my-1 h-px bg-muted", props.class)}
      render={asRender(props.as, props.render)}
      {...others}
    />
  )
}

const indicatorMarkup = (path: JSX.Element) => (
  <span class="absolute left-2 flex size-3 items-center justify-center">
    <MenuItemIndicator>{path}</MenuItemIndicator>
  </span>
)

const checkMark = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3.5">
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

const radioMark = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3.5">
    <circle cx="12" cy="12" r="5" fill="currentColor" />
  </svg>
)

const DropdownMenuCheckboxItem = (props: {
  class?: string | undefined
  children?: JSX.Element
  as?: ValidComponent
  render?: (props: Record<string, any>, state: any) => JSX.Element
  [key: string]: any
}) => {
  const others = omit(props, "class", "children", "as", "render")
  return (
    <CheckboxItem
      class={cn(
        "relative flex cursor-default select-none items-center gap-1.5 rounded-sm py-1 pl-7 pr-2 text-xs outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        props.class
      )}
      render={asRender(props.as, props.render)}
      {...others}
    >
      {indicatorMarkup(checkMark())}
      {props.children}
    </CheckboxItem>
  )
}

const submenuChevron = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ml-auto size-3.5">
    <polyline points="9 18 15 12 9 6" />
  </svg>
)

const DropdownMenuSubTrigger = (props: {
  class?: string | undefined
  children?: JSX.Element
  as?: ValidComponent
  render?: (props: Record<string, any>, state: any) => JSX.Element
  [key: string]: any
}) => {
  const others = omit(props, "class", "children", "as", "render")
  return (
    <MenuSubTrigger
      class={cn(
        "relative flex cursor-default select-none items-center gap-1.5 rounded-sm px-2 py-1 text-xs outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[open]:bg-accent data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        props.class
      )}
      render={asRender(props.as, props.render)}
      {...others}
    >
      {props.children}
      {submenuChevron()}
    </MenuSubTrigger>
  )
}

const DropdownMenuSubContent = (props: {
  class?: string | undefined
  sideOffset?: number
  onCloseAutoFocus?: (event: Event) => void
  [key: string]: any
}) => {
  const layout = useContext(MenuLayoutContext)
  const others = omit(
    props,
    "class",
    "sideOffset",
    "onCloseAutoFocus",
    "finalFocus"
  )
  return (
    <MenuSubContent
      sideOffset={props.sideOffset ?? layout().gutter ?? 4}
      finalFocus={closeAutoFocusToFinalFocus(
        props.onCloseAutoFocus,
        props.finalFocus
      )}
      class={cn(contentClasses, props.class)}
      {...others}
    />
  )
}

/** Kobalte's radio group used `onChange`; the SDK calls it `onValueChange`. */
const DropdownMenuRadioGroup = (props: {
  onChange?: (value: string) => void
  [key: string]: any
}) => {
  const others = omit(props, "onChange", "onValueChange")
  return (
    <MenuRadioGroup
      {...others}
      onValueChange={props.onValueChange ?? props.onChange}
    />
  )
}

const DropdownMenuRadioItem = (props: {
  class?: string | undefined
  children?: JSX.Element
  as?: ValidComponent
  render?: (props: Record<string, any>, state: any) => JSX.Element
  [key: string]: any
}) => {
  const others = omit(props, "class", "children", "as", "render")
  return (
    <RadioItem
      class={cn(
        "relative flex cursor-default select-none items-center gap-1.5 rounded-sm py-1 pl-7 pr-2 text-xs outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        props.class
      )}
      render={asRender(props.as, props.render)}
      {...others}
    >
      {indicatorMarkup(radioMark())}
      {props.children}
    </RadioItem>
  )
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
}
