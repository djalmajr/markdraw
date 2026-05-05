import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
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

describe("TabBar — Move to Other Pane menu entry", () => {
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
    // The item's click→onSelect behaviour is Kobalte's responsibility
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
    expect(screen.getByText("Move to Other Pane")).not.toBeNull();
  });
});
