// Minimal line-level diff for the AI inline-edit review (Cursor-style Keep/Undo).
// Pure and engine-agnostic — the UI maps these ops onto CodeMirror decorations.
//
// Emits a linear sequence aligned to the NEW-side reading order, with deletions
// inserted at the position they were removed from. An LCS backtrace gives the
// minimal set of `equal` lines; everything else is a `del` (old only) or `add`
// (new only). For pathologically large blocks we skip the O(n·m) table and fall
// back to a single delete-all + add-all (still correct, just not minimal).

/** One line-level diff step. `line` is the line's text (no trailing newline). */
export type DiffOp =
  | { readonly type: "equal"; readonly line: string }
  | { readonly type: "del"; readonly line: string }
  | { readonly type: "add"; readonly line: string };

/** Above this many lines on either side we skip the LCS table (memory/time
 *  guard) and emit a coarse replace. Edit blocks are normally tiny. */
const MAX_LCS_LINES = 600;

/**
 * Diff two blocks of text line-by-line. Splitting on "\n" means a trailing
 * newline yields a final empty line on both sides (it diffs as `equal`), which
 * is what we want for block-aligned edits.
 */
export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;

  if (n > MAX_LCS_LINES || m > MAX_LCS_LINES) {
    return [
      ...a.map((line): DiffOp => ({ type: "del", line })),
      ...b.map((line): DiffOp => ({ type: "add", line })),
    ];
  }

  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "del", line: a[i]! });
      i++;
    } else {
      ops.push({ type: "add", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", line: a[i++]! });
  while (j < m) ops.push({ type: "add", line: b[j++]! });
  return ops;
}

/** Count of changed (non-equal) ops — handy for "N changes" labels/guards. */
export function countChanges(ops: readonly DiffOp[]): number {
  return ops.reduce((acc, op) => (op.type === "equal" ? acc : acc + 1), 0);
}
