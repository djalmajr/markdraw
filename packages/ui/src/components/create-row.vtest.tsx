import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { CreateRow } from "./create-row.tsx";

afterEach(cleanup);

// CreateRow is opened from a Kobalte menu item. When that menu closes it
// restores focus to its trigger, which blurs the freshly-focused input. The
// row must NOT treat that focus-restoration blur as a commit/cancel — losing
// it made "New File / New Folder" appear to do nothing (the input flashed and
// vanished before the user could type). These tests lock that behaviour.
describe("CreateRow", () => {
  it("keeps focus on the input when a menu trigger steals focus after mount", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    try {
      const { container } = render(() => (
        <CreateRow kind="file" indent={8} icon={<span />} onCommit={() => {}} onCancel={() => {}} />
      ));
      const input = container.querySelector<HTMLInputElement>(".tree-create-input")!;

      trigger.focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.activeElement).toBe(input);

      trigger.focus();
      fireEvent.blur(input);
      flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.activeElement).toBe(input);
    } finally {
      trigger.remove();
    }
  });

  it("does NOT cancel on the focus-restoration blur that fires before it arms", () => {
    const onCancel = vi.fn();
    const onCommit = vi.fn();
    const { container } = render(() => (
      <CreateRow kind="file" indent={8} icon={<span />} onCommit={onCommit} onCancel={onCancel} />
    ));
    const input = container.querySelector<HTMLInputElement>(".tree-create-input")!;
    // A blur dispatched synchronously after mount is the menu's restoration —
    // `armed` is still false, so it must be ignored (re-focus), not cancel.
    fireEvent.blur(input);
    flush();
    expect(onCancel).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits the typed name on Enter", () => {
    const onCommit = vi.fn();
    const { container } = render(() => (
      <CreateRow kind="file" indent={8} icon={<span />} onCommit={onCommit} onCancel={() => {}} />
    ));
    const input = container.querySelector<HTMLInputElement>(".tree-create-input")!;
    fireEvent.input(input, { target: { value: "notes/today.md" } });
    flush();
    fireEvent.keyDown(input, { key: "Enter" });
    flush();
    expect(onCommit).toHaveBeenCalledWith("notes/today.md");
  });

  it("cancels on Escape", () => {
    const onCancel = vi.fn();
    const { container } = render(() => (
      <CreateRow kind="folder" indent={8} icon={<span />} onCommit={() => {}} onCancel={onCancel} />
    ));
    const input = container.querySelector<HTMLInputElement>(".tree-create-input")!;
    fireEvent.keyDown(input, { key: "Escape" });
    flush();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("uses a distinct placeholder for file vs folder", () => {
    // Render one at a time and unmount between — two un-interacted create
    // inputs in the DOM at once would ping-pong focus (each reclaims it on
    // blur). Production only ever shows a single CreateRow.
    const file = render(() => (
      <CreateRow kind="file" indent={8} icon={<span />} onCommit={() => {}} onCancel={() => {}} />
    ));
    const filePh = file.container.querySelector<HTMLInputElement>(".tree-create-input")!.placeholder;
    file.unmount();

    const folder = render(() => (
      <CreateRow kind="folder" indent={8} icon={<span />} onCommit={() => {}} onCancel={() => {}} />
    ));
    const folderPh = folder.container.querySelector<HTMLInputElement>(".tree-create-input")!.placeholder;
    folder.unmount();

    expect(filePh).not.toBe("");
    expect(folderPh).not.toBe("");
    expect(filePh).not.toBe(folderPh);
  });
});
