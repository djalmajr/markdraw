import type { ComponentProps, JSX } from "@solidjs/web"
import { createContext, omit, useContext } from "solid-js"

import {
  Tabs as TabsPrimitive,
  TabsIndicator as TabsIndicatorPrimitive,
  TabsList as TabsListPrimitive,
  TabsPanel as TabsContentPrimitive,
  TabsTab as TabsTriggerPrimitive,
} from "@ui-sdk/solid/tabs"

import { cn } from "@markdraw/core/utils.ts"

/** The SDK has no root-level `disabled`, so the wrapper carries it to each tab. */
const TabsDisabledContext = createContext<() => boolean>(() => false)

/** Kobalte's root used `onChange(value)`, `activationMode` and `disabled`;
 *  ui-sdk uses `onValueChange(value, details)`, `activation` and per-tab `disabled`.
 *  Keep the old callbacks/props (and `value: string`) so callers don't change. */
type TabsProps = Omit<ComponentProps<typeof TabsPrimitive>, "value" | "onValueChange"> & {
  value?: string
  onChange?: (value: string) => void
  activationMode?: "automatic" | "manual"
  disabled?: boolean
  children?: JSX.Element
  class?: string
}

const Tabs = (props: TabsProps) => {
  const others = omit(props, "onChange", "activationMode", "disabled")
  const rootDisabled = () => props.disabled === true
  return (
    <TabsDisabledContext value={rootDisabled}>
      <TabsPrimitive
        {...others}
        activation={props.activationMode ?? props.activation}
        onValueChange={(value) => {
          if (!rootDisabled() && value !== null) props.onChange?.(value)
        }}
      />
    </TabsDisabledContext>
  )
}

type TabsListProps = ComponentProps<typeof TabsListPrimitive> & {
  class?: string
}

const TabsList = (props: TabsListProps) => {
  const others = omit(props, "class")
  return (
    <TabsListPrimitive
      class={cn(
        "relative inline-flex h-7 items-center justify-center rounded-md bg-[hsl(var(--border))] p-0.5 text-muted-foreground",
        props.class
      )}
      {...others}
    />
  )
}

type TabsTriggerProps = ComponentProps<typeof TabsTriggerPrimitive> & {
  class?: string
  children?: JSX.Element
}

const TabsTrigger = (props: TabsTriggerProps) => {
  const others = omit(props, "class", "children", "disabled")
  const rootDisabled = useContext(TabsDisabledContext)
  return (
    <TabsTriggerPrimitive
      class={cn(
        // Note: we intentionally drop `disabled:pointer-events-none` so the
        // browser still shows the `not-allowed` cursor on hover. A native
        // button `disabled` blocks the click and ui-sdk's `data-disabled`
        // prevents the value change, so disabled triggers stay inert.
        "inline-flex h-6 items-center justify-center whitespace-nowrap rounded-sm px-2 py-1 text-xs font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[selected]:bg-background data-[selected]:text-foreground data-[selected]:shadow-none",
        props.class
      )}
      {...others}
      disabled={props.disabled === true || rootDisabled()}
    >
      {props.children}
    </TabsTriggerPrimitive>
  )
}

type TabsContentProps = ComponentProps<typeof TabsContentPrimitive> & {
  /** Kobalte's name for the SDK's `keepMounted`. */
  forceMount?: boolean
  class?: string
  children?: JSX.Element
}

const TabsContent = (props: TabsContentProps) => {
  const others = omit(props, "class", "children", "forceMount")
  return (
    <TabsContentPrimitive
      class={cn(
        "mt-1.5 ring-offset-background transition-opacity duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 motion-reduce:transition-none",
        props.class
      )}
      {...others}
      keepMounted={props.forceMount || props.keepMounted}
    >
      {props.children}
    </TabsContentPrimitive>
  )
}

type TabsIndicatorProps = ComponentProps<typeof TabsIndicatorPrimitive> & {
  class?: string
}

/** ui-sdk measures the selected tab into `--active-tab-*` instead of moving a
 *  Kobalte indicator itself, so the underline reads those variables. */
const TabsIndicator = (props: TabsIndicatorProps) => {
  const others = omit(props, "class")
  return (
    <TabsIndicatorPrimitive
      class={cn(
        "absolute transition-all duration-150 data-[orientation=horizontal]:-bottom-px data-[orientation=vertical]:-right-px data-[orientation=horizontal]:left-[var(--active-tab-left)] data-[orientation=horizontal]:h-[2px] data-[orientation=horizontal]:w-[var(--active-tab-width)] data-[orientation=vertical]:top-[var(--active-tab-top)] data-[orientation=vertical]:h-[var(--active-tab-height)] data-[orientation=vertical]:w-[2px] data-[activation-direction=none]:transition-none motion-reduce:transition-none",
        props.class
      )}
      {...others}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, TabsIndicator }
