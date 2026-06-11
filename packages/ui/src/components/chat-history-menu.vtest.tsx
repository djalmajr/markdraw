import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { AiChatSessionMeta } from "../composables/create-ai-chat-sessions.ts";
import { ChatHistoryMenu, type ChatHistoryMenuProps } from "./chat-history-menu.tsx";

afterEach(cleanup);

const NOW = new Date("2026-06-07T12:00:00").getTime();

function meta(over: Partial<AiChatSessionMeta>): AiChatSessionMeta {
  return {
    id: "x",
    title: "Chat",
    createdAt: 1,
    lastActiveAt: NOW - 1000,
    isArchived: false,
    isOpen: true,
    ...over,
  };
}

const ITEMS: AiChatSessionMeta[] = [
  meta({ id: "a", title: "Project status" }),
  meta({ id: "b", title: "", lastActiveAt: NOW - 2000 }), // untitled → defaultTitle
  meta({ id: "c", title: "Old archived", isArchived: true, isOpen: false }),
];

function baseProps(over: Partial<ChatHistoryMenuProps> = {}): ChatHistoryMenuProps {
  return {
    items: ITEMS,
    activeId: "a",
    defaultTitle: "New chat",
    now: () => NOW,
    onActivate: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
}

function open(props: ChatHistoryMenuProps) {
  const result = render(() => <ChatHistoryMenu {...props} />);
  fireEvent.click(screen.getByLabelText("Chat history"));
  return result;
}

describe("ChatHistoryMenu", () => {
  it("opens and groups sessions into Today and Archived", () => {
    open(baseProps());
    expect(screen.getByText("Today")).not.toBeNull();
    expect(screen.getByText("Archived")).not.toBeNull();
    expect(screen.getByText("Project status")).not.toBeNull();
    expect(screen.getByText("New chat")).not.toBeNull(); // untitled fallback
    expect(screen.getByText("Old archived")).not.toBeNull();
  });

  it("filters rows by the search query (case-insensitive)", () => {
    open(baseProps());
    const input = screen.getByPlaceholderText("Search chats…");
    fireEvent.input(input, { target: { value: "project" } });
    expect(screen.getByText("Project status")).not.toBeNull();
    expect(screen.queryByText("Old archived")).toBeNull();
  });

  it("clicking a row activates it", () => {
    const onActivate = vi.fn();
    open(baseProps({ onActivate }));
    fireEvent.click(screen.getByText("Project status"));
    expect(onActivate).toHaveBeenCalledWith("a");
  });

  it("renders the empty state when there are no chats", () => {
    open(baseProps({ items: [] }));
    expect(screen.getByText("No chats yet")).not.toBeNull();
  });

  it("a non-archived row's menu offers Archive; an archived row offers Restore", () => {
    const { baseElement } = open(baseProps());
    // Open the row menu for the active (non-archived) "Project status". Kobalte's
    // DropdownMenu trigger opens on the pointer sequence, not a bare click.
    const activeRow = screen.getByText("Project status").closest(".rp-history-row")!;
    const menuBtn = activeRow.querySelector(".rp-history-row-menu")!;
    fireEvent.pointerDown(menuBtn, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(menuBtn, { button: 0, pointerType: "mouse" });
    fireEvent.click(menuBtn);
    expect(screen.getByText("Archive")).not.toBeNull();
    expect(baseElement.querySelector(".rp-history-delete")).not.toBeNull();
  });

  it("offers Duplicate chat when onForkSession is provided and fires it with the row id", () => {
    const onForkSession = vi.fn();
    open(baseProps({ onForkSession }));
    const activeRow = screen.getByText("Project status").closest(".rp-history-row")!;
    const menuBtn = activeRow.querySelector(".rp-history-row-menu")!;
    fireEvent.pointerDown(menuBtn, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(menuBtn, { button: 0, pointerType: "mouse" });
    fireEvent.click(menuBtn);
    const fork = screen.getByText("Duplicate chat");
    fireEvent.pointerDown(fork, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(fork, { button: 0, pointerType: "mouse" });
    fireEvent.click(fork);
    expect(onForkSession).toHaveBeenCalledWith("a");
  });

  it("hides Duplicate chat when onForkSession is absent", () => {
    open(baseProps());
    const activeRow = screen.getByText("Project status").closest(".rp-history-row")!;
    const menuBtn = activeRow.querySelector(".rp-history-row-menu")!;
    fireEvent.pointerDown(menuBtn, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(menuBtn, { button: 0, pointerType: "mouse" });
    fireEvent.click(menuBtn);
    expect(screen.getByText("Archive")).not.toBeNull(); // menu is open
    expect(screen.queryByText("Duplicate chat")).toBeNull();
  });
});
