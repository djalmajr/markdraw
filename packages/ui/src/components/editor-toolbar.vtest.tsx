import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { EditorToolbar } from "./editor-toolbar.tsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("keeps unavailable history buttons focusable and ignores activation", () => {
  const [available, setAvailable] = createSignal(false);
  const undo = vi.fn();
  const redo = vi.fn();
  const { getByRole, container } = render(() => <EditorToolbar
    searchOpen={false} showInvisibles={false} showLineNumbers={false}
    indentMode="spaces" indentSize={2} syncScroll={false} wrapText={false}
    canUndo={available()} canRedo={available()} onUndo={undo} onRedo={redo}
    onToggleFind={() => {}} onIndentChange={() => {}} onToggleShowInvisibles={() => {}}
    onToggleShowLineNumbers={() => {}} onToggleWrapText={() => {}} onToggleSyncScroll={() => {}}
  />);
  const buttons = [getByRole("button", { name: "Undo" }), getByRole("button", { name: "Redo" })];
  for (const button of buttons) {
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
  }
  expect(undo).not.toHaveBeenCalled();
  expect(redo).not.toHaveBeenCalled();
  setAvailable(true);
  flush();
  for (const button of buttons) fireEvent.click(button);
  expect(undo).toHaveBeenCalledOnce();
  expect(redo).toHaveBeenCalledOnce();
  for (const button of container.querySelectorAll("button")) {
    expect(button.getAttribute("aria-label") || button.textContent?.trim()).toBeTruthy();
  }
});
