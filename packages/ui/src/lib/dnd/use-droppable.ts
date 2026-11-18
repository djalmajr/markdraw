import { createEffect, type Accessor } from "solid-js";
import { Droppable } from "@dnd-kit/dom";
import type { DroppableInput } from "@dnd-kit/dom";
import type { Data } from "@dnd-kit/abstract";
import { useDragDropManager } from "./context.ts";
import { fromDnd } from "./from-dnd.ts";

/** Input of `useDroppable`; see `UseDraggableInput` for the same rules. */
export type UseDroppableInput<T extends Data = Data> = Omit<
  DroppableInput<T>,
  "register" | "effects"
>;

export interface DroppableHandle<T extends Data = Data> {
  /** The underlying `@dnd-kit/dom` entity (`@dnd-kit/dom/index.js:2243`). */
  readonly droppable: Droppable<T>;
  ref: (element: Element | undefined) => void;
  isDropTarget: Accessor<boolean>;
}

/**
 * Registers a droppable entity with the surrounding `<DragDropProvider>` and
 * exposes whether it is the current drop target.
 */
export function useDroppable<T extends Data = Data>(
  input: UseDroppableInput<T>,
): DroppableHandle<T> {
  const manager = useDragDropManager();
  const droppable = new Droppable<T>({ ...input, register: false }, manager ?? undefined);

  createEffect(
    () => ({
      id: input.id,
      data: input.data,
      disabled: input.disabled,
      accept: input.accept,
      type: input.type,
      collisionDetector: input.collisionDetector,
      collisionPriority: input.collisionPriority,
    }),
    (values) => {
      droppable.id = values.id;
      droppable.disabled = values.disabled ?? false;
      droppable.accept = values.accept;
      droppable.type = values.type;
      if (values.collisionDetector) droppable.collisionDetector = values.collisionDetector;
      if (values.collisionPriority !== undefined) {
        droppable.collisionPriority = values.collisionPriority;
      }
      if (values.data) droppable.data = values.data;
    },
  );

  createEffect(
    () => undefined,
    () => {
      const unregister = droppable.register();
      return typeof unregister === "function" ? unregister : undefined;
    },
  );

  return {
    get droppable() {
      return droppable;
    },
    ref: (element) => {
      // `Droppable`'s element setter refreshes its shape and re-runs the
      // entity's shape observers (`@dnd-kit/dom/index.js:2243-2320`).
      droppable.element = element;
    },
    isDropTarget: fromDnd(() => droppable.isDropTarget),
  };
}
