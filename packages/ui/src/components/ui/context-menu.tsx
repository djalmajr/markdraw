import { createContext, omit, useContext } from "solid-js";
import { Dynamic, type JSX, type ValidComponent } from "@solidjs/web";

import {
  Menu,
  MenuContextTrigger,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuRadioGroup,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
} from "@ui-sdk/solid/menu";

import { cn } from "@markdraw/core/utils.ts"

const MenuLayoutContext = createContext<() => { gutter?: number }>(() => ({}))

const ContextMenuGroup = MenuGroup
const ContextMenuSub = MenuSub

const asRender = (
  as: ValidComponent | undefined,
  render: ((props: Record<string, any>, state: any) => JSX.Element) | undefined
) =>
  render ??
  (as
    ? (props: Record<string, any>) => <Dynamic component={as} {...props} />
    : undefined)

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

/** Kobalte's context-menu root took `gutter`; the SDK puts the gap on content. */
const ContextMenu = (props: { gutter?: number; [key: string]: any }) => (
  <MenuLayoutContext value={() => ({ gutter: props.gutter })}>
    <Menu {...omit(props, "gutter")} />
  </MenuLayoutContext>
)

const ContextMenuTrigger = (props: {
  as?: ValidComponent
  render?: (props: Record<string, any>, state: any) => JSX.Element
  [key: string]: any
}) => {
  const others = omit(props, "as", "render")
  return <MenuContextTrigger render={asRender(props.as, props.render)} {...others} />
}

const contentClasses =
  "z-50 min-w-32 origin-[var(--transform-origin)] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-none outline-none transition-[opacity,scale] duration-150 ease-out data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95 motion-reduce:transition-opacity motion-reduce:data-[starting-style]:scale-100 motion-reduce:data-[ending-style]:scale-100"

const ContextMenuContent = (props: {
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

const ContextMenuItem = (props: {
  class?: string | undefined
  as?: ValidComponent
  render?: (props: Record<string, any>, state: any) => JSX.Element
  [key: string]: any
}) => {
  const others = omit(props, "class", "as", "render")
  return (
    <MenuItem
      class={cn(
        "relative flex cursor-default select-none items-center rounded-sm px-2 py-1 text-xs outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        props.class
      )}
      render={asRender(props.as, props.render)}
      {...others}
    />
  )
}

const ContextMenuShortcut = (props: {
  class?: string | undefined
  [key: string]: any
}) => {
  const others = omit(props, "class")
  return <kbd class={cn("menu-shortcut-kbd ml-auto", props.class)} {...others} />
}

const ContextMenuSeparator = (props: {
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

const submenuChevron = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="ml-auto size-4"
  >
    <path d="M9 6l6 6l-6 6" />
  </svg>
)

const ContextMenuSubTrigger = (props: {
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
        "flex cursor-default select-none items-center rounded-sm px-2 py-1 text-xs outline-none focus:bg-accent data-[open]:bg-accent data-[highlighted]:bg-accent",
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

const ContextMenuSubContent = (props: {
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

/** Keep Kobalte's `onChange` name working for radio groups. */
const ContextMenuRadioGroup = (props: {
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

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuGroup,
  ContextMenuRadioGroup,
}
