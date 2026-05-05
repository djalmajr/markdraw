import { createSignal } from "solid-js";
import { createPaneStore, type PaneStore } from "./create-pane-store.ts";

/**
 * Single pane = single column. Two panes = vertical split with the
 * splitter handle between them. We cap at 2 by design (per the plan
 * doc); the limit is enforced inside `splitFromActive`. Going to 3+
 * would also force a redesign of `activePaneIndex` (currently a
 * 0|1 flag) and the layout in `AppShell`.
 */
const MAX_PANES = 2;

const DEFAULT_SPLIT_RATIO = 0.5;
const SPLIT_RATIO_STORAGE_KEY = "asciimark-pane-split-ratio";
/** Constrain the splitter so neither pane collapses to 0px (the user
 *  could still close the pane via Cmd/Ctrl+W to dismiss it). */
const MIN_SPLIT_RATIO = 0.1;
const MAX_SPLIT_RATIO = 0.9;

export interface PaneManager {
  panes: () => PaneStore[];
  activePaneIndex: () => number;
  /** Convenience accessor — equivalent to `panes()[activePaneIndex()]`. */
  activePane: () => PaneStore;
  setActivePane: (index: number) => void;

  splitRatio: () => number;
  setSplitRatio: (value: number) => void;

  /** Cmd/Ctrl+\ — open a second pane next to the active one. The new
   *  pane starts with no tabs; the host wires `splitFromActive` to
   *  hand the active tab a copy. No-op when already at MAX_PANES. */
  splitFromActive: () => boolean;

  /** Close the right pane and re-collapse to single-pane. Caller is
   *  responsible for closing the right pane's tabs first (or
   *  forwarding them to the closed-tabs stack). */
  collapseRightPane: () => void;
}

export interface PaneManagerConfig {
  /** Optional initial split ratio (0..1). Used by session restore so the
   *  splitter stays where the user left it. Defaults to the persisted
   *  value (or `DEFAULT_SPLIT_RATIO` if there isn't one). */
  initialSplitRatio?: number;
}

export function createPaneManager(config: PaneManagerConfig = {}): PaneManager {
  const [paneList, setPaneList] = createSignal<PaneStore[]>([
    createPaneStore("pane-0"),
  ]);
  const [activeIndex, setActiveIndex] = createSignal(0);

  const initialRatio = clamp(
    config.initialSplitRatio ?? readStoredSplitRatio() ?? DEFAULT_SPLIT_RATIO,
  );
  const [splitRatio, setSplitRatioInternal] = createSignal(initialRatio);

  // Plain function (not `createMemo`) so the index lookup re-runs on
  // every call. Solid still subscribes to `paneList` and `activeIndex`
  // for any consumer that reads `activePane()` inside a tracking
  // context (component, effect, memo). createMemo here would freeze
  // the first computed value when read outside a reactive root —
  // exactly the situation the bun:test domain tests run in.
  const activePane = (): PaneStore => {
    const list = paneList();
    const idx = activeIndex();
    return list[Math.min(Math.max(0, idx), list.length - 1)] ?? list[0]!;
  };

  function setActivePane(index: number) {
    const list = paneList();
    if (index < 0 || index >= list.length) return;
    setActiveIndex(index);
  }

  function setSplitRatio(value: number) {
    const next = clamp(value);
    setSplitRatioInternal(next);
    writeStoredSplitRatio(next);
  }

  function splitFromActive(): boolean {
    const list = paneList();
    if (list.length >= MAX_PANES) return false;

    const newPane = createPaneStore(`pane-${list.length}`);
    setPaneList([...list, newPane]);
    // The newly opened pane becomes active so subsequent file-tree
    // clicks land there, matching VS Code's split-and-focus behavior.
    setActiveIndex(list.length);
    return true;
  }

  function collapseRightPane(): void {
    const list = paneList();
    if (list.length <= 1) return;
    setPaneList(list.slice(0, list.length - 1));
    // Active index is clamped on next access via `activePane()`, but
    // also reset explicitly so the focus class flips immediately.
    if (activeIndex() >= list.length - 1) setActiveIndex(list.length - 2);
  }

  return {
    panes: paneList,
    activePaneIndex: activeIndex,
    activePane,
    setActivePane,
    splitRatio,
    setSplitRatio,
    splitFromActive,
    collapseRightPane,
  };
}

function clamp(ratio: number): number {
  if (Number.isNaN(ratio)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

function readStoredSplitRatio(): number | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    const raw = localStorage.getItem(SPLIT_RATIO_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredSplitRatio(value: number): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(value));
  } catch {
    // Quota / privacy mode — silently drop; non-essential.
  }
}
