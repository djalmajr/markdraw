import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import type { BeforeDragStartEvent } from "@dnd-kit/dom";
import { createPaneStore } from "../composables/create-pane-store.ts";
import { DragDropProvider } from "../lib/dnd/index.ts";
import { TabBar } from "./tab-bar.tsx";

const animations = Object.getOwnPropertyDescriptor(document, "getAnimations");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  Object.defineProperty(document, "getAnimations", { configurable: true, value: () => [] });
});
afterEach(() => {
  try {
    cleanup();
    vi.runOnlyPendingTimers();
  } finally {
    vi.useRealTimers();
    if (animations) Object.defineProperty(document, "getAnimations", animations);
    else Reflect.deleteProperty(document, "getAnimations");
  }
});

function setupPaneWithTabs(filenames: string[]) {
  const pane = createPaneStore("test-pane");
  for (const name of filenames) {
    pane.tabs.openTab({ kind: "file", name, path: name }, "root");
  }
  return pane;
}

describe("TabBar — activation and drag", () => {
  it.each(["Enter", "Space"])("activates a focused tab with %s without starting a drag", (code) => {
    const pane = setupPaneWithTabs(["a.md", "b.md"]);
    flush();
    expect(pane.tabs.activeTabId()).toBe("root::b.md");
    const activate = vi.fn(pane.tabs.activateTab);
    const beforeDrag = vi.fn((event: BeforeDragStartEvent) => event.preventDefault());
    const { getByRole } = render(() => (
      <DragDropProvider onBeforeDragStart={beforeDrag}>
        <TabBar paneIndex={0} tabStore={pane.tabs} onActivateTab={activate} onCloseTab={() => {}} />
      </DragDropProvider>
    ));
    const tab = getByRole("button", { name: "a.md" });
    expect(tab.tabIndex).toBe(0);
    tab.focus();
    expect(document.activeElement).toBe(tab);
    expect(fireEvent.keyDown(tab, { key: code === "Space" ? " " : code, code })).toBe(false);
    flush();
    expect(beforeDrag).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledExactlyOnceWith("root::a.md");
    expect(pane.tabs.activeTabId()).toBe("root::a.md");
  });

  it.each([0, 3])("activates the tab after holding the mouse for 400 ms with %i px of movement", async (distance) => {
    const pane = setupPaneWithTabs(["a.md", "b.md"]);
    flush();
    const beforeDrag = vi.fn((event: BeforeDragStartEvent) => event.preventDefault());
    const { getByRole } = render(() => (
      <DragDropProvider onBeforeDragStart={beforeDrag}>
        <TabBar paneIndex={0} tabStore={pane.tabs} onActivateTab={pane.tabs.activateTab} onCloseTab={() => {}} />
      </DragDropProvider>
    ));
    const tab = getByRole("button", { name: "a.md" });
    const pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, clientY: 10 };
    fireEvent.pointerDown(tab, { ...pointer, buttons: 1, clientX: 10 });
    if (distance) fireEvent.pointerMove(tab, { ...pointer, buttons: 1, clientX: 10 + distance });
    await vi.advanceTimersByTimeAsync(400);
    expect(pane.tabs.activeTabId()).toBe("root::b.md");

    fireEvent.pointerUp(tab, { ...pointer, buttons: 0, clientX: 10 + distance });
    // Happy DOM does not synthesize a click from pointerup.
    fireEvent.click(tab);
    flush();
    expect(beforeDrag.mock.calls.length).toBe(0);
    expect(pane.tabs.activeTabId()).toBe("root::a.md");
  });

  it("starts and finishes a mouse drag after 10 px of movement", async () => {
    const pane = setupPaneWithTabs(["a.md"]);
    flush();
    const beforeDrag = vi.fn();
    const start = vi.fn();
    const end = vi.fn();
    const { getByRole, unmount } = render(() => (
      <DragDropProvider onBeforeDragStart={beforeDrag} onDragStart={start} onDragEnd={end}>
        <TabBar paneIndex={0} tabStore={pane.tabs} onActivateTab={() => {}} onCloseTab={() => {}} />
      </DragDropProvider>
    ));
    const pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0 };
    try {
      const tab = getByRole("button", { name: "a.md" });
      fireEvent.pointerDown(tab, { ...pointer, buttons: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(tab, { ...pointer, buttons: 1, clientX: 17, clientY: 10 });
      expect(beforeDrag.mock.calls.length).toBe(0);
      fireEvent.pointerMove(tab, { ...pointer, buttons: 1, clientX: 20, clientY: 10 });
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(tab.classList.contains("tab-bar-item-dragging")).toBe(true));

      fireEvent.pointerUp(tab, { ...pointer, buttons: 0, clientX: 20, clientY: 10 });
      await vi.waitFor(() => expect(end).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(tab.classList.contains("tab-bar-item-dragging")).toBe(false));
    } finally {
      unmount();
    }
  });

  it.each([["touch", 250], ["pen", 200]] as const)("keeps the %s hold delay", async (pointerType, delay) => {
    const pane = setupPaneWithTabs(["a.md"]);
    flush();
    const beforeDrag = vi.fn((event: BeforeDragStartEvent) => event.preventDefault());
    const { getByRole } = render(() => (
      <DragDropProvider onBeforeDragStart={beforeDrag}>
        <TabBar paneIndex={0} tabStore={pane.tabs} onActivateTab={() => {}} onCloseTab={() => {}} />
      </DragDropProvider>
    ));
    const tab = getByRole("button", { name: "a.md" });
    const pointer = { pointerId: 1, pointerType, isPrimary: true, button: 0, clientX: 10, clientY: 10 };
    fireEvent.pointerDown(tab, { ...pointer, buttons: 1 });
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(beforeDrag).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(beforeDrag).toHaveBeenCalledOnce();
    fireEvent.pointerUp(tab, { ...pointer, buttons: 0 });
  });

  it("leaves the close button and keyboard context menu in control of their keys", () => {
    const pane = setupPaneWithTabs(["a.md"]);
    flush();
    const activate = vi.fn();
    const close = vi.fn();
    const { getByRole } = render(() => (
      <TabBar tabStore={pane.tabs} onActivateTab={activate} onCloseTab={close} />
    ));
    const tab = getByRole("button", { name: "a.md" });
    const closeButton = getByRole("button", { name: "Close Tab" });
    expect(fireEvent.keyDown(closeButton, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(closeButton, { key: " " })).toBe(true);
    fireEvent.click(closeButton);
    expect(close).toHaveBeenCalledExactlyOnceWith("root::a.md");

    expect(fireEvent.keyDown(tab, { key: "ContextMenu" })).toBe(true);
    expect(fireEvent.keyDown(tab, { key: "F10", shiftKey: true })).toBe(true);
    fireEvent.contextMenu(tab, { button: 0 });
    flush();
    expect(screen.getByRole("menuitem", { name: "Close Others" })).toBeTruthy();
    expect(activate).not.toHaveBeenCalled();
  });
});

