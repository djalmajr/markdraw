import { createContext, useContext } from "solid-js";
import type { DragDropManager } from "@dnd-kit/dom";

/**
 * The `@dnd-kit/dom` manager shared by `<DragDropProvider>` and the hooks.
 *
 * Optional (`null` default) on purpose: some call sites render the hooks
 * outside a provider (`TabBar` in isolation, the right-panel strip), and the
 * previous `solid` binding hooks degraded to "no drag operation" there
 * instead of throwing. A default-less context would turn every such render
 * into a `ContextNotFoundError`.
 */
export const DragDropContext = createContext<DragDropManager | null>(null);

export function useDragDropManager(): DragDropManager | null {
  return useContext(DragDropContext);
}
