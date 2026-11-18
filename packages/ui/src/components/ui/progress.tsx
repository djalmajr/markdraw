import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";

import {
  Progress as ProgressPrimitive,
  ProgressIndicator,
  ProgressTrack,
} from "@ui-sdk/solid/progress";

type ProgressProps = {
  value?: number;
  /** Kobalte name for the SDK's `min`. */
  minValue?: number;
  /** Kobalte name for the SDK's `max`. */
  maxValue?: number;
  /** With no total, the SDK's indeterminate value is `null`. */
  indeterminate?: boolean;
  children?: JSX.Element;
  class?: string;
  "aria-label"?: string;
  "data-testid"?: string;
};

export function Progress(props: ProgressProps) {
  const others = omit(props, "value", "minValue", "maxValue", "indeterminate", "children");
  return (
    <ProgressPrimitive
      value={props.indeterminate ? null : props.value}
      min={props.minValue}
      max={props.maxValue}
      {...others}
    >
      {props.children}
      <ProgressTrack class="relative h-1.5 w-full overflow-hidden rounded-[2px] bg-secondary">
        {/* progress-fill: indeterminate gets a looping sweep via CSS — with no
            fill-width var set, the SDK indicator renders FULL, which read as a
            bar jumping to 100% and back during the updater's content-length-less
            redirect hop. */}
        <ProgressIndicator class="progress-fill h-full flex-1 rounded-[2px] bg-primary transition-all" />
      </ProgressTrack>
    </ProgressPrimitive>
  );
}
