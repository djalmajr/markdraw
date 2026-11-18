import { createEffect, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Feedback } from "@dnd-kit/dom";
import type { Draggable, DropAnimation } from "@dnd-kit/dom";
import { useDragDropManager } from "./context.ts";
import { useDragOperation } from "./use-drag-operation.ts";

export interface DragOverlayProps {
  /** Rendered while a drag is in flight; the function form receives the source. */
  children?: JSX.Element | ((source: Draggable) => JSX.Element);
  /**
   * `null` disables the drop animation (`Feedback.dropAnimation`,
   * `@dnd-kit/dom/index.js:1194`), which is what the tree overlay wants;
   * `undefined` keeps the plugin default.
   */
  dropAnimation?: DropAnimation | null;
  /** Skip rendering the overlay (and the feedback it drives). */
  disabled?: boolean | ((source: Draggable | null) => boolean);
  class?: string;
  style?: JSX.CSSProperties | string;
}

/**
 * The element the drag feedback follows. `@dnd-kit/dom`'s `Feedback` plugin
 * (part of `defaultPreset`, `@dnd-kit/dom/index.js:2173-2177`) renders the
 * drag source in place of this overlay while `Feedback.overlay` is set
 * (`@dnd-kit/dom/index.js:867-1230`), so the element is handed over as soon
 * as it exists and cleared when the source goes away.
 *
 * The child function is rendered once per drag (the source entity keeps its
 * identity for the whole operation), matching the previous adapter.
 */
export function DragOverlay(props: DragOverlayProps): JSX.Element {
  const manager = useDragDropManager();
  const operation = useDragOperation();

  const feedback = (): Feedback | undefined =>
    manager?.plugins.find((plugin): plugin is Feedback => plugin instanceof Feedback);

  const isDisabled = (source: Draggable | null | undefined): boolean =>
    typeof props.disabled === "function"
      ? props.disabled(source ?? null)
      : (props.disabled ?? false);

  // The element is handed over from the `ref` below, which runs without an
  // owner (nothing there can register its own cleanup), and Solid never calls a
  // ref again with `undefined` on dispose. So the plugin pointer is cleared
  // here whenever `<Show>` has removed the element: the operation lost its
  // source, or the overlay became disabled mid-drag. Tracking both values in
  // the compute keeps the cleanup in step with the `<Show>` condition.
  createEffect(
    () => {
      const source = operation.source();
      return { source, visible: source ? !isDisabled(source) : false };
    },
    ({ visible }) => {
      if (visible) return;
      const plugin = feedback();
      if (plugin) plugin.overlay = undefined;
    },
  );

  createEffect(
    () => props.dropAnimation,
    (dropAnimation) => {
      const plugin = feedback();
      if (plugin) plugin.dropAnimation = dropAnimation;
    },
  );

  onCleanup(() => {
    const plugin = feedback();
    if (!plugin) return;
    plugin.overlay = undefined;
    plugin.dropAnimation = undefined;
  });

  return (
    <Show when={isDisabled(operation.source()) ? null : operation.source()}>
      {(source) => (
        <div
          class={props.class}
          style={props.style}
          data-dnd-overlay=""
          ref={(element: HTMLDivElement) => {
            const plugin = feedback();
            if (plugin) plugin.overlay = element;
          }}
        >
          {typeof props.children === "function" ? props.children(source()) : props.children}
        </div>
      )}
    </Show>
  );
}
