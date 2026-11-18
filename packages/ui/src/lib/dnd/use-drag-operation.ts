import type { Accessor } from "solid-js";
import type { Draggable, Droppable } from "@dnd-kit/dom";
import type { DragOperationStatus } from "@dnd-kit/abstract";
import { useDragDropManager } from "./context.ts";
import { fromDnd } from "./from-dnd.ts";

export interface DragOperationHandle {
  /** The entity being dragged, or `null` when no operation is in flight. */
  source: Accessor<Draggable | null | undefined>;
  /** The entity currently under the pointer, or `null`. */
  target: Accessor<Droppable | null | undefined>;
  /** `"idle" | "initialization-pending" | "initializing" | "dragging" | "dropped"` */
  status: Accessor<DragOperationStatus["current"] | undefined>;
}

/**
 * Reads the live drag operation of the surrounding provider. Outside one it
 * yields `undefined` for source/target, matching the previous hook, so
 * previews derived from it simply stay off.
 */
export function useDragOperation(): DragOperationHandle {
  const manager = useDragDropManager();
  const operation = () => manager?.dragOperation;
  return {
    source: fromDnd(() => operation()?.source),
    target: fromDnd(() => operation()?.target),
    status: fromDnd(() => operation()?.status.current),
  };
}
