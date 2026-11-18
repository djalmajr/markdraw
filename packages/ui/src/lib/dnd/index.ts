/**
 * Drag and drop for the Solid 2 app.
 *
 * A small adapter over `@dnd-kit/dom` (framework-free) that replaces the
 * `solid` binding of `@dnd-kit` 0.4.0, which cannot load on Solid 2 (it
 * imports `solid-js/web`'s `Dynamic`/`memo` and the removed `on`/`batch`
 * helpers). The five exports below keep the names and shapes the app
 * already used.
 */
export { DragDropProvider, type DragDropProviderProps } from "./drag-drop-provider.tsx";
export { DragOverlay, type DragOverlayProps } from "./drag-overlay.tsx";
export { useDraggable, type DraggableHandle, type UseDraggableInput } from "./use-draggable.ts";
export { useDroppable, type DroppableHandle, type UseDroppableInput } from "./use-droppable.ts";
export { useDragOperation, type DragOperationHandle } from "./use-drag-operation.ts";
