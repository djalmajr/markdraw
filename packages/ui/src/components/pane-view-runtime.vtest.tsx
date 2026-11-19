import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createRoot, createSignal, flush } from "solid-js";
import { EditorView } from "@codemirror/view";
import { createAppState } from "../composables/create-app-state.ts";

vi.mock("../lib/dnd/index.ts", () => ({ useDroppable: () => ({ ref: () => {}, isDropTarget: () => false }) }));
vi.mock("./preview.tsx", () => ({ Preview: () => null }));
vi.mock("./editor-toolbar.tsx", () => ({ EditorToolbar: () => null }));
vi.mock("./content-toolbar.tsx", () => ({ ContentToolbar: () => null }));
vi.mock("./tab-bar.tsx", () => ({ TabBar: () => null }));
vi.mock("./empty-state.tsx", () => ({ EmptyState: () => null }));
import { PaneView } from "./pane-view.tsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("routes CodeMirror selection through a composed active-pane prop without creating primitives in the listener", async () => {
  const warn = vi.spyOn(console, "warn");
  const error = vi.spyOn(console, "error");
  let dispose!: () => void;
  const state = createRoot((stop) => {
    dispose = stop;
    return createAppState({ applyTheme: () => {}, convertAdoc: async () => ({ html: "", frontmatter: null }), convertMarkdown: async () => ({ html: "", frontmatter: null }), getStoredTheme: () => "system" });
  });
  try {
    state.setSelectedFile({ name: "doc.md", path: "doc.md", kind: "file" });
    state.setEditorContent("one one");
    state.setEditorMode("split");
    flush();
    const selection = vi.spyOn(state, "setSelectionPopover");
    const [active, setActive] = createSignal(true);
    const { container } = render(() => <PaneView pane={state.paneManager.activePane()} state={state} paneIndex={0} isActive={active() && state.paneManager.activePaneIndex() === 0} />);
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 1, right: 2, top: 1, bottom: 2 });
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "one one" } });
    expect(view.state.doc.toString()).toBe("one one");
    state.setEditorSearchOpen(true);
    flush();
    const input = container.querySelector<HTMLInputElement>(".search-input")!;
    fireEvent.input(input, { target: { value: "one" } });
    flush();
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    await Promise.resolve();
    flush();
    expect(selection).toHaveBeenCalled();
    selection.mockClear();
    setActive(false);
    flush();
    view.dispatch({ selection: { anchor: 4, head: 7 } });
    expect(selection).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/update listener|PRIMITIVE_/);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/PRIMITIVE_/);
  } finally {
    cleanup();
    dispose();
  }
});
