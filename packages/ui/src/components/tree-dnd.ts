import { createSignal } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";

// Shared file-tree drag & drop helpers, in their own module so file-tree.tsx
// and file-tree-item.tsx can both use them without an import cycle (they
// already depend on each other for the component/types).

/** Entries are draggable/droppable through the same @dnd-kit provider as the
 *  workspace roots. Their drag id namespaces by root + path; the entry's
 *  details ride along in the draggable/droppable `data`. */
const ITEM_DND_PREFIX = "item::";

export function toItemDndId(rootId: string, path: string): string {
  return `${ITEM_DND_PREFIX}${rootId}::${path}`;
}

export function isItemDndId(dndId: unknown): boolean {
  return typeof dndId === "string" && dndId.startsWith(ITEM_DND_PREFIX);
}

export interface ItemDndData {
  rootId: string;
  path: string;
  name: string;
  kind: FSEntry["kind"];
}

/** While dragging an entry, the resolved destination folder (a folder hovered
 *  directly, or the parent of a hovered sibling file). `path === ""` means the
 *  workspace root of `rootId`. That folder's whole subtree shows the dashed
 *  drop affordance. Driven by FileTree's onDragOver; cleared on drag end. */
export const [siblingDropParent, setSiblingDropParent] = createSignal<
  { path: string; rootId: string } | null
>(null);
