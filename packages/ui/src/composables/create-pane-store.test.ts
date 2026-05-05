import { describe, expect, it } from "bun:test";
import type { FSEntry } from "@asciimark/core/types.ts";
import { createPaneStore } from "./create-pane-store.ts";

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
});
