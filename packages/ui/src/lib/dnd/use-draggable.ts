import { createEffect, untrack, type Accessor } from "solid-js";
import { Draggable } from "@dnd-kit/dom";
import type { DraggableInput } from "@dnd-kit/dom";
import type { Data } from "@dnd-kit/abstract";
import { useDragDropManager } from "./context.ts";
import { fromDnd } from "./from-dnd.ts";

/**
 * Input of `useDraggable`. Same shape as `@dnd-kit/dom`'s `DraggableInput`
 * minus the two knobs this adapter owns (`register` is driven by the
 * component lifecycle, `effects` is not used by the app).
 *
 * Every call site passes live values as accessors (`get disabled() {...}`,
 * `get data() {...}`), which the reactive re-application below picks up.
 */
export type UseDraggableInput<T extends Data = Data> = Omit<
  DraggableInput<T>,
  "register" | "effects"
>;

export interface DraggableHandle<T extends Data = Data> {
  /** The underlying `@dnd-kit/dom` entity (`@dnd-kit/dom/index.js:2194`). */
  readonly draggable: Draggable<T>;
  /** Element ref: binds the entity's element (`Draggable.element`). */
  ref: (element: Element | undefined) => void;
  /** Optional handle ref: drags only start from this element. */
  handleRef: (element: Element | undefined) => void;
  isDragging: Accessor<boolean>;
  isDropping: Accessor<boolean>;
  isDragSource: Accessor<boolean>;
}

/**
 * Registers a draggable entity with the surrounding `<DragDropProvider>` and
 * exposes its drag state.
 *
 * Outside a provider the entity is created without a manager, so it never
 * registers and every accessor reads `false` — the same degradation the
 * previous `solid` binding hook had.
 */
export function useDraggable<T extends Data = Data>(
  input: UseDraggableInput<T>,
): DraggableHandle<T> {
  const manager = useDragDropManager();
  // The spread reads the input's accessors once, as the initial snapshot; it
  // runs untracked so callers can pass plain getters. The effect below tracks
  // the same accessors and re-applies the live values whenever they change.
  const draggable = untrack(
    () => new Draggable<T>({ ...input, register: false }, manager ?? undefined),
  );

  createEffect(
    () => ({
      id: input.id,
      data: input.data,
      disabled: input.disabled,
      alignment: input.alignment,
      plugins: input.plugins,
      modifiers: input.modifiers,
      sensors: input.sensors,
    }),
    (values) => {
      draggable.id = values.id;
      draggable.disabled = values.disabled ?? false;
      draggable.alignment = values.alignment;
      draggable.plugins = values.plugins;
      draggable.modifiers = values.modifiers;
      draggable.sensors = values.sensors;
      if (values.data) draggable.data = values.data;
    },
  );

  // Registration is lifecycle-bound: `Entity.register()` runs the entity's
  // effects (sensor binding for a draggable, shape observers for a droppable)
  // and returns the cleanup that tears them down again
  // (`@dnd-kit/abstract/index.js:517`).
  createEffect(
    () => undefined,
    () => {
      const unregister = draggable.register();
      return typeof unregister === "function" ? unregister : undefined;
    },
  );

  return {
    get draggable() {
      return draggable;
    },
    ref: (element) => {
      draggable.element = element;
    },
    handleRef: (element) => {
      draggable.handle = element;
    },
    isDragging: fromDnd(() => draggable.isDragging),
    isDropping: fromDnd(() => draggable.isDropping),
    isDragSource: fromDnd(() => draggable.isDragSource),
  };
}
