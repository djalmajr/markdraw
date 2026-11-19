import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { FindInFiles, type FileMatch } from "./find-in-files.tsx";

afterEach(cleanup);

const SAMPLE_MATCHES: FileMatch[] = [
  { path: "src/a.ts", line_number: 4, line_text: "  needle here", column_start: 2, column_end: 8 },
  { path: "src/a.ts", line_number: 9, line_text: "another needle", column_start: 8, column_end: 14 },
  { path: "src/b.ts", line_number: 0, line_text: "needle at start", column_start: 0, column_end: 6 },
];

function makeSearch(matches: FileMatch[] = SAMPLE_MATCHES) {
  return vi.fn().mockResolvedValue(matches);
}

describe("FindInFiles", () => {
  it("renders nothing when open=false", () => {
    render(() => (
      <FindInFiles open={false} rootId="r1" search={makeSearch()} onSelect={() => {}} onClose={() => {}} />
    ));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not search until the user types — empty state shows no results", () => {
    const search = makeSearch();
    render(() => (
      <FindInFiles open rootId="r1" search={search} onSelect={() => {}} onClose={() => {}} />
    ));
    expect(search).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("calls the search callback with the typed query (after debounce)", async () => {
    const search = makeSearch();
    render(() => (
      <FindInFiles open rootId="r1" search={search} onSelect={() => {}} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Search in files/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "needle" } });
    flush();

    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    expect(search).toHaveBeenCalledWith("r1", "needle", { caseSensitive: false });
  });

  it("groups results by file path", async () => {
    render(() => (
      <FindInFiles open rootId="r1" search={makeSearch()} onSelect={() => {}} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Search in files/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "needle" } });
    flush();

    await waitFor(() => expect(screen.getByText("src/a.ts")).not.toBeNull());
    expect(screen.getByText("src/b.ts")).not.toBeNull();
    // 3 result rows in total.
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("Enter on the active row calls onSelect with the rootId/path/line tuple", async () => {
    const onSelect = vi.fn();
    render(() => (
      <FindInFiles open rootId="r1" search={makeSearch()} onSelect={onSelect} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Search in files/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "needle" } });
    flush();

    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
    fireEvent.keyDown(input, { key: "Enter" });
    flush();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toEqual({
      rootId: "r1",
      path: "src/a.ts",
      line: 4,
    });
  });

  it("ArrowDown moves selection through ALL matches across files", async () => {
    const onSelect = vi.fn();
    render(() => (
      <FindInFiles open rootId="r1" search={makeSearch()} onSelect={onSelect} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Search in files/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "needle" } });
    flush();
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(3));

    fireEvent.keyDown(input, { key: "ArrowDown" });
    flush();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    flush();
    // We're now on the third match — which is in src/b.ts.
    fireEvent.keyDown(input, { key: "Enter" });
    flush();
    expect(onSelect.mock.calls[0]![0]).toEqual({
      rootId: "r1",
      path: "src/b.ts",
      line: 0,
    });
  });

  it("Escape closes without firing onSelect", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(() => (
      <FindInFiles open rootId="r1" search={makeSearch()} onSelect={onSelect} onClose={onClose} />
    ));
    const input = screen.getByPlaceholderText(/Search in files/i) as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("toggling case sensitive forwards the option through to the search call", async () => {
    const search = makeSearch();
    const { baseElement } = render(() => (
      <FindInFiles open rootId="r1" search={search} onSelect={() => {}} onClose={() => {}} />
    ));
    const checkbox = baseElement.querySelector<HTMLInputElement>(
      ".find-in-files-option input[type='checkbox']",
    )!;
    fireEvent.click(checkbox);
    flush();

    const input = screen.getByPlaceholderText(/Search in files/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "needle" } });
    flush();

    await waitFor(() =>
      expect(search).toHaveBeenCalledWith("r1", "needle", { caseSensitive: true }),
    );
  });

  it("renders the matched substring inside a <mark> for highlighting", async () => {
    const { baseElement } = render(() => (
      <FindInFiles open rootId="r1" search={makeSearch()} onSelect={() => {}} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Search in files/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "needle" } });
    flush();
    await waitFor(() =>
      expect(baseElement.querySelectorAll("mark.quick-open-hit").length).toBe(3),
    );
  });

  it("renders the empty-result state when the search returns no matches", async () => {
    const search = vi.fn().mockResolvedValue([]);
    render(() => (
      <FindInFiles open rootId="r1" search={search} onSelect={() => {}} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Search in files/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "needle" } });
    flush();
    await waitFor(() => expect(screen.getByText(/No matches/i)).not.toBeNull());
  });

  it("renders an error state when the search rejects", async () => {
    const search = vi.fn().mockRejectedValue(new Error("workspace gone"));
    render(() => (
      <FindInFiles open rootId="r1" search={search} onSelect={() => {}} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Search in files/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "needle" } });
    flush();
    await waitFor(() => expect(screen.getByText(/workspace gone/i)).not.toBeNull());
  });

  it("query and results PERSIST across an open→close→open cycle on the same root", async () => {
    // Domain rule: closing the modal is "minimize", not "reset". The user
    // expects to come back to their previous search. Mutation captured:
    // restoring the unconditional reset (`setQuery(""); setResults([])`)
    // on open would empty the input on the second render.
    const search = makeSearch();
    const { unmount } = render(() => (
      <FindInFiles open rootId="r1" search={search} onSelect={() => {}} onClose={() => {}} />
    ));
    const input1 = screen.getByPlaceholderText(/Search in files/i) as HTMLInputElement;
    fireEvent.input(input1, { target: { value: "needle" } });
    flush();
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

    // Re-mount the same component (Solid recreates state on remount, so
    // we need to test the open=false → open=true path WITHOUT remount).
    // We use the rerender pattern: keep the same component instance and
    // toggle `open` via a parent signal.
    unmount();

    // True controlled-toggle test.
    const { createSignal } = await import("solid-js");
    const [open, setOpen] = createSignal(true);
    render(() => (
      <FindInFiles open={open()} rootId="r1" search={search} onSelect={() => {}} onClose={() => setOpen(false)} />
    ));
    const input = screen.getByPlaceholderText(/Search in files/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "another" } });
    flush();
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith("r1", "another", { caseSensitive: false }),
    );

    // Close and reopen.
    setOpen(false);
    flush();
    setOpen(true);
    flush();

    // Query and results must still be there.
    const inputAgain = screen.getByPlaceholderText(/Search in files/i) as HTMLInputElement;
    expect(inputAgain.value).toBe("another");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
  });

  it("query and results CLEAR when the rootId changes (different workspace)", async () => {
    // Different roots → different result spaces. Persisting an "src/foo"
    // query into a workspace that doesn't contain that path would render
    // stale results from the previous root.
    const search = makeSearch();
    const { createSignal } = await import("solid-js");
    const [rootId, setRootId] = createSignal("r1");
    render(() => (
      <FindInFiles open rootId={rootId()} search={search} onSelect={() => {}} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Search in files/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "needle" } });
    flush();
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

    setRootId("r2");
    flush();

    // Switching root resets the input and the result list.
    expect((screen.getByPlaceholderText(/Search in files/i) as HTMLInputElement).value).toBe("");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("clicking the X button clears the query, the results, and any error", async () => {
    const search = makeSearch();
    const { baseElement } = render(() => (
      <FindInFiles open rootId="r1" search={search} onSelect={() => {}} onClose={() => {}} />
    ));
    const input = screen.getByPlaceholderText(/Search in files/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "needle" } });
    flush();
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

    const clearBtn = baseElement.querySelector<HTMLButtonElement>(".find-in-files-clear");
    expect(clearBtn).not.toBeNull();
    fireEvent.mouseDown(clearBtn!);
    flush();

    expect(input.value).toBe("");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("the X button is hidden when the query is empty", () => {
    const { baseElement } = render(() => (
      <FindInFiles open rootId="r1" search={makeSearch()} onSelect={() => {}} onClose={() => {}} />
    ));
    expect(baseElement.querySelector(".find-in-files-clear")).toBeNull();
  });
});
