import { describe, expect, it } from "bun:test";
import type { FSEntry } from "@markdraw/core/types.ts";
import { installLocalStorageMock } from "@markdraw/core/test-utils.ts";
import { createPaneStore } from "./create-pane-store.ts";

// createPaneStore now seeds tableWrap from the stored default, so it
// reads localStorage at construction — provide the mock like the sibling
// store tests do.
installLocalStorageMock();

describe("createPaneStore", () => {
  it("starts with empty content and preview mode", () => {
    const pane = createPaneStore("p0");
    expect(pane.paneId).toBe("p0");
    expect(pane.editorContent()).toBe("");
    expect(pane.savedContent()).toBe("");
    expect(pane.html()).toBe("");
    expect(pane.frontmatter()).toBeNull();
    expect(pane.editorMode()).toBe("preview");
    expect(pane.selectedFile()).toBeNull();
    expect(pane.selectedRootId()).toBeNull();
    expect(pane.loading()).toBe(false);
  });

  it("setters mutate only the pane they are bound to (no cross-pane leakage)", () => {
    // Domain rule: each pane owns its own signals. Mutating one pane
    // must not bleed into the other. Mutation captured: a future
    // refactor that accidentally shared signals via a module-level
    // store would fail this assertion.
    const left = createPaneStore("p0");
    const right = createPaneStore("p1");

    left.setEditorContent("hello");
    left.setEditorMode("edit");
    left.setLoading(true);

    expect(right.editorContent()).toBe("");
    expect(right.editorMode()).toBe("preview");
    expect(right.loading()).toBe(false);
    expect(left.editorContent()).toBe("hello");
    expect(left.editorMode()).toBe("edit");
    expect(left.loading()).toBe(true);
  });

  it("selectedFile carries the FSEntry through unchanged", () => {
    const pane = createPaneStore("p0");
    const entry: FSEntry = { kind: "file", name: "a.md", path: "a.md" };
    pane.setSelectedFile(entry);
    expect(pane.selectedFile()).toBe(entry);
    pane.setSelectedFile(null);
    expect(pane.selectedFile()).toBeNull();
  });

  it("tableWrap is per-pane: seeded from the stored default, never leaks across panes", () => {
    // Domain rule: split panes own their view prefs — toggling wrap in one
    // pane must not move the other. Mutation captured: reading the wrap
    // flag from a shared AppState signal (the old global) would make
    // `right` flip when `left` does.
    localStorage.setItem("asciimark-preview-table-wrap", "true");
    const left = createPaneStore("p0");
    const right = createPaneStore("p1");
    expect(left.tableWrap()).toBe(true); // both seed from the saved default
    expect(right.tableWrap()).toBe(true);

    left.setTableWrap(false);
    expect(left.tableWrap()).toBe(false);
    expect(right.tableWrap()).toBe(true); // unaffected
  });
});
