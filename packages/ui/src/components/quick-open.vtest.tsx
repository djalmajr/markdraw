import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { IndexedFile } from "@markdraw/core/file-index.ts";
import { QuickOpen } from "./quick-open.tsx";

// QuickOpen mounts its content via <Portal> (default target: document.body),
// so the rendered nodes live OUTSIDE the container that `render()` returns.
// All queries below go through `screen` which scans the whole document.
afterEach(cleanup);

function f(rootId: string, rootName: string, path: string): IndexedFile {
  const slash = path.lastIndexOf("/");
  return {
    rootId,
    rootName,
    path,
    name: slash >= 0 ? path.slice(slash + 1) : path,
    parentDir: slash >= 0 ? path.slice(0, slash) : "",
  };
}

const FILES: IndexedFile[] = [
  f("r1", "alpha", "README.md"),
  f("r1", "alpha", "src/app.tsx"),
  f("r1", "alpha", "src/components/button.tsx"),
  f("r2", "beta", "README.md"),
];

describe("QuickOpen", () => {
  it("renders input + result list when open", () => {
    render(() => (
      <QuickOpen open files={FILES} onSelect={() => {}} onClose={() => {}} />
    ));
    expect(screen.getByPlaceholderText(/Type a file name/i)).not.toBeNull();
    expect(screen.getAllByRole("option").length).toBe(FILES.length);
  });

  it("renders nothing when open=false", () => {
    render(() => (
      <QuickOpen open={false} files={FILES} onSelect={() => {}} onClose={() => {}} />
    ));
    expect(screen.queryByPlaceholderText(/Type a file name/i)).toBeNull();
  });

  it("typing a query narrows the visible options", () => {
    render(() => (
      <QuickOpen open files={FILES} onSelect={() => {}} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Type a file name/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "button" } });
    const options = screen.getAllByRole("option");
    expect(options.length).toBe(1);
    expect(options[0]?.textContent).toContain("button.tsx");
  });

  it("Enter on the active row dispatches onSelect with the matched file", () => {
    const onSelect = vi.fn();
    render(() => (
      <QuickOpen open files={FILES} onSelect={onSelect} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Type a file name/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "button" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]?.name).toBe("button.tsx");
  });

  it("ArrowDown moves the active row, Enter then picks the new active", () => {
    const onSelect = vi.fn();
    render(() => (
      <QuickOpen open files={FILES} onSelect={onSelect} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Type a file name/i) as HTMLInputElement;
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toEqual(FILES[1]);
  });

  it("Escape dispatches onClose without onSelect", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(() => (
      <QuickOpen open files={FILES} onSelect={onSelect} onClose={onClose} />
    ));
    const input = screen.getByPlaceholderText(/Type a file name/i) as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("two roots with the same basename — meta line disambiguates by rootName", () => {
    render(() => (
      <QuickOpen open files={FILES} onSelect={() => {}} onClose={() => {}} />
    ));
    const readmeOptions = screen.getAllByRole("option").filter((el) =>
      el.textContent?.includes("README.md"),
    );
    expect(readmeOptions.length).toBe(2);
    const meta = readmeOptions.map((el) => el.textContent ?? "");
    expect(meta.some((t) => t.includes("alpha"))).toBe(true);
    expect(meta.some((t) => t.includes("beta"))).toBe(true);
  });

  it("clicking a row dispatches onSelect with that file", () => {
    const onSelect = vi.fn();
    render(() => (
      <QuickOpen open files={FILES} onSelect={onSelect} onClose={() => {}} />
    ));
    const buttonRow = screen.getAllByRole("option").find((el) =>
      el.textContent?.includes("button.tsx"),
    )!;
    fireEvent.mouseDown(buttonRow);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]?.name).toBe("button.tsx");
  });

  it("empty workspace renders the 'No files in workspace' empty state", () => {
    render(() => (
      <QuickOpen open files={[]} onSelect={() => {}} onClose={() => {}} />
    ));
    expect(screen.getByText(/No files in workspace/i)).not.toBeNull();
  });

  it("query that matches nothing renders the 'No matches' empty state", () => {
    render(() => (
      <QuickOpen open files={FILES} onSelect={() => {}} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Type a file name/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "xyzzy" } });
    expect(screen.getByText(/No matches/i)).not.toBeNull();
  });

  it("query and active row PERSIST across an open→close→open cycle", async () => {
    // Domain rule: closing the palette is "minimize", not "reset". The
    // user expects to come back to their previous filter — matches
    // VS Code's Cmd+P behavior. Mutation captured: re-introducing the
    // unconditional reset (`setQuery("")`) on `open=true` would empty
    // the input on the second render.
    const { createSignal } = await import("solid-js");
    const [open, setOpen] = createSignal(true);
    render(() => (
      <QuickOpen open={open()} files={FILES} onSelect={() => {}} onClose={() => setOpen(false)} />
    ));
    const input = screen.getByPlaceholderText(/Type a file name/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "button" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);

    setOpen(false);
    setOpen(true);

    const inputAgain = screen.getByPlaceholderText(/Type a file name/i) as HTMLInputElement;
    expect(inputAgain.value).toBe("button");
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("X button clears the query and restores the full list", () => {
    const { baseElement } = render(() => (
      <QuickOpen open files={FILES} onSelect={() => {}} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Type a file name/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "button" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);

    const clearBtn = baseElement.querySelector<HTMLButtonElement>(".quick-open-clear");
    expect(clearBtn).not.toBeNull();
    fireEvent.mouseDown(clearBtn!);

    expect(input.value).toBe("");
    expect(screen.getAllByRole("option").length).toBe(FILES.length);
  });

  it("X button is hidden when the query is empty", () => {
    const { baseElement } = render(() => (
      <QuickOpen open files={FILES} onSelect={() => {}} onClose={() => {}} />
    ));
    expect(baseElement.querySelector(".quick-open-clear")).toBeNull();
  });

  it("coalesces contiguous match positions into a single <mark> — no per-char fragmentation", () => {
    // Regression: prior version emitted one <mark> per matched position, so
    // typing the prefix of a basename produced N adjacent <mark> elements
    // and the inline boundary spacing made it look like "m e t r i c".
    // Hovering a row also wasn't enough — the fix must hold without focus.
    const file = f("r1", "alpha", "metrics.tsx");
    render(() => (
      <QuickOpen open files={[file]} onSelect={() => {}} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Type a file name/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "metric" } });

    const row = screen.getByRole("option");
    const marks = row.querySelectorAll("mark.quick-open-hit");
    // 6 contiguous chars must collapse to exactly one <mark>, not six.
    expect(marks.length).toBe(1);
    expect(marks[0]?.textContent).toBe("metric");
  });
});
