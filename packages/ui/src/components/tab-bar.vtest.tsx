import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { createPaneStore } from "../composables/create-pane-store.ts";
import { TabBar } from "./tab-bar.tsx";

afterEach(cleanup);

function setupPaneWithTabs(filenames: string[]) {
  const pane = createPaneStore("test-pane");
  for (const name of filenames) {
    pane.tabs.openTab({ kind: "file", name, path: name }, "root");
  }
  return pane;
}

describe("TabBar — keyboard activation", () => {
  it.each(["Enter", " "])("activates a focused tab with %j", (key) => {
    const pane = setupPaneWithTabs(["a.md", "b.md"]);
    flush();
    expect(pane.tabs.activeTabId()).toBe("root::b.md");
    const activate = vi.fn(pane.tabs.activateTab);
    const { getByRole } = render(() => (
      <TabBar tabStore={pane.tabs} onActivateTab={activate} onCloseTab={() => {}} />
    ));
    const tab = getByRole("button", { name: "a.md" });
    expect(tab.tabIndex).toBe(0);
    expect(fireEvent.keyDown(tab, { key })).toBe(false);
    flush();
    expect(activate).toHaveBeenCalledExactlyOnceWith("root::a.md");
    expect(pane.tabs.activeTabId()).toBe("root::a.md");
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
