import { onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";
import { DragDropManager } from "@dnd-kit/dom";
import type {
  BeforeDragStartEvent,
  CollisionEvent,
  DragDropManagerInput,
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragStartEvent,
} from "@dnd-kit/dom";
import { DragDropContext } from "./context.ts";

export interface DragDropProviderProps {
  children?: JSX.Element;
  /**
   * Use an existing manager instead of creating one. The provider then leaves
   * its lifecycle to the caller (tests drive operations through it).
   */
  manager?: DragDropManager;
  /**
   * Manager configuration, read once when the manager is created
   * (`@dnd-kit/dom/index.js:2178-2191` resolves it against `defaultPreset`).
   * Changing these props afterwards has no effect; pass a `manager` to
   * reconfigure.
   */
  plugins?: DragDropManagerInput["plugins"];
  sensors?: DragDropManagerInput["sensors"];
  modifiers?: DragDropManagerInput["modifiers"];
  onBeforeDragStart?: (event: BeforeDragStartEvent, manager: DragDropManager) => void;
  onDragStart?: (event: DragStartEvent, manager: DragDropManager) => void;
  onDragMove?: (event: DragMoveEvent, manager: DragDropManager) => void;
  onDragOver?: (event: DragOverEvent, manager: DragDropManager) => void;
  onDragEnd?: (event: DragEndEvent, manager: DragDropManager) => void;
  onCollision?: (event: CollisionEvent, manager: DragDropManager) => void;
}

/**
 * Owns the `@dnd-kit/dom` manager for a subtree and forwards its monitor
 * events (`beforedragstart`, `dragstart`, `dragmove`, `dragover`, `dragend`,
 * `collision` — `@dnd-kit/abstract/index.js:788`).
 *
 * Handlers are read at dispatch time (props are getters in Solid), so a prop
 * that is swapped later still receives events.
 */
export function DragDropProvider(props: DragDropProviderProps): JSX.Element {
  const manager =
    props.manager ??
    new DragDropManager({
      plugins: props.plugins,
      sensors: props.sensors,
      modifiers: props.modifiers,
    });

  const unsubscribes = [
    manager.monitor.addEventListener("beforedragstart", (event) =>
      props.onBeforeDragStart?.(event, manager),
    ),
    manager.monitor.addEventListener("dragstart", (event) =>
      props.onDragStart?.(event, manager),
    ),
    manager.monitor.addEventListener("dragmove", (event) =>
      props.onDragMove?.(event, manager),
    ),
    manager.monitor.addEventListener("dragover", (event) =>
      props.onDragOver?.(event, manager),
    ),
    manager.monitor.addEventListener("dragend", (event) =>
      props.onDragEnd?.(event, manager),
    ),
    manager.monitor.addEventListener("collision", (event) =>
      props.onCollision?.(event, manager),
    ),
  ];

  onCleanup(() => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    // A manager handed in by the caller belongs to the caller.
    if (!props.manager) manager.destroy();
  });

  return <DragDropContext value={manager}>{props.children}</DragDropContext>;
}
