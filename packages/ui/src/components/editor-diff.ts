// Cursor-style inline diff review for AI edits. When the assistant proposes an
// edit we APPLY it optimistically and overlay a diff the user can Keep or Undo —
// per region (the action bar / ⌘Y / ⌘N) or all at once (⌘↵). The diff lives
// entirely in CodeMirror view state (a StateField of decorations); it is never
// serialized into the document, so saved files are never polluted by review UI.
//
// Each `app__propose_edit` call becomes one independent region, which gives the
// "per-section" granularity for free: N proposals → N regions, each keep/undoable.

import { type EditorState, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { diffLines, type DiffOp } from "@markdraw/core/line-diff.ts";
import * as m from "@markdraw/i18n";

/** A live diff region: the applied (new) span plus the old text to restore. */
export interface AiDiffRegion {
  readonly id: string;
  /** Start offset of the applied (new) block in the CURRENT document. */
  from: number;
  /** End offset of the applied (new) block in the CURRENT document. */
  to: number;
  /** The original block text — restored verbatim on Undo. */
  readonly oldText: string;
  /** Line-level ops between oldText and the applied block (drives rendering). */
  readonly ops: readonly DiffOp[];
}

export const addAiDiff = StateEffect.define<AiDiffRegion>();
export const removeAiDiff = StateEffect.define<string>();
export const clearAiDiffs = StateEffect.define<null>();

interface FieldValue {
  readonly regions: readonly AiDiffRegion[];
  readonly decos: DecorationSet;
}

const EMPTY: FieldValue = { regions: [], decos: Decoration.none };

const MOD_LABEL =
  typeof navigator !== "undefined" && navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl+";

/** The removed lines for a region, shown as a red strikethrough block above the
 *  applied text (grouped at the region start — robust regardless of interleave). */
class DeletionWidget extends WidgetType {
  constructor(
    private readonly id: string,
    private readonly lines: readonly string[],
  ) {
    super();
  }

  eq(other: DeletionWidget): boolean {
    return other.id === this.id && other.lines.join("\n") === this.lines.join("\n");
  }

  toDOM(): HTMLElement {
    const block = document.createElement("div");
    block.className = "cm-ai-diff-del-block";
    block.setAttribute("aria-hidden", "true");
    for (const line of this.lines) {
      const row = document.createElement("div");
      row.className = "cm-ai-diff-del-line";
      // Non-breaking space keeps empty deleted lines visible (and struck).
      row.textContent = line.length ? line : " ";
      block.appendChild(row);
    }
    return block;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** The per-region Keep / Undo control, anchored just below the applied block. */
class DiffBarWidget extends WidgetType {
  constructor(private readonly id: string) {
    super();
  }

  eq(other: DiffBarWidget): boolean {
    return other.id === this.id;
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cm-ai-diff-bar";
    bar.contentEditable = "false";

    const undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.className = "cm-ai-diff-btn cm-ai-diff-btn-undo";
    undoBtn.textContent = `${m.ai_diff_undo()} (${MOD_LABEL}N)`;
    undoBtn.onclick = (e) => {
      e.preventDefault();
      undoAiDiff(view, this.id);
    };

    const keepBtn = document.createElement("button");
    keepBtn.type = "button";
    keepBtn.className = "cm-ai-diff-btn cm-ai-diff-btn-keep";
    keepBtn.textContent = `${m.ai_diff_keep()} (${MOD_LABEL}Y)`;
    keepBtn.onclick = (e) => {
      e.preventDefault();
      keepAiDiff(view, this.id);
    };

    bar.append(undoBtn, keepBtn);
    return bar;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function clamp(n: number, max: number): number {
  return n < 0 ? 0 : n > max ? max : n;
}

/** Build the decoration set for all live regions against the current doc. */
function buildDecos(regions: readonly AiDiffRegion[], state: EditorState): DecorationSet {
  const docLen = state.doc.length;
  const ranges: Range<Decoration>[] = [];

  for (const r of regions) {
    const from = clamp(r.from, docLen);
    const to = clamp(r.to, docLen);
    const startLineFrom = state.doc.lineAt(from).from;
    const startLineNo = state.doc.lineAt(from).number;

    // Deletions: one red block grouped at the region start.
    const delLines = r.ops.filter((o) => o.type === "del").map((o) => o.line);
    if (delLines.length) {
      ranges.push(
        Decoration.widget({
          widget: new DeletionWidget(r.id, delLines),
          block: true,
          side: -1,
        }).range(startLineFrom),
      );
    }

    // Additions: green background on each newly-added line. `k` walks the
    // new-side lines (equal + add) in order; `add` ops get the highlight.
    let k = 0;
    for (const op of r.ops) {
      if (op.type === "del") continue;
      if (op.type === "add") {
        const lineNo = Math.min(startLineNo + k, state.doc.lines);
        ranges.push(Decoration.line({ class: "cm-ai-diff-add" }).range(state.doc.line(lineNo).from));
      }
      k++;
    }

    // Action bar: below the applied block (side 1, after the last line).
    ranges.push(
      Decoration.widget({ widget: new DiffBarWidget(r.id), block: true, side: 1 }).range(
        state.doc.lineAt(to).to,
      ),
    );
  }

  return Decoration.set(ranges, true);
}

export const aiDiffField = StateField.define<FieldValue>({
  create() {
    return EMPTY;
  },
  update(value, tr) {
    let regions = value.regions;
    if (tr.docChanged && regions.length) {
      regions = regions.map((r) => ({
        ...r,
        from: tr.changes.mapPos(r.from, 1),
        to: tr.changes.mapPos(r.to, -1),
      }));
    }
    let touched = false;
    for (const e of tr.effects) {
      if (e.is(addAiDiff)) {
        regions = [...regions, e.value];
        touched = true;
      } else if (e.is(removeAiDiff)) {
        regions = regions.filter((r) => r.id !== e.value);
        touched = true;
      } else if (e.is(clearAiDiffs)) {
        regions = [];
        touched = true;
      }
    }
    if (!touched && !tr.docChanged) return value;
    if (regions.length === 0) return EMPTY;
    return { regions, decos: buildDecos(regions, tr.state) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

// ── Public helpers (driven by the editor's imperative API) ────────────────────

let diffSeq = 0;

/** Apply `find → replace` (first exact match) and overlay an inline diff for it.
 *  Snaps the change to whole lines so the diff renders line-aligned. */
export function proposeAiDiff(
  view: EditorView,
  find: string,
  replace: string,
): { ok: boolean; message: string } {
  if (!find) return { ok: false, message: "`find` is required." };
  const docText = view.state.doc.toString();
  const idx = docText.indexOf(find);
  if (idx < 0) return { ok: false, message: "The text to replace was not found in the document." };

  const rawFrom = idx;
  const rawTo = idx + find.length;
  const lineFrom = view.state.doc.lineAt(rawFrom).from;
  const lineTo = view.state.doc.lineAt(rawTo).to;
  const oldBlock = docText.slice(lineFrom, lineTo);
  const newBlock = docText.slice(lineFrom, rawFrom) + replace + docText.slice(rawTo, lineTo);

  if (oldBlock === newBlock) {
    return { ok: false, message: "The replacement is identical to the existing text." };
  }

  const id = `aidiff-${++diffSeq}`;
  view.dispatch({
    changes: { from: lineFrom, to: lineTo, insert: newBlock },
    effects: addAiDiff.of({
      id,
      from: lineFrom,
      to: lineFrom + newBlock.length,
      oldText: oldBlock,
      ops: diffLines(oldBlock, newBlock),
    }),
    selection: { anchor: lineFrom },
    scrollIntoView: true,
  });
  return {
    ok: true,
    message: `Edit applied inline. The user can Keep (${MOD_LABEL}Y) or Undo (${MOD_LABEL}N) it, or Keep all (${MOD_LABEL}↵).`,
  };
}

/** Keep a region: just drop its review decorations (the new text stays). */
export function keepAiDiff(view: EditorView, id: string): void {
  view.dispatch({ effects: removeAiDiff.of(id) });
}

/** Undo a region: restore its original block text and drop the decorations. */
export function undoAiDiff(view: EditorView, id: string): void {
  const region = view.state.field(aiDiffField, false)?.regions.find((r) => r.id === id);
  if (!region) return;
  view.dispatch({
    changes: { from: region.from, to: region.to, insert: region.oldText },
    effects: removeAiDiff.of(id),
    selection: { anchor: region.from },
  });
}

/** Keep every live region in one transaction. */
export function keepAllAiDiffs(view: EditorView): void {
  const ids = (view.state.field(aiDiffField, false)?.regions ?? []).map((r) => r.id);
  if (!ids.length) return;
  view.dispatch({ effects: ids.map((id) => removeAiDiff.of(id)) });
}

export function aiDiffCount(state: EditorState): number {
  return state.field(aiDiffField, false)?.regions.length ?? 0;
}

/** The region containing the cursor, else the nearest one, else null. */
export function nearestAiDiffId(state: EditorState): string | null {
  const regions = state.field(aiDiffField, false)?.regions ?? [];
  if (!regions.length) return null;
  const cur = state.selection.main.head;
  const containing = regions.find((r) => cur >= r.from && cur <= r.to);
  if (containing) return containing.id;
  let best = regions[0]!;
  let bestDist = Infinity;
  for (const r of regions) {
    const d = Math.min(Math.abs(cur - r.from), Math.abs(cur - r.to));
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best.id;
}
