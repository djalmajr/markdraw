import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { Feedback, DragDropManager } from "@dnd-kit/dom";
import type { DragEndEvent } from "@dnd-kit/dom";
import {
  DragDropProvider,
  DragOverlay,
  useDragOperation,
  useDraggable,
  useDroppable,
} from "./index.ts";

// The manager promotes `initializing` → `dragging` on a microtask and the
// preact signal effects that feed the adapter run on their own queue; a
// handful of macrotask turns lets every queued step run.
async function flush(times = 6): Promise<void> {
  for (let index = 0; index < times; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(cleanup);

// happy-dom ships no Web Animations API, and `@dnd-kit/dom`'s Feedback plugin
// calls `document.getAnimations()` while it measures the drag source
// (`@dnd-kit/dom/utilities.js:1290` via `DOMRectangle`). The entity status only
// flips to "dragging" after that render (`@dnd-kit/dom/index.js:1089`), so the
// stub keeps the plugin's real render path running. Animations themselves are
// not exercised (happy-dom has no layout and no real pointer events).
beforeAll(() => {
  if (typeof document.getAnimations !== "function") {
    Object.defineProperty(document, "getAnimations", { configurable: true, value: () => [] });
  }
});

function Probe(props: { id: string }) {
  const draggable = useDraggable({ id: props.id });
  const droppable = useDroppable({ id: props.id });
  return (
    <div
      ref={(element: HTMLDivElement) => {
        draggable.ref(element);
        droppable.ref(element);
      }}
      data-testid={props.id}
      data-dragging={String(draggable.isDragging())}
      data-drop-target={String(droppable.isDropTarget())}
    />
  );
}

function OperationProbe() {
  const operation = useDragOperation();
  return (
    <div
      data-testid="operation"
      data-source={String(operation.source()?.id ?? "")}
      data-target={String(operation.target()?.id ?? "")}
      data-status={String(operation.status() ?? "")}
    />
  );
}

function ReactiveProbe(props: { label: string }) {
  const draggable = useDraggable({
    id: "reactive",
    get data() {
      return { label: props.label };
    },
    get disabled() {
      return props.label === "off";
    },
  });
  return <div ref={(element: HTMLDivElement) => draggable.ref(element)} data-testid="reactive" />;
}

function mount(manager: DragDropManager) {
  const result = render(() => (
    <DragDropProvider manager={manager}>
      <OperationProbe />
      <Probe id="a" />
      <Probe id="b" />
    </DragDropProvider>
  ));
  const attr = (testId: string, name: string) =>
    result.container.querySelector(`[data-testid="${testId}"]`)?.getAttribute(name);
  return { ...result, attr };
}

describe("registration", () => {
  it("registers draggables and droppables with the manager on mount", async () => {
    const manager = new DragDropManager();
    mount(manager);
    await flush();

    expect(manager.registry.draggables.has("a")).toBe(true);
    expect(manager.registry.draggables.has("b")).toBe(true);
    expect(manager.registry.droppables.has("a")).toBe(true);
    expect(manager.registry.droppables.has("b")).toBe(true);

    manager.destroy();
  });

  it("unregisters both entities on unmount", async () => {
    const manager = new DragDropManager();
    const { unmount } = mount(manager);
    await flush();
    expect(manager.registry.draggables.has("a")).toBe(true);

    unmount();
    await flush();

    expect(manager.registry.draggables.has("a")).toBe(false);
    expect(manager.registry.draggables.has("b")).toBe(false);
    expect(manager.registry.droppables.has("a")).toBe(false);
    expect(manager.registry.droppables.has("b")).toBe(false);

    manager.destroy();
  });

  it("re-applies the input accessors (data, disabled) on every change", async () => {
    const manager = new DragDropManager();
    const [label, setLabel] = createSignal("first");
    render(() => (
      <DragDropProvider manager={manager}>
        <ReactiveProbe label={label()} />
      </DragDropProvider>
    ));
    await flush();

    const entity = () => manager.registry.draggables.get("reactive");
    expect(entity()?.data).toEqual({ label: "first" });
    expect(entity()?.disabled).toBe(false);

    setLabel("off");
    await flush();

    expect(entity()?.data).toEqual({ label: "off" });
    expect(entity()?.disabled).toBe(true);

    manager.destroy();
  });

  it("renders and stays inert without a provider", async () => {
    const manager = new DragDropManager();
    const result = render(() => <Probe id="lonely" />);
    await flush();

    const probe = result.container.querySelector('[data-testid="lonely"]') as HTMLElement;
    expect(probe).not.toBeNull();
    expect(probe.getAttribute("data-dragging")).toBe("false");
    expect(probe.getAttribute("data-drop-target")).toBe("false");
    expect(manager.registry.draggables.has("lonely")).toBe(false);

    manager.destroy();
  });
});

describe("drag operation", () => {
  it("reflects start, target and end, and hands the manager to the caller", async () => {
    const manager = new DragDropManager();
    const ends: DragEndEvent[] = [];
    const result = render(() => (
      <DragDropProvider manager={manager} onDragEnd={(event) => ends.push(event)}>
        <OperationProbe />
        <Probe id="a" />
        <Probe id="b" />
      </DragDropProvider>
    ));
    const attr = (testId: string, name: string) =>
      result.container.querySelector(`[data-testid="${testId}"]`)?.getAttribute(name);
    await flush();

    expect(attr("operation", "data-status")).toBe("idle");
    expect(attr("a", "data-dragging")).toBe("false");
    expect(attr("a", "data-drop-target")).toBe("false");

    manager.actions.start({ source: "a", coordinates: { x: 0, y: 0 } });
    await flush();

    expect(attr("operation", "data-status")).toBe("dragging");
    expect(attr("operation", "data-source")).toBe("a");
    expect(attr("a", "data-dragging")).toBe("true");
    expect(attr("b", "data-dragging")).toBe("false");

    manager.actions.setDropTarget("b");
    await flush();

    expect(attr("operation", "data-target")).toBe("b");
    expect(attr("b", "data-drop-target")).toBe("true");
    expect(attr("a", "data-drop-target")).toBe("false");

    manager.actions.stop({});
    await flush();

    expect(ends).toHaveLength(1);
    expect(ends[0].canceled).toBe(false);
    expect(ends[0].operation.source?.id).toBe("a");
    expect(ends[0].operation.target?.id).toBe("b");

    expect(attr("operation", "data-status")).toBe("idle");
    expect(attr("operation", "data-source")).toBe("");
    expect(attr("operation", "data-target")).toBe("");
    expect(attr("a", "data-dragging")).toBe("false");
    expect(attr("b", "data-drop-target")).toBe("false");

    manager.destroy();
  });

  it("resets the state of a canceled operation and reports the cancel", async () => {
    const manager = new DragDropManager();
    const ends: DragEndEvent[] = [];
    const overs: unknown[] = [];
    const result = render(() => (
      <DragDropProvider
        manager={manager}
        onDragOver={(event) => overs.push(event)}
        onDragEnd={(event) => ends.push(event)}
      >
        <Probe id="a" />
        <Probe id="b" />
      </DragDropProvider>
    ));
    const attr = (testId: string, name: string) =>
      result.container.querySelector(`[data-testid="${testId}"]`)?.getAttribute(name);
    await flush();

    manager.actions.start({ source: "a", coordinates: { x: 0, y: 0 } });
    await flush();
    manager.actions.setDropTarget("b");
    await flush();
    expect(attr("b", "data-drop-target")).toBe("true");

    manager.actions.stop({ canceled: true });
    await flush();

    expect(overs).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0].canceled).toBe(true);
    expect(ends[0].operation.source?.id).toBe("a");
    expect(attr("a", "data-dragging")).toBe("false");
    expect(attr("b", "data-drop-target")).toBe("false");

    manager.destroy();
  });
});

describe("DragOverlay", () => {
  it("renders the overlay while dragging, hands it to the Feedback plugin and clears it", async () => {
    const manager = new DragDropManager();
    const result = render(() => (
      <DragDropProvider manager={manager}>
        <Probe id="a" />
        <DragOverlay dropAnimation={null}>{(source) => <span>{source.id}</span>}</DragOverlay>
      </DragDropProvider>
    ));
    const feedback = () =>
      manager.plugins.find((plugin): plugin is Feedback => plugin instanceof Feedback);
    const overlay = () => result.container.querySelector("[data-dnd-overlay]");
    await flush();

    expect(overlay()).toBeNull();
    expect(feedback()?.overlay).toBeUndefined();

    manager.actions.start({ source: "a", coordinates: { x: 0, y: 0 } });
    await flush();

    expect(overlay()).not.toBeNull();
    expect(overlay()?.textContent).toBe("a");
    expect(feedback()?.overlay).toBe(overlay());

    manager.actions.stop({});
    await flush();

    expect(overlay()).toBeNull();
    expect(feedback()?.overlay).toBeUndefined();

    manager.destroy();
  });
});
