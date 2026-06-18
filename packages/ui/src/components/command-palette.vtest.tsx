import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { Command } from "@markdraw/core/command-palette.ts";
import { CommandPalette } from "./command-palette.tsx";

afterEach(cleanup);

function cmd(id: string, group: Command["group"], title: string, run = () => {}): Command {
  return { id, group, title, run };
}

const COMMANDS: Command[] = [
  cmd("file.open", "File", "Open Folder"),
  cmd("file.refresh", "Workspace", "Refresh Workspace"),
  cmd("view.sidebar", "View", "Toggle Sidebar"),
  cmd("theme.dark", "Theme", "Set Theme: Dark"),
];

describe("CommandPalette", () => {
  it("renders the dialog with every command when open and query is empty", () => {
    render(() => (
      <CommandPalette open commands={COMMANDS} platform="other" onClose={() => {}} />
    ));
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.getAllByRole("option").length).toBe(COMMANDS.length);
  });

  it("does not render when open=false", () => {
    render(() => (
      <CommandPalette open={false} commands={COMMANDS} platform="other" onClose={() => {}} />
    ));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("typing narrows the visible options by title prefix/substring", () => {
    render(() => (
      <CommandPalette open commands={COMMANDS} platform="other" onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Type a command/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "Toggle" } });
    const options = screen.getAllByRole("option");
    expect(options.length).toBe(1);
    expect(options[0]?.textContent).toContain("Toggle Sidebar");
  });

  it("Enter on the active row runs that command and then closes the palette", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    const commands: Command[] = [cmd("a", "File", "Action A", run)];
    render(() => (
      <CommandPalette open commands={commands} platform="other" onClose={onClose} />
    ));
    const input = screen.getByPlaceholderText(/Type a command/i) as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("Escape closes without running any command", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    const commands: Command[] = [cmd("a", "File", "Action A", run)];
    render(() => (
      <CommandPalette open commands={commands} platform="other" onClose={onClose} />
    ));
    const input = screen.getByPlaceholderText(/Type a command/i) as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("clicking a row runs that command and closes the palette", () => {
    const runA = vi.fn();
    const runB = vi.fn();
    const commands: Command[] = [
      cmd("a", "File", "Alpha", runA),
      cmd("b", "File", "Beta", runB),
    ];
    const onClose = vi.fn();
    render(() => (
      <CommandPalette open commands={commands} platform="other" onClose={onClose} />
    ));
    const betaRow = screen.getAllByRole("option").find((el) =>
      el.textContent?.includes("Beta"),
    )!;
    fireEvent.mouseDown(betaRow);

    expect(runB).toHaveBeenCalledTimes(1);
    expect(runA).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("renders the keyboard shortcut hint when a command declares one", () => {
    const commands: Command[] = [
      {
        id: "x",
        group: "File",
        title: "Open Folder",
        run: () => {},
        shortcut: { mac: ["⌘", "O"], other: ["Ctrl", "O"] },
      },
    ];
    render(() => (
      <CommandPalette open commands={commands} platform="other" onClose={() => {}} />
    ));
    const row = screen.getByRole("option");
    expect(row.textContent).toContain("Ctrl+O");
  });

  it("hides commands whose `when()` returns false", () => {
    const commands: Command[] = [
      cmd("visible", "File", "Visible Cmd"),
      { ...cmd("hidden", "File", "Hidden Cmd"), when: () => false },
    ];
    render(() => (
      <CommandPalette open commands={commands} platform="other" onClose={() => {}} />
    ));
    expect(screen.getAllByRole("option").length).toBe(1);
    expect(screen.queryByText(/Hidden Cmd/i)).toBeNull();
  });

  it("renders the empty state when no command matches the query", () => {
    render(() => (
      <CommandPalette open commands={COMMANDS} platform="other" onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Type a command/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "zzzzz" } });
    expect(screen.getByText(/No matching command/i)).not.toBeNull();
  });

  it("query persists across an open→close→open cycle", async () => {
    const { createSignal } = await import("solid-js");
    const [open, setOpen] = createSignal(true);
    render(() => (
      <CommandPalette open={open()} commands={COMMANDS} platform="other" onClose={() => setOpen(false)} />
    ));
    const input = screen.getByPlaceholderText(/Type a command/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "Toggle" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);

    setOpen(false);
    setOpen(true);

    const inputAgain = screen.getByPlaceholderText(/Type a command/i) as HTMLInputElement;
    expect(inputAgain.value).toBe("Toggle");
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("X button clears the query and restores the full command list", () => {
    const { baseElement } = render(() => (
      <CommandPalette open commands={COMMANDS} platform="other" onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Type a command/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "Toggle" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);

    const clearBtn = baseElement.querySelector<HTMLButtonElement>(".quick-open-clear");
    expect(clearBtn).not.toBeNull();
    fireEvent.mouseDown(clearBtn!);

    expect(input.value).toBe("");
    expect(screen.getAllByRole("option").length).toBe(COMMANDS.length);
  });
});
