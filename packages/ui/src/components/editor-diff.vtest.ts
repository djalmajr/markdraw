import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  aiDiffCount,
  aiDiffField,
  clearAiDiffs,
  keepAiDiff,
  keepAllAiDiffs,
  nearestAiDiffId,
  proposeAiDiff,
  undoAiDiff,
} from "./editor-diff.ts";

let views: EditorView[] = [];

function mkView(doc: string, attach = false): EditorView {
  const state = EditorState.create({ doc, extensions: [aiDiffField] });
  const view = new EditorView({ state, ...(attach ? { parent: document.body } : {}) });
  views.push(view);
  return view;
}

function firstId(view: EditorView): string {
  return view.state.field(aiDiffField).regions[0]!.id;
}

afterEach(() => {
  for (const v of views) v.destroy();
  views = [];
});

describe("editor-diff", () => {
  it("applies the edit optimistically and registers one region", () => {
    const view = mkView("a\nOLD\nc");
    const res = proposeAiDiff(view, "OLD", "NEW");
    expect(res.ok).toBe(true);
    expect(view.state.doc.toString()).toBe("a\nNEW\nc");
    expect(aiDiffCount(view.state)).toBe(1);
  });

  it("builds del + add + bar decorations for a single-line replace", () => {
    const view = mkView("a\nOLD\nc");
    proposeAiDiff(view, "OLD", "NEW");
    // 1 deletion block + 1 added-line highlight + 1 action bar.
    expect(view.state.field(aiDiffField).decos.size).toBe(3);
  });

  it("returns not-found without touching the document or regions", () => {
    const view = mkView("a\nb\nc");
    const res = proposeAiDiff(view, "ZZZ", "NEW");
    expect(res.ok).toBe(false);
    expect(view.state.doc.toString()).toBe("a\nb\nc");
    expect(aiDiffCount(view.state)).toBe(0);
  });

  it("rejects a no-op replacement (identical text)", () => {
    const view = mkView("a\nb\nc");
    const res = proposeAiDiff(view, "b", "b");
    expect(res.ok).toBe(false);
    expect(aiDiffCount(view.state)).toBe(0);
  });

  it("Keep drops the decorations but keeps the new text", () => {
    const view = mkView("a\nOLD\nc");
    proposeAiDiff(view, "OLD", "NEW");
    keepAiDiff(view, firstId(view));
    expect(aiDiffCount(view.state)).toBe(0);
    expect(view.state.doc.toString()).toBe("a\nNEW\nc");
  });

  it("Undo restores the original block and drops the decorations", () => {
    const view = mkView("a\nOLD\nc");
    proposeAiDiff(view, "OLD", "NEW");
    undoAiDiff(view, firstId(view));
    expect(aiDiffCount(view.state)).toBe(0);
    expect(view.state.doc.toString()).toBe("a\nOLD\nc");
  });

  it("supports multiple independent regions and Keep-all", () => {
    const view = mkView("OLD1\nmid\nOLD2");
    expect(proposeAiDiff(view, "OLD1", "NEW1").ok).toBe(true);
    expect(proposeAiDiff(view, "OLD2", "NEW2").ok).toBe(true);
    expect(aiDiffCount(view.state)).toBe(2);
    keepAllAiDiffs(view);
    expect(aiDiffCount(view.state)).toBe(0);
    expect(view.state.doc.toString()).toBe("NEW1\nmid\nNEW2");
  });

  it("nearestAiDiffId returns the region containing the cursor", () => {
    const view = mkView("OLD1\nmid\nOLD2");
    proposeAiDiff(view, "OLD1", "NEW1");
    proposeAiDiff(view, "OLD2", "NEW2");
    const regions = view.state.field(aiDiffField).regions;
    const second = regions[1]!;
    // Park the cursor inside the second region.
    view.dispatch({ selection: { anchor: second.from } });
    expect(nearestAiDiffId(view.state)).toBe(second.id);
  });

  it("clearAiDiffs drops every region (used on document swap)", () => {
    const view = mkView("a\nOLD\nc");
    proposeAiDiff(view, "OLD", "NEW");
    view.dispatch({ effects: clearAiDiffs.of(null) });
    expect(aiDiffCount(view.state)).toBe(0);
  });

  it("renders the action bar and deletion block in the DOM", () => {
    const view = mkView("a\nOLD\nc", true);
    proposeAiDiff(view, "OLD", "NEW");
    expect(view.dom.querySelector(".cm-ai-diff-bar")).not.toBeNull();
    expect(view.dom.querySelector(".cm-ai-diff-del-block")).not.toBeNull();
  });
});
