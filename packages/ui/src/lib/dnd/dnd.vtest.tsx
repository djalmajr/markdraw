import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { useDragDropManager } from "./context.ts";

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

function feedbackOf(manager: DragDropManager): Feedback | undefined {
  return manager.plugins.find((plugin): plugin is Feedback => plugin instanceof Feedback);
}

function ReactiveDraggableId(props: { id: string }) {
  const draggable = useDraggable({
    get id() {
      return props.id;
    },
  });
  return <div ref={(element: HTMLDivElement) => draggable.ref(element)} />;
}

function ReactiveDroppable(props: { id: string; label: string; disabled: boolean }) {
  const droppable = useDroppable({
    get id() {
      return props.id;
    },
    get data() {
      return { label: props.label };
    },
    get disabled() {
      return props.disabled;
    },
  });
  return <div ref={(element: HTMLDivElement) => droppable.ref(element)} />;
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
  // Without this test: dropping the callback's manager argument would leave
  // callers with `undefined` where the owning manager is expected.
  it("reflects start, target and end, and hands the manager to the caller", async () => {
    const manager = new DragDropManager();
    const ends: Array<[DragEndEvent, DragDropManager]> = [];
    const result = render(() => (
      <DragDropProvider
        manager={manager}
        onDragEnd={(event, endedManager) => ends.push([event, endedManager])}
      >
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
    expect(ends[0][0].canceled).toBe(false);
    expect(ends[0][0].operation.source?.id).toBe("a");
    expect(ends[0][0].operation.target?.id).toBe("b");
    expect(ends[0][1]).toBe(manager);

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

describe("reactive identity and data", () => {
  // Without this test: a changed draggable id would leave a stale registration
  // and later drags would still be started under the old id.
  it("re-registers a draggable when its id changes", async () => {
    const manager = new DragDropManager();
    const [id, setId] = createSignal("a");
    try {
      render(() => (
        <DragDropProvider manager={manager}>
          <ReactiveDraggableId id={id()} />
        </DragDropProvider>
      ));
      await flush();
      expect(manager.registry.draggables.has("a")).toBe(true);

      setId("b");
      await flush();

      expect(manager.registry.draggables.has("a")).toBe(false);
      expect(manager.registry.draggables.has("b")).toBe(true);
    } finally {
      manager.destroy();
    }
  });

  // Without this test: a droppable whose data or disabled flag changes would
  // keep its old values, so collision filtering would use stale information.
  it("re-applies a droppable's data and disabled flags", async () => {
    const manager = new DragDropManager();
    const [label, setLabel] = createSignal("first");
    const [disabled, setDisabled] = createSignal(false);
    try {
      render(() => (
        <DragDropProvider manager={manager}>
          <ReactiveDroppable id="target" label={label()} disabled={disabled()} />
        </DragDropProvider>
      ));
      await flush();

      const droppable = () => manager.registry.droppables.get("target");
      expect(droppable()?.data).toEqual({ label: "first" });
      expect(droppable()?.disabled).toBe(false);

      setLabel("second");
      setDisabled(true);
      await flush();

      expect(droppable()?.data).toEqual({ label: "second" });
      expect(droppable()?.disabled).toBe(true);
    } finally {
      manager.destroy();
    }
  });
});

describe("provider ownership", () => {
  // Without this test: a provider that ignored the supplied manager (or
  // destroyed it on unmount) would silently break every externally driven
  // integration, including the tests that start operations from the manager.
  it("uses the supplied manager and leaves its lifecycle to the caller", async () => {
    const manager = new DragDropManager();
    let seen: DragDropManager | null = null;
    function Capture() {
      seen = useDragDropManager();
      return <ReactiveDraggableId id="a" />;
    }
    const destroy = vi.spyOn(manager, "destroy");
    try {
      const result = render(() => (
        <DragDropProvider manager={manager}>
          <Capture />
        </DragDropProvider>
      ));
      await flush();

      expect(seen).toBe(manager);
      expect(manager.registry.draggables.has("a")).toBe(true);

      result.unmount();
      expect(destroy).not.toHaveBeenCalled();
      expect(manager.registry.draggables.has("a")).toBe(false);
    } finally {
      destroy.mockRestore();
      manager.destroy();
    }
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

  // Without this test: a disabled overlay could keep the Feedback plugin
  // pointing at the removed node, which would animate the wrong element.
  it("clears the plugin pointer when disabled during a drag", async () => {
    const manager = new DragDropManager();
    const [disabled, setDisabled] = createSignal(false);
    const feedback = () => feedbackOf(manager);
    const result = render(() => (
      <DragDropProvider manager={manager}>
        <Probe id="a" />
        <DragOverlay disabled={disabled()} dropAnimation={null}>
          overlay
        </DragOverlay>
      </DragDropProvider>
    ));
    const overlay = () => result.container.querySelector("[data-dnd-overlay]");
    try {
      await flush();
      manager.actions.start({ source: "a", coordinates: { x: 0, y: 0 } });
      await flush();

      expect(overlay()?.isConnected).toBe(true);
      expect(feedback()?.overlay).toBe(overlay());

      setDisabled(true);
      await flush();

      expect(result.container.querySelector("[data-dnd-overlay]")).toBeNull();
      expect(feedback()?.overlay).toBeUndefined();
    } finally {
      if (manager.dragOperation.status.current !== "idle") manager.actions.stop({});
      result.unmount();
      manager.destroy();
    }
  });

  // Without this test: the first overlay could stay attached to Feedback and
  // a second drag would animate the stale node instead of its fresh overlay.
  it("hands a fresh overlay to the plugin on each of two drags", async () => {
    const manager = new DragDropManager();
    const feedback = () => feedbackOf(manager);
    const result = render(() => (
      <DragDropProvider manager={manager}>
        <Probe id="a" />
        <DragOverlay dropAnimation={null}>overlay</DragOverlay>
      </DragDropProvider>
    ));
    let previous: Element | undefined;
    try {
      await flush();
      for (let index = 0; index < 2; index++) {
        manager.actions.start({ source: "a", coordinates: { x: 0, y: 0 } });
        await flush();

        const current = feedback()?.overlay;
        expect(current).toBeDefined();
        expect(current?.isConnected).toBe(true);
        expect(current).not.toBe(previous);
        previous = current;

        manager.actions.stop({});
        await flush();
        expect(feedback()?.overlay).toBeUndefined();
      }
    } finally {
      if (manager.dragOperation.status.current !== "idle") manager.actions.stop({});
      result.unmount();
      manager.destroy();
    }
  });

  // Without this test: clearing Feedback as soon as `stop()` is called would
  // detach the overlay mid-animation and leave the item without drag feedback.
  it("keeps the overlay connected while the drop animation is pending", async () => {
    const manager = new DragDropManager();
    let finish!: () => void;
    let calls = 0;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const result = render(() => (
      <DragDropProvider manager={manager}>
        <Probe id="a" />
        <DragOverlay
          dropAnimation={() => {
            calls++;
            return pending;
          }}
        >
          overlay
        </DragOverlay>
      </DragDropProvider>
    ));
    try {
      await flush();
      manager.actions.start({ source: "a", coordinates: { x: 0, y: 0 } });
      await flush();
      manager.actions.stop({});
      await flush();

      expect(calls).toBe(1);
      expect(manager.dragOperation.status.current).toBe("dropped");
      expect(result.container.querySelector("[data-dnd-overlay]")?.isConnected).toBe(true);

      finish();
      await flush();
      expect(manager.dragOperation.status.current).toBe("idle");
      expect(result.container.querySelector("[data-dnd-overlay]")).toBeNull();
    } finally {
      finish();
      if (manager.dragOperation.status.current !== "idle") manager.actions.stop({});
      result.unmount();
      manager.destroy();
    }
  });
});