describe("TabBar — Move to Other Pane menu entry", () => {
  it("retains a named tab element across updates and keeps its menu usable", () => {
    const pane = setupPaneWithTabs(["a.md"]);
    flush();
    const activate = vi.fn();
    const { container } = render(() => <TabBar paneIndex={0} tabStore={pane.tabs} onActivateTab={activate} onCloseTab={() => {}} />);
    const first = container.querySelector<HTMLElement>(".tab-bar-item")!;
    expect(first.getAttribute("aria-label")).toBe("a.md");
    expect(first.getAttribute("role")).toBe("button");
    fireEvent.click(first);
    expect(activate).toHaveBeenCalledOnce();
    pane.tabs.updateActiveTabContent({ editorContent: "updated" });
    flush();
    expect(container.querySelector(".tab-bar-item")).toBe(first);
    expect(pane.tabs.getActiveTab()?.editorContent).toBe("updated");
    expect(first.getAttribute("aria-label")).toBe("a.md");
    const tooltipTrigger = container.querySelector<HTMLElement>(".tab-bar-item-tooltip-trigger")!;
    expect(tooltipTrigger.getAttribute("aria-label")).toBe("a.md");
    expect(tooltipTrigger.tabIndex).toBe(-1);
    fireEvent.contextMenu(first);
    flush();
    expect(screen.getByText("Close Others")).toBeTruthy();
  });

  it("names both scroll controls when the tab list overflows", async () => {
    const pane = setupPaneWithTabs(["a.md", "b.md"]);
    flush();
    const { container, getByRole } = render(() => <TabBar paneIndex={0} tabStore={pane.tabs} onActivateTab={() => {}} onCloseTab={() => {}} />);
    const list = container.querySelector<HTMLElement>(".tab-bar-list")!;
    Object.defineProperties(list, { scrollWidth: { configurable: true, value: 600 }, clientWidth: { configurable: true, value: 100 }, scrollLeft: { configurable: true, value: 50 } });
    fireEvent.scroll(list);
    flush();
    await Promise.resolve();
    expect(getByRole("button", { name: "Scroll tabs left" })).toBeTruthy();
    expect(getByRole("button", { name: "Scroll tabs right" })).toBeTruthy();
  });
  it("hides the menu entry entirely when onMoveToOtherPane prop is missing", () => {
    const pane = setupPaneWithTabs(["a.md"]);
    render(() => (
      <TabBar
        tabStore={pane.tabs}
        onActivateTab={() => {}}
        onCloseTab={() => {}}
      />
    ));
    // The context menu is closed by default; we open it via right-click
    // and verify the move entry is absent.
    const tab = screen.getByText("a.md");
    fireEvent.contextMenu(tab);
    expect(screen.queryByText(/Move to Other Pane/i)).toBeNull();
    expect(screen.queryByText(/Open in Split Pane/i)).toBeNull();
  });

  it("shows the menu entry with the supplied label when onMoveToOtherPane is wired", () => {
    // The item's click→onSelect behaviour is ui-sdk's responsibility
    // (well-tested upstream); this test guards the prop wiring — the
    // entry must be rendered with the supplied label so the user can
    // see + activate it.
    const pane = setupPaneWithTabs(["a.md"]);
    const onMove = vi.fn();
    render(() => (
      <TabBar
        tabStore={pane.tabs}
        onActivateTab={() => {}}
        onCloseTab={() => {}}
        onMoveToOtherPane={onMove}
        moveToOtherPaneLabel="Open in Split Pane"
      />
    ));
    const tab = screen.getByText("a.md");
    fireEvent.contextMenu(tab);
    flush();
    expect(screen.getByText("Open in Split Pane")).not.toBeNull();
  });

  it("falls back to the default label when moveToOtherPaneLabel is omitted", () => {
    const pane = setupPaneWithTabs(["a.md"]);
    render(() => (
      <TabBar
        tabStore={pane.tabs}
        onActivateTab={() => {}}
        onCloseTab={() => {}}
        onMoveToOtherPane={() => {}}
      />
    ));
    const tab = screen.getByText("a.md");
    fireEvent.contextMenu(tab);
    flush();
    expect(screen.getByText("Move to Other Pane")).not.toBeNull();
  });
});

describe("TabBar — translated context menu (DJA-30)", () => {
  it("renders the four close-action items by their resolved i18n labels", () => {
    // Mutation captured: pointing any of the four ContextMenuItems at
    // the wrong message key (e.g. m.tab_close in two slots) collapses
    // the rendered set below 4 unique labels.
    const pane = setupPaneWithTabs(["doc.md"]);
    render(() => (
      <TabBar
        tabStore={pane.tabs}
        onActivateTab={() => {}}
        onCloseTab={() => {}}
      />
    ));
    fireEvent.contextMenu(screen.getByText("doc.md"));
    flush();
    // EN is the base locale resolved by paraglide when no locale is set;
    // these labels must come through the i18n catalog, not be hardcoded.
    for (const label of ["Close", "Close Others", "Close to the Right", "Close All"]) {
      expect(screen.getByText(label)).not.toBeNull();
    }
  });

});
