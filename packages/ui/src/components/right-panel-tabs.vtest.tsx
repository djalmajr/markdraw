import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import {
  RightPanelTabs,
  fromRpTabDndId,
  rpDropIndicator,
  toRpTabDndId,
  type RightPanelTab,
  type RightPanelTabsProps,
} from "./right-panel-tabs.tsx";
import { fromTabDndId, toTabDndId } from "./tab-bar.tsx";

afterEach(cleanup);

const TABS: RightPanelTab[] = [
  { id: "toc", kind: "toc", title: "Outline" },
  { id: "s1", kind: "chat", title: "Chat one" },
  { id: "s2", kind: "chat", title: "Chat two", streaming: true },
];

function baseProps(over: Partial<RightPanelTabsProps> = {}): RightPanelTabsProps {
  return {
    tabs: TABS,
    activeId: "toc",
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseToRight: vi.fn(),
    onCloseAll: vi.fn(),
    onTogglePin: vi.fn(),
    onRenameChat: vi.fn(),
    onExportChat: vi.fn(),
    onArchiveChat: vi.fn(),
    onDeleteChat: vi.fn(),
    onNewChat: vi.fn(),
    overflowItems: [{ id: "references", label: "References", count: 2, onSelect: vi.fn() }],
    ...over,
  };
}

