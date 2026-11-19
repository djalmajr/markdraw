import type { JSX } from "@solidjs/web";

import { Separator as SeparatorPrimitive } from "@ui-sdk/solid/separator";

import { cn } from "@markdraw/core/utils.ts";

type SeparatorProps = {
  orientation?: "horizontal" | "vertical";
  decorative?: boolean;
  class?: string | undefined;
  children?: JSX.Element;
};

/** The ui-sdk part already sets `data-orientation` and the separator role
 *  (`role="none"` when `decorative`); only the Markdraw styles are added. */
const Separator = (props: SeparatorProps) => {
  const orientation = () => props.orientation ?? "horizontal";
  return (
    <SeparatorPrimitive
      orientation={orientation()}
      decorative={props.decorative}
      class={cn(
        "shrink-0 bg-border",
        orientation() === "vertical" ? "h-full w-px" : "h-px w-full",
        props.class
      )}
    >
      {props.children}
    </SeparatorPrimitive>
  );
};

export { Separator };
