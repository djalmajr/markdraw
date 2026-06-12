import type { JSX, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import * as ProgressPrimitive from "@kobalte/core/progress";

type ProgressRootProps<T extends ValidComponent = "div"> =
  ProgressPrimitive.ProgressRootProps<T> & { children?: JSX.Element };

export function Progress<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, ProgressRootProps<T>>,
) {
  const [local, others] = splitProps(props as ProgressRootProps, ["children"]);
  return (
    <ProgressPrimitive.Root {...others}>
      {local.children}
      <ProgressPrimitive.Track class="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
        {/* progress-fill: indeterminate gets a looping sweep via CSS — with no
            fill-width var set, the bare Kobalte fill renders FULL, which read
            as a bar jumping to 100% and back during the updater's
            content-length-less redirect hop. */}
        <ProgressPrimitive.Fill class="progress-fill h-full w-[var(--kb-progress-fill-width)] flex-1 bg-primary transition-all" />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}