describe("RightPanelTabs — tabs", () => {
  it("renders one closeable tab per entry (specials + chats)", () => {
    const { baseElement } = render(() => <RightPanelTabs {...baseProps()} />);
    const tabs = baseElement.querySelectorAll(".rp-tab");
    expect(tabs).toHaveLength(3);
    for (const t of tabs) expect(t.querySelector(".rp-tab-close")).not.toBeNull();
  });

  it("gives specials an icon and chats none", () => {
    const { baseElement } = render(() => <RightPanelTabs {...baseProps()} />);
    expect(baseElement.querySelector('[data-rp-tab="toc"] .rp-tab-icon')).not.toBeNull();
    expect(baseElement.querySelector('[data-rp-tab="chat:s1"] .rp-tab-icon')).toBeNull();
  });

  it("shows a pin glyph on a pinned tab (still closeable)", () => {
    const { baseElement } = render(() => (
      <RightPanelTabs {...baseProps({ tabs: [{ id: "s1", kind: "chat", title: "Pinned", pinned: true }] })} />
    ));
    const tab = baseElement.querySelector('[data-rp-tab="chat:s1"]')!;
    expect(tab.classList.contains("rp-tab-pinned")).toBe(true);
    expect(tab.querySelector(".rp-tab-pin")).not.toBeNull();
    expect(tab.querySelector(".rp-tab-close")).not.toBeNull();
  });

  it("marks the active tab (toc and chat encodings)", () => {
    const { baseElement, unmount } = render(() => <RightPanelTabs {...baseProps({ activeId: "toc" })} />);
    expect(baseElement.querySelector('[data-rp-tab="toc"]')!.classList.contains("rp-tab-active")).toBe(true);
    unmount();
    const { baseElement: b2 } = render(() => <RightPanelTabs {...baseProps({ activeId: "chat:s1" })} />);
    expect(b2.querySelector('[data-rp-tab="chat:s1"]')!.classList.contains("rp-tab-active")).toBe(true);
    expect(b2.querySelector('[data-rp-tab="toc"]')!.classList.contains("rp-tab-active")).toBe(false);
  });

  it("clicking a tab emits onSelect with its encoded id", () => {
    const onSelect = vi.fn();
    const { baseElement } = render(() => <RightPanelTabs {...baseProps({ onSelect })} />);
    fireEvent.click(baseElement.querySelector('[data-rp-tab="toc"]')!);
    expect(onSelect).toHaveBeenCalledWith("toc");
    fireEvent.click(baseElement.querySelector('[data-rp-tab="chat:s1"]')!);
    expect(onSelect).toHaveBeenCalledWith("chat:s1");
  });

  it("clicking close fires onClose(encoded) and NOT onSelect", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { baseElement } = render(() => <RightPanelTabs {...baseProps({ onSelect, onClose })} />);
    fireEvent.click(baseElement.querySelector('[data-rp-tab="chat:s1"] .rp-tab-close')!);
    expect(onClose).toHaveBeenCalledWith("chat:s1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows a streaming dot on an inactive streaming chat, hides it when active", () => {
    const { baseElement, unmount } = render(() => <RightPanelTabs {...baseProps({ activeId: "toc" })} />);
    expect(baseElement.querySelector('[data-rp-tab="chat:s2"] .rp-tab-dot')).not.toBeNull();
    expect(baseElement.querySelector('[data-rp-tab="chat:s1"] .rp-tab-dot')).toBeNull();
    unmount();
    const { baseElement: b2 } = render(() => <RightPanelTabs {...baseProps({ activeId: "chat:s2" })} />);
    expect(b2.querySelector('[data-rp-tab="chat:s2"] .rp-tab-dot')).toBeNull();
  });
});

describe("RightPanelTabs — drag-and-drop wiring", () => {
  // jsdom/happy-dom can't run real pointer drags; like the tab-bar tests we
  // assert at presence/parser depth: the draggable-wired tabs still render
  // and behave, and the id namespace stays mutually exclusive.

  it("round-trips encoded ids through the rp dnd namespace", () => {
    expect(fromRpTabDndId(toRpTabDndId("toc"))).toBe("toc");
    expect(fromRpTabDndId(toRpTabDndId("backlinks"))).toBe("backlinks");
    expect(fromRpTabDndId(toRpTabDndId("chat:s1"))).toBe("chat:s1");
  });

  it("fromRpTabDndId rejects editor-tab, pane, root and non-string dnd ids", () => {
    expect(fromRpTabDndId(toTabDndId(0, "a.md"))).toBeNull();
    expect(fromRpTabDndId("pane::1")).toBeNull();
    expect(fromRpTabDndId("root::r1")).toBeNull();
    expect(fromRpTabDndId(null)).toBeNull();
    expect(fromRpTabDndId(undefined)).toBeNull();
    expect(fromRpTabDndId(42)).toBeNull();
  });

  it("the editor-tab parser rejects rp-tab dnd ids (namespaces never collide)", () => {
    expect(fromTabDndId(toRpTabDndId("chat:s1"))).toBeNull();
    expect(fromTabDndId(toRpTabDndId("toc"))).toBeNull();
  });

  it("tabs render and stay clickable with the draggable wiring (multi-tab strip)", () => {
    const onSelect = vi.fn();
    const { baseElement } = render(() => <RightPanelTabs {...baseProps({ onSelect })} />);
    expect(baseElement.querySelectorAll(".rp-tab")).toHaveLength(3);
    fireEvent.click(baseElement.querySelector('[data-rp-tab="chat:s2"]')!);
    expect(onSelect).toHaveBeenCalledWith("chat:s2");
  });

  it("a single-tab strip (drag disabled) still renders and selects", () => {
    const onSelect = vi.fn();
    const { baseElement } = render(() => (
      <RightPanelTabs
        {...baseProps({ onSelect, tabs: [{ id: "s1", kind: "chat", title: "Only" }] })}
      />
    ));
    expect(baseElement.querySelectorAll(".rp-tab")).toHaveLength(1);
    fireEvent.click(baseElement.querySelector('[data-rp-tab="chat:s1"]')!);
    expect(onSelect).toHaveBeenCalledWith("chat:s1");
  });
});

describe("rpDropIndicator — insertion-line preview semantics", () => {
  const STRIP: RightPanelTab[] = [
    { id: "p1", kind: "chat", title: "P1", pinned: true },
    { id: "p2", kind: "chat", title: "P2", pinned: true },
    { id: "toc", kind: "toc", title: "" },
    { id: "s1", kind: "chat", title: "S1" },
    { id: "s2", kind: "chat", title: "S2" },
  ];

  it("same group: line lands before the hovered tab when moving left, after when moving right", () => {
    expect(rpDropIndicator(STRIP, "chat:s2", "toc")).toEqual({ encoded: "toc", side: "before" });
    expect(rpDropIndicator(STRIP, "toc", "chat:s2")).toEqual({ encoded: "chat:s2", side: "after" });
  });

  it("cross group clamps to the pinned boundary, mirroring the reorder semantics", () => {
    // Pinned dragged over the unpinned region → after the LAST pinned tab.
    expect(rpDropIndicator(STRIP, "chat:p1", "chat:s1")).toEqual({
      encoded: "chat:p2",
      side: "after",
    });
    // Unpinned dragged over the pinned region → before the FIRST unpinned tab.
    expect(rpDropIndicator(STRIP, "chat:s2", "chat:p1")).toEqual({
      encoded: "toc",
      side: "before",
    });
  });

  it("yields null with no drag, a self-hover, or unknown ids", () => {
    expect(rpDropIndicator(STRIP, null, "toc")).toBeNull();
    expect(rpDropIndicator(STRIP, "toc", null)).toBeNull();
    expect(rpDropIndicator(STRIP, "toc", "toc")).toBeNull();
    expect(rpDropIndicator(STRIP, "chat:ghost", "toc")).toBeNull();
    expect(rpDropIndicator(STRIP, "toc", "chat:ghost")).toBeNull();
  });

  it("no drag operation → no insertion line", () => {
    const { container } = render(() => <RightPanelTabs {...baseProps()} />);
    expect(container.querySelector(".rp-tab-drop-before, .rp-tab-drop-after")).toBeNull();
  });
});

describe("RightPanelTabs — context menu", () => {
  it("a chat tab menu offers Pin, Rename, Export, Archive, the close group and Delete", () => {
    const { baseElement } = render(() => <RightPanelTabs {...baseProps()} />);
    fireEvent.contextMenu(baseElement.querySelector('[data-rp-tab="chat:s1"]')!);
    expect(screen.getByText("Pin")).not.toBeNull();
    expect(screen.getByText("Rename")).not.toBeNull();
    expect(screen.getByText("Export…")).not.toBeNull();
    expect(screen.getByText("Archive")).not.toBeNull();
    expect(screen.getByText("Close All")).not.toBeNull();
    expect(screen.getByText("Delete")).not.toBeNull();
  });

  it("a special tab menu offers Pin + the close group but no chat actions", () => {
    const { baseElement } = render(() => <RightPanelTabs {...baseProps()} />);
    fireEvent.contextMenu(baseElement.querySelector('[data-rp-tab="toc"]')!);
    expect(screen.getByText("Pin")).not.toBeNull();
    expect(screen.getByText("Close to the Right")).not.toBeNull();
    expect(screen.queryByText("Export…")).toBeNull();
    expect(screen.queryByText("Delete")).toBeNull();
  });

  it("menu actions invoke the right callbacks", () => {
    const onTogglePin = vi.fn();
    const onDeleteChat = vi.fn();
    const { baseElement } = render(() => <RightPanelTabs {...baseProps({ onTogglePin, onDeleteChat })} />);
    // Kobalte menu items select on the pointer sequence, not a bare click.
    const select = (label: string): void => {
      const item = screen.getByText(label);
      fireEvent.pointerDown(item, { button: 0, pointerType: "mouse" });
      fireEvent.pointerUp(item, { button: 0, pointerType: "mouse" });
      fireEvent.click(item);
    };
    fireEvent.contextMenu(baseElement.querySelector('[data-rp-tab="chat:s1"]')!);
    select("Pin");
    expect(onTogglePin).toHaveBeenCalledWith("chat:s1");
    fireEvent.contextMenu(baseElement.querySelector('[data-rp-tab="chat:s1"]')!);
    select("Delete");
    expect(onDeleteChat).toHaveBeenCalledWith("s1");
  });
});

describe("RightPanelTabs — inline rename", () => {
  it("double-click a chat tab opens an input that commits on Enter", () => {
    const onRenameChat = vi.fn();
    const { baseElement } = render(() => <RightPanelTabs {...baseProps({ onRenameChat })} />);
    fireEvent.dblClick(baseElement.querySelector('[data-rp-tab="chat:s1"]')!);
    const input = baseElement.querySelector(".rp-tab-rename") as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.input(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenameChat).toHaveBeenCalledWith("s1", "Renamed");
  });
});

describe("RightPanelTabs — actions", () => {
  it("the + button fires onNewChat", () => {
    const onNewChat = vi.fn();
    render(() => <RightPanelTabs {...baseProps({ onNewChat })} />);
    fireEvent.click(screen.getByLabelText("New chat"));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("hides the + control when onNewChat is absent (no AI host)", () => {
    const { baseElement } = render(() => <RightPanelTabs {...baseProps({ onNewChat: undefined })} />);
    expect(screen.queryByLabelText("New chat")).toBeNull();
    expect(baseElement.querySelector(".rp-strip-actions")).not.toBeNull();
  });

  it("opens the overflow menu and renders its items with a count", () => {
    render(() => <RightPanelTabs {...baseProps()} />);
    const trigger = screen.getByLabelText("More options");
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    expect(screen.getByText("References")).not.toBeNull();
    expect(screen.getByText("2")).not.toBeNull(); // backlinks count
  });
});
