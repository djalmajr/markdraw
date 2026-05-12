import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { fireEvent, render } from "@solidjs/testing-library";
import type { FSEntry } from "@asciimark/core/types.ts";
import type { AppState } from "../composables/create-app-state.ts";
import type { PaneStore } from "../composables/create-pane-store.ts";

// PaneView's children all bring their own heavy dependencies
// (CodeMirror, markdown-it, dnd-kit). For a structural test of the
// resize-handle's parent-ref contract we don't need any of them —
// stub them with empty divs so the render finishes synchronously
// and the resize-handle's ancestor chain is what we actually probe.
vi.mock("./editor.tsx", () => ({ Editor: () => <div data-testid="editor-stub" /> }));
vi.mock("./preview.tsx", () => ({ Preview: () => <div data-testid="preview-stub" /> }));
vi.mock("./editor-toolbar.tsx", () => ({ EditorToolbar: () => null }));
vi.mock("./content-toolbar.tsx", () => ({ ContentToolbar: () => null }));
vi.mock("./tab-bar.tsx", () => ({ TabBar: () => null }));
vi.mock("./empty-state.tsx", () => ({ EmptyState: () => null }));
vi.mock("@dnd-kit/solid", () => ({
  useDroppable: () => ({ ref: () => {}, isDropTarget: () => false }),
}));

import { PaneView } from "./pane-view.tsx";

function fileEntry(name = "doc.md"): FSEntry {
  return { name, path: name, kind: "file" };
}

function makePane(): PaneStore {
  const [editorMode] = createSignal<"edit" | "split" | "preview">("split");
  const [selectedFile] = createSignal<FSEntry | null>(fileEntry());
  return {
    paneId: "p0",
    editorMode,
    selectedFile,
    // Methods PaneView's children would consume — children are mocked
    // so these are never reached, but the type cast needs SOMETHING.
    tabs: { tabs: () => [], getActiveTab: () => null, pinTab: () => {} },
    html: () => "",
    editorContent: () => "",
    setEditorContent: () => {},
    savedContent: () => "",
    setSavedContent: () => {},
    frontmatter: () => null,
    setFrontmatter: () => {},
    selectedRootId: () => null,
    setSelectedRootId: () => {},
    setSelectedFile: () => {},
    setEditorMode: () => {},
    setHtml: () => {},
    loading: () => false,
    setLoading: () => {},
  } as unknown as PaneStore;
}

function makeState(onEditorResizeStart: (...args: unknown[]) => void): AppState {
  return {
    editorWidth: () => 50,
    syncScroll: () => false,
    darkMode: () => false,
    indentMode: () => "spaces",
    indentSize: () => 2,
    showLineNumbers: () => true,
    showInvisibles: () => false,
    wrapText: () => true,
    fontPrefs: () => ({ fontSize: 14, fontFamily: "system" }),
    FontFamilies: [],
    FontSizes: [],
    autoRefresh: () => true,
    editorSearchOpen: () => false,
    setEditorSearchOpen: () => {},
    editorFindTrigger: () => 0,
    previewSearchOpen: () => false,
    setPreviewSearchOpen: () => {},
    previewFindTrigger: () => 0,
    triggerPreviewFind: () => {},
    onEditorResizeStart,
    onEditorResizeReset: () => {},
    handleIndentModeChange: () => {},
    handleIndentSizeChange: () => {},
    handleShowInvisiblesChange: () => {},
    handleLineNumbersChange: () => {},
    handleSyncScrollChange: () => {},
    handleWrapTextChange: () => {},
    handleFontPrefsChange: () => {},
    setAutoRefresh: () => {},
    debouncedConvert: () => {},
    _readFile: null,
  } as unknown as AppState;
}

describe("PaneView resize handle", () => {
  it("mounts the resize handle inside .content-panels with .editor-panel + .content as siblings", () => {
    // Mutation captured: moving the `.resize-handle` out of
    // `.content-panels` (or renaming either sibling class) breaks
    // the structural contract that `onEditorResizeStart` depends
    // on. The handler's selector logic queries the parent for
    // both classes; without this invariant the drag is silent.
    const pane = makePane();
    const state = makeState(() => {});
    const { container } = render(() => (
      <PaneView pane={pane} state={state} paneIndex={0} isActive={true} />
    ));
    const handle = container.querySelector<HTMLElement>(".resize-handle");
    expect(handle).not.toBeNull();
    const parent = handle!.parentElement;
    expect(parent).not.toBeNull();
    expect(parent!.classList.contains("content-panels")).toBe(true);
    expect(parent!.querySelector(".editor-panel")).not.toBeNull();
    expect(parent!.querySelector(".content")).not.toBeNull();
  });

  it("mousedown on the resize handle passes a ref that resolves both .editor-panel and .content", () => {
    // Mutation captured: this is the exact bug fixed in 584f01a —
    // passing `editorPanelRef` (or any sibling/descendant of
    // `.content-panels`) instead of `contentPanelsRef` makes both
    // querySelector calls return null inside the handler, and the
    // drag silently does nothing. Spy on `onEditorResizeStart` and
    // assert the ref the handler received has the right descendants
    // — this fails the moment the call site forwards the wrong ref.
    const onEditorResizeStart = vi.fn();
    const pane = makePane();
    const state = makeState(onEditorResizeStart);
    const { container } = render(() => (
      <PaneView pane={pane} state={state} paneIndex={0} isActive={true} />
    ));
    const handle = container.querySelector<HTMLElement>(".resize-handle");
    expect(handle).not.toBeNull();
    fireEvent.mouseDown(handle!);
    expect(onEditorResizeStart).toHaveBeenCalledTimes(1);
    const [, mainRef] = onEditorResizeStart.mock.calls[0]!;
    const ref = mainRef as HTMLElement | undefined;
    expect(ref).toBeDefined();
    expect(ref!.querySelector(".editor-panel")).not.toBeNull();
    expect(ref!.querySelector(".content")).not.toBeNull();
  });
});
