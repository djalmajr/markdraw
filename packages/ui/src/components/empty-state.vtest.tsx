import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@solidjs/testing-library";
import { EmptyState } from "./empty-state.tsx";

describe("EmptyState", () => {
  it("renders the drop-zone CTA when no root is open", () => {
    const { getByText } = render(() => (
      <EmptyState hasRoot={false} />
    ));
    expect(getByText(/Drop a folder\/file here/)).not.toBeNull();
  });

  it("renders the file-selection prompt when a root is open but no file is selected", () => {
    const { getByText } = render(() => <EmptyState hasRoot={true} />);
    expect(getByText("Select a file")).not.toBeNull();
  });

  it("invokes onOpenFolder when the drop-zone is clicked", () => {
    const onOpenFolder = vi.fn();
    const { getByText } = render(() => (
      <EmptyState hasRoot={false} onOpenFolder={onOpenFolder} />
    ));
    fireEvent.click(getByText(/Drop a folder\/file here/));
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
  });

  it("hides the recent-history block when showRecentHistory is false", () => {
    const { queryByText } = render(() => (
      <EmptyState
        hasRoot={false}
        showRecentHistory={false}
        recentFolders={[{ name: "Docs", path: "/tmp/docs" }]}
      />
    ));
    expect(queryByText("Recent")).toBeNull();
  });

  it("renders folder and file entries when showRecentHistory is true", () => {
    const { getByText } = render(() => (
      <EmptyState
        hasRoot={false}
        showRecentHistory
        recentFolders={[{ name: "Docs", path: "/tmp/docs" }]}
        recentFiles={[
          {
            name: "guide.md",
            path: "guide.md",
            rootName: "Docs",
            rootPath: "/tmp/docs",
          },
        ]}
      />
    ));
    expect(getByText("Recent")).not.toBeNull();
    expect(getByText("Docs")).not.toBeNull();
    expect(getByText("guide.md")).not.toBeNull();
  });

  it("clicking a recent entry triggers the corresponding open handler", () => {
    const onOpenFolder = vi.fn();
    const onOpenRecentFolder = vi.fn();
    const onOpenRecentFile = vi.fn();
    const { getByText } = render(() => (
      <EmptyState
        hasRoot={false}
        showRecentHistory
        onOpenFolder={onOpenFolder}
        onOpenRecentFolder={onOpenRecentFolder}
        onOpenRecentFile={onOpenRecentFile}
        recentFolders={[{ name: "Docs", path: "/tmp/docs" }]}
        recentFiles={[
          {
            name: "guide.md",
            path: "guide.md",
            rootName: "Docs",
            rootPath: "/tmp/docs",
          },
        ]}
      />
    ));
    fireEvent.click(getByText("Docs"));
    expect(onOpenRecentFolder).toHaveBeenCalledWith("/tmp/docs");
    fireEvent.click(getByText("guide.md"));
    expect(onOpenRecentFile).toHaveBeenCalledTimes(1);
    // The open-folder CTA still works; click on the empty area, not the entry.
    expect(onOpenFolder).not.toHaveBeenCalled();
  });

  it("favorites are pinned at the top, ahead of non-favorited entries", () => {
    const { container } = render(() => (
      <EmptyState
        hasRoot={false}
        showRecentHistory
        recentFolders={[
          { name: "First", path: "/tmp/first" },
          { name: "Second", path: "/tmp/second" },
        ]}
        favorites={[
          {
            name: "Second",
            path: "/tmp/second",
            rootName: "Second",
            rootPath: "/tmp/second",
          },
        ]}
      />
    ));
    const items = Array.from(
      container.querySelectorAll<HTMLLIElement>(".recent-item"),
    );
    expect(items.length).toBe(2);
    // First rendered item must be the pinned one.
    expect(items[0]!.classList.contains("recent-item-pinned")).toBe(true);
    expect(items[0]!.textContent).toContain("Second");
  });

  it("invokes onToggleFavorite when the star button is clicked", () => {
    const onToggleFavorite = vi.fn();
    const { container } = render(() => (
      <EmptyState
        hasRoot={false}
        showRecentHistory
        onToggleFavorite={onToggleFavorite}
        recentFolders={[{ name: "Docs", path: "/tmp/docs" }]}
      />
    ));
    const star = container.querySelector<HTMLButtonElement>(
      ".recent-item-star",
    );
    expect(star).not.toBeNull();
    fireEvent.click(star!);
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onToggleFavorite.mock.calls[0]![0]).toMatchObject({
      path: "/tmp/docs",
      rootPath: "/tmp/docs",
    });
  });

  it("invokes onRemoveRecentFolder when the X button on a folder is clicked", () => {
    const onRemoveRecentFolder = vi.fn();
    const { container } = render(() => (
      <EmptyState
        hasRoot={false}
        showRecentHistory
        onRemoveRecentFolder={onRemoveRecentFolder}
        recentFolders={[{ name: "Docs", path: "/tmp/docs" }]}
      />
    ));
    const remove = container.querySelector<HTMLButtonElement>(
      ".recent-item-remove",
    );
    expect(remove).not.toBeNull();
    fireEvent.click(remove!);
    expect(onRemoveRecentFolder).toHaveBeenCalledWith("/tmp/docs");
  });

  it("Clear button on the recent-history header invokes onClearRecentHistory", () => {
    const onClearRecentHistory = vi.fn();
    const { getByText } = render(() => (
      <EmptyState
        hasRoot={false}
        showRecentHistory
        onClearRecentHistory={onClearRecentHistory}
        recentFolders={[{ name: "Docs", path: "/tmp/docs" }]}
      />
    ));
    fireEvent.click(getByText("Clear"));
    expect(onClearRecentHistory).toHaveBeenCalledTimes(1);
  });
});
