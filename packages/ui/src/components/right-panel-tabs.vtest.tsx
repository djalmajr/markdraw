import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { RightPanelTabs, type RightPanelTab, type RightPanelTabsProps } from "./right-panel-tabs.tsx";

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
    onCloseChat: vi.fn(),
    onNewChat: vi.fn(),
    overflowItems: [{ id: "references", label: "References", count: 2, onSelect: vi.fn() }],
    ...over,
  };
}

describe("RightPanelTabs — tabs", () => {
  it("renders the pinned TOC tab with no close button", () => {
    const { baseElement } = render(() => <RightPanelTabs {...baseProps()} />);
    const pinned = baseElement.querySelector(".rp-tab-pinned")!;
    expect(pinned).not.toBeNull();
    expect(pinned.querySelector(".rp-tab-close")).toBeNull();
  });

  it("renders one chat tab per session, each with a close button", () => {
    const { baseElement } = render(() => <RightPanelTabs {...baseProps()} />);
    const chatTabs = baseElement.querySelectorAll(".rp-tab:not(.rp-tab-pinned)");
    expect(chatTabs).toHaveLength(2);
    for (const t of chatTabs) expect(t.querySelector(".rp-tab-close")).not.toBeNull();
  });

  it("marks the active tab (toc and chat encodings)", () => {
    const { baseElement, unmount } = render(() => <RightPanelTabs {...baseProps({ activeId: "toc" })} />);
    expect(baseElement.querySelector('[data-rp-tab="toc"]')!.classList.contains("rp-tab-active")).toBe(true);
    unmount();
    const { baseElement: b2 } = render(() => <RightPanelTabs {...baseProps({ activeId: "chat:s1" })} />);
    expect(b2.querySelector('[data-rp-tab="chat:s1"]')!.classList.contains("rp-tab-active")).toBe(true);
    expect(b2.querySelector('[data-rp-tab="toc"]')!.classList.contains("rp-tab-active")).toBe(false);
  });

  it("clicking the TOC tab emits onSelect('toc')", () => {
    const onSelect = vi.fn();
    const { baseElement } = render(() => <RightPanelTabs {...baseProps({ onSelect })} />);
    fireEvent.click(baseElement.querySelector('[data-rp-tab="toc"]')!);
    expect(onSelect).toHaveBeenCalledWith("toc");
  });

  it("clicking a chat tab emits onSelect('chat:<id>')", () => {
    const onSelect = vi.fn();
    const { baseElement } = render(() => <RightPanelTabs {...baseProps({ onSelect })} />);
    fireEvent.click(baseElement.querySelector('[data-rp-tab="chat:s1"]')!);
    expect(onSelect).toHaveBeenCalledWith("chat:s1");
  });

  it("clicking close fires onCloseChat and NOT onSelect", () => {
    const onSelect = vi.fn();
    const onCloseChat = vi.fn();
    const { baseElement } = render(() => <RightPanelTabs {...baseProps({ onSelect, onCloseChat })} />);
    const close = baseElement.querySelector('[data-rp-tab="chat:s1"] .rp-tab-close')!;
    fireEvent.click(close);
    expect(onCloseChat).toHaveBeenCalledWith("s1");
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
    // The overflow "…" is always present.
    expect(baseElement.querySelector(".rp-strip-actions")).not.toBeNull();
  });

  it("opens the overflow menu and renders its items with a count", () => {
    render(() => <RightPanelTabs {...baseProps()} />);
    // Kobalte's DropdownMenu trigger opens on the pointer sequence, not a bare click.
    const trigger = screen.getByLabelText("More options");
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    expect(screen.getByText("References")).not.toBeNull();
    expect(screen.getByText("2")).not.toBeNull(); // backlinks count
  });
});
