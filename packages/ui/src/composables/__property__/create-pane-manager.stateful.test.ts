// Stateful property-based testing for createPaneManager. Defines a small
// algebra of commands (Split / Collapse / Focus / SetRatio / Open /
// Switch / WriteContent / CloseTab / MoveTab) and lets fast-check
// explore random sequences looking for an order that breaks an
// invariant.
//
// The unit tests in create-pane-manager.test.ts exercise each command
// in isolation; this suite finds bugs in the *interactions* between
// them — e.g. "split → focus 1 → collapse" leaves a stale active
// index pointing past the end of the panes array.
//
// Two cross-pane content invariants live here as well:
//
//   P1 (DJA-35) — switch-away-then-back preserves a tab's content.
//   Wiki Round 4 Lesson 3.
//
//   P2 (DJA-40) — for every tab surviving the sequence, the store's
//   editorContent equals the last value the user observed in that
//   tab (open / write / switch into / move-into). Wiki Round 4
//   Lesson 4. This is the regression locker for handleMoveTab's
//   `targetPane.tabs.updateActiveTabContent` — mutating that call
//   to a noop breaks P2 immediately after the first Move.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { createRoot } from "solid-js";
import type { FSEntry } from "@markdraw/core/types.ts";
import { installLocalStorageMock } from "@markdraw/core/test-utils.ts";
import { createPaneManager, type PaneManager } from "../create-pane-manager.ts";

installLocalStorageMock();

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

interface Cmd {
  apply: (m: PaneManager) => void;
  describe: () => string;
}

const splitCmd = fc.constant<Cmd>({
  apply: (m) => {
    m.splitFromActive();
  },
  describe: () => "split",
});

const collapseCmd = fc.constant<Cmd>({
  apply: (m) => {
    m.collapseRightPane();
  },
  describe: () => "collapse",
});

const focusCmd = fc.integer({ min: 0, max: 2 }).map<Cmd>((i) => ({
  apply: (m) => {
    m.setActivePane(i);
  },
  describe: () => `focus(${i})`,
}));

const setRatioCmd = fc.float({ min: 0, max: 1, noNaN: true }).map<Cmd>((r) => ({
  apply: (m) => {
    m.setSplitRatio(r);
  },
  describe: () => `setRatio(${r.toFixed(2)})`,
}));

const cmdArb = fc.oneof(splitCmd, collapseCmd, focusCmd, setRatioCmd);

function runCommands(cmds: Cmd[]): { manager: PaneManager; trace: string[] } {
  const manager = createPaneManager();
  const trace: string[] = [];
  for (const cmd of cmds) {
    cmd.apply(manager);
    trace.push(cmd.describe());
  }
  return { manager, trace };
}

describe("createPaneManager invariants under random command sequences", () => {
  it("INV-1: panes count stays in [1, 2] after any sequence", () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { minLength: 0, maxLength: 30 }), (cmds) => {
        const { manager, trace } = runCommands(cmds);
        const count = manager.panes().length;
        if (count < 1 || count > 2) {
          throw new Error(`panes count = ${count} after ${trace.join(", ")}`);
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it("INV-2: activePaneIndex is always a valid index into panes()", () => {
    // Mutation captured: a buggy collapse that decrements paneList
    // without clamping activeIndex would surface here as
    // `activePaneIndex >= panes.length`.
    fc.assert(
      fc.property(fc.array(cmdArb, { minLength: 0, maxLength: 30 }), (cmds) => {
        const { manager, trace } = runCommands(cmds);
        const idx = manager.activePaneIndex();
        const len = manager.panes().length;
        if (idx < 0 || idx >= len) {
          throw new Error(`activePaneIndex=${idx} out of [0, ${len}) after ${trace.join(", ")}`);
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it("INV-3: every pane has a unique paneId", () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { minLength: 0, maxLength: 30 }), (cmds) => {
        const { manager } = runCommands(cmds);
        const ids = manager.panes().map((p) => p.paneId);
        expect(new Set(ids).size).toBe(ids.length);
        return true;
      }),
      { numRuns: 50 },
    );
  });

  it("INV-4: splitRatio is always inside [0.1, 0.9]", () => {
    // Mutation captured: removing the clamp from `setSplitRatio` lets
    // the splitter collapse a pane to 0 width — the test fails the
    // moment a `setRatioCmd(0.05)` is generated.
    fc.assert(
      fc.property(fc.array(cmdArb, { minLength: 0, maxLength: 30 }), (cmds) => {
        const { manager } = runCommands(cmds);
        const r = manager.splitRatio();
        expect(r).toBeGreaterThanOrEqual(0.1);
        expect(r).toBeLessThanOrEqual(0.9);
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it("INV-5: activePane() always equals panes()[activePaneIndex()]", () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { minLength: 0, maxLength: 30 }), (cmds) => {
        const { manager } = runCommands(cmds);
        const expected = manager.panes()[manager.activePaneIndex()]!;
        expect(manager.activePane()).toBe(expected);
        return true;
      }),
      { numRuns: 50 },
    );
  });

  it("INV-6: collapseRightPane after split returns to a single-pane state", () => {
    // Stronger contract than the unit test: ANY trace ending with
    // `[split, collapse]` (back-to-back) must collapse to 1 pane,
    // regardless of what came before.
    fc.assert(
      fc.property(fc.array(cmdArb, { minLength: 0, maxLength: 20 }), (cmds) => {
        const { manager } = runCommands(cmds);
        // Reach split-then-collapse from whatever state we're in.
        manager.splitFromActive();
        manager.collapseRightPane();
        expect(manager.panes()).toHaveLength(1);
        expect(manager.activePaneIndex()).toBe(0);
        return true;
      }),
      { numRuns: 50 },
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Cross-pane content invariants (P1 / P2) — DJA-35 + DJA-40
// ───────────────────────────────────────────────────────────────────────────

const ROOT_ID = "r1";
const PANE_COUNT = 2;

function entry(name: string, path = name): FSEntry {
  return { name, path, kind: "file" };
}

/**
 * Oracle that tracks, for every tab id, the last content the user
 * observed in it (via Open, WriteContent, Switch-into, or Move). The
 * store must replay that same content whenever the tab is activated
 * — that's P1; and the per-tab snapshot inside TabState must carry
 * it whenever the tab is inactive — that's P2.
 */
interface ContentModel {
  lastObservedContent: Map<string, string>;
}

function emptyContentModel(): ContentModel {
  return { lastObservedContent: new Map() };
}

/**
 * Oracle key. Tab IDs are **pane-scoped**, not global: two panes
 * can each hold a tab whose id is `r1::app` with completely
 * different content. Keying the model on `tabId` alone collapses
 * those into a single entry and the second Open silently
 * overwrites the first pane's record, surfacing as a false P1/P2
 * failure on the next assert. Composite key keeps the panes
 * isolated in the model the same way they are in the manager.
 */
function oracleKey(paneId: string, tabId: string): string {
  return `${paneId}|${tabId}`;
}

interface ContentCmd {
  apply: (mgr: PaneManager, model: ContentModel) => void;
  describe: () => string;
}

const fileNameArb = fc
  .string({ minLength: 1, maxLength: 6 })
  .filter((s) => !s.includes(":") && !s.includes(" "));
const contentArb = fc.string({ minLength: 0, maxLength: 16 });
const paneIndexArb = fc.integer({ min: 0, max: PANE_COUNT - 1 });

function ensureSecondPane(mgr: PaneManager): void {
  if (mgr.panes().length < PANE_COUNT) mgr.splitFromActive();
}

const openCmd = fc
  .record({ name: fileNameArb, paneIdx: paneIndexArb, content: contentArb })
  .map<ContentCmd>(({ name, paneIdx, content }) => ({
    apply: (mgr, model) => {
      ensureSecondPane(mgr);
      const targetPane = mgr.panes()[paneIdx];
      if (!targetPane) return;
      mgr.setActivePane(paneIdx);
      // openTab returns the actual tab id. It generates a unique
      // suffix (`r1::name#2`) when the same path is opened a second
      // time, so we MUST capture the return value — deriving the id
      // from the name only works for the first open and corrupts
      // the oracle on duplicate-name sequences (the model would
      // overwrite the original tab's record instead of tracking the
      // newly-created duplicate).
      const tabId = targetPane.tabs.openTab(entry(name), ROOT_ID);
      // Mirror what the editor would do: push the content into both
      // the live signal and the underlying TabState snapshot.
      targetPane.setEditorContent(content);
      targetPane.tabs.updateActiveTabContent({ editorContent: content });
      model.lastObservedContent.set(oracleKey(targetPane.paneId, tabId), content);
    },
    describe: () => `Open(${name}, p${paneIdx}, "${content}")`,
  }));

const switchCmd = fc
  .record({ paneIdx: paneIndexArb, slot: fc.integer({ min: 0, max: 8 }) })
  .map<ContentCmd>(({ paneIdx, slot }) => ({
    apply: (mgr, model) => {
      ensureSecondPane(mgr);
      const pane = mgr.panes()[paneIdx];
      if (!pane) return;
      const tabs = pane.tabs.tabs();
      if (tabs.length === 0) return;
      const tab = tabs[slot % tabs.length]!;
      mgr.setActivePane(paneIdx);
      pane.tabs.activateTab(tab.id);
      // Activation restores the TabState snapshot into the pane's
      // live signal. The oracle records what the user now sees so
      // a subsequent WriteContent — without re-observing this tab —
      // doesn't drift.
      model.lastObservedContent.set(oracleKey(pane.paneId, tab.id), pane.editorContent());
    },
    describe: () => `Switch(p${paneIdx}, slot${slot})`,
  }));

const writeContentCmd = fc.record({ content: contentArb }).map<ContentCmd>(({ content }) => ({
  apply: (mgr, model) => {
    const pane = mgr.activePane();
    const activeId = pane.tabs.activeTabId();
    if (!activeId) return;
    pane.setEditorContent(content);
    pane.tabs.updateActiveTabContent({ editorContent: content });
    model.lastObservedContent.set(oracleKey(pane.paneId, activeId), content);
  },
  describe: () => `WriteContent("${content}")`,
}));

const closeActiveCmd = fc.record({ paneIdx: paneIndexArb }).map<ContentCmd>(({ paneIdx }) => ({
  apply: (mgr, model) => {
    ensureSecondPane(mgr);
    const pane = mgr.panes()[paneIdx];
    if (!pane) return;
    const id = pane.tabs.activeTabId();
    if (!id) return;
    mgr.setActivePane(paneIdx);
    pane.tabs.closeTab(id);
    // Closed tab leaves the oracle (no claim once it's gone). The
    // nearest sibling becomes active — `closeTab` already restored
    // its TabState snapshot into the pane's live signal, so the
    // oracle's previous record for that tab still holds.
    model.lastObservedContent.delete(oracleKey(pane.paneId, id));
  },
  describe: () => `Close(p${paneIdx})`,
}));

const moveActiveCmd = fc.record({ fromPaneIdx: paneIndexArb }).map<ContentCmd>(({ fromPaneIdx }) => ({
  apply: (mgr, model) => {
    ensureSecondPane(mgr);
    const panes = mgr.panes();
    const sourcePane = panes[fromPaneIdx];
    const targetIdx = fromPaneIdx === 0 ? 1 : 0;
    const targetPane = panes[targetIdx];
    if (!sourcePane || !targetPane) return;
    const sourceActiveId = sourcePane.tabs.activeTabId();
    if (!sourceActiveId) return;
    const movedTab = sourcePane.tabs.getTab(sourceActiveId);
    if (!movedTab) return;
    const snapshotContent = movedTab.editorContent;
    // Replays handleMoveTab from app.tsx: activate target, openTab,
    // push the snapshot into the new TabState, close source.
    mgr.setActivePane(targetIdx);
    // Capture the returned tab id — when target already had a tab
    // with the same filePath, openTab creates `path#N` instead of
    // reusing `path`. Without capturing this, the model would set
    // the source's now-closed id and silently overwrite the
    // target's pre-existing tab entry, which then trips P2 on the
    // very next assertion.
    const newTabId = targetPane.tabs.openTab(
      entry(movedTab.fileName, movedTab.filePath),
      movedTab.rootId,
    );
    targetPane.tabs.updateActiveTabContent({ editorContent: snapshotContent });
    targetPane.setEditorContent(snapshotContent);
    sourcePane.tabs.closeTab(sourceActiveId);
    // Oracle bookkeeping: source's id is gone; target gets the
    // moved content under whichever id openTab returned.
    model.lastObservedContent.delete(oracleKey(sourcePane.paneId, sourceActiveId));
    model.lastObservedContent.set(oracleKey(targetPane.paneId, newTabId), snapshotContent);
  },
  describe: () => `Move(p${fromPaneIdx}->p${fromPaneIdx === 0 ? 1 : 0})`,
}));

const contentCmdArb = fc.oneof(
  { weight: 4, arbitrary: openCmd },
  { weight: 4, arbitrary: switchCmd },
  { weight: 3, arbitrary: writeContentCmd },
  { weight: 2, arbitrary: closeActiveCmd },
  { weight: 2, arbitrary: moveActiveCmd },
);

function assertP2(mgr: PaneManager, model: ContentModel, trace: string[]): void {
  // The check probes the TabState snapshot directly (NOT the live
  // signal) because the snapshot is the source of truth for any
  // future activateTab — and that snapshot is what
  // `updateActiveTabContent` exists to maintain. The signal can
  // happen to carry the right content even when the snapshot is
  // stale (the move flow sets both); only the snapshot reveals the
  // mutation. For the active tab we also cross-check the signal so
  // a regression that decouples the signal from the snapshot still
  // surfaces.
  for (let p = 0; p < PANE_COUNT; p += 1) {
    const pane = mgr.panes()[p];
    if (!pane) continue;
    for (const tab of pane.tabs.tabs()) {
      const expected = model.lastObservedContent.get(oracleKey(pane.paneId, tab.id));
      if (expected === undefined) continue;
      const snapshotted = tab.editorContent;
      if (snapshotted !== expected) {
        throw new Error(
          `P2 broken (snapshot) — tab=${tab.id} pane=p${p} expected="${expected}" got="${snapshotted}" trace=[${trace.join(", ")}]`,
        );
      }
      if (tab.id === pane.tabs.activeTabId()) {
        const live = pane.editorContent();
        if (live !== expected) {
          throw new Error(
            `P2 broken (signal) — tab=${tab.id} pane=p${p} expected="${expected}" got="${live}" trace=[${trace.join(", ")}]`,
          );
        }
      }
    }
  }
}

describe("createPaneManager — cross-pane content invariants (DJA-35 + DJA-40)", () => {
  beforeEach(() => localStorage.clear());

  it("P1 — switching away then back yields the same content for every tab (DJA-35)", () => {
    // Mutation captured: pointing `updateActiveTabContent` at a noop
    // means the new content never persists into the TabState
    // snapshot, so the next `activateTab` restores the previous
    // (often empty) value and this assertion fails for any non-empty
    // content written via Open or WriteContent.
    fc.assert(
      fc.property(fc.array(contentCmdArb, { minLength: 2, maxLength: 20 }), (cmds) => {
        localStorage.clear();
        return createRoot(() => {
          const mgr = createPaneManager();
          const model = emptyContentModel();
          const trace: string[] = [];
          for (const cmd of cmds) {
            cmd.apply(mgr, model);
            trace.push(cmd.describe());
          }
          // After the sequence, probe every (pane, tab) pair with an
          // explicit switch-away-then-back: activate the tab, read
          // editorContent, compare to the oracle.
          for (let p = 0; p < PANE_COUNT; p += 1) {
            const pane = mgr.panes()[p];
            if (!pane) continue;
            const tabs = pane.tabs.tabs();
            if (tabs.length === 0) continue;
            const originalActive = pane.tabs.activeTabId();
            for (const tab of tabs) {
              const expected = model.lastObservedContent.get(oracleKey(pane.paneId, tab.id));
              if (expected === undefined) continue;
              mgr.setActivePane(p);
              pane.tabs.activateTab(tab.id);
              const observed = pane.editorContent();
              if (observed !== expected) {
                throw new Error(
                  `P1 broken — pane=p${p} tab=${tab.id} expected="${expected}" got="${observed}" trace=[${trace.join(", ")}]`,
                );
              }
            }
            if (originalActive) pane.tabs.activateTab(originalActive);
          }
          return true;
        });
      }),
      { numRuns: 120 },
    );
  });

  it("P2 — content faithfulness holds after every step end-to-end (DJA-40)", () => {
    // Strictly stronger form of P1. Instead of probing once at the
    // end, P2 runs after every command so a mutation that corrupts
    // content *during* a non-switch step (the snapshot inside
    // handleMoveTab is the canonical example) gets pinned at the
    // exact command that broke it.
    fc.assert(
      fc.property(fc.array(contentCmdArb, { minLength: 1, maxLength: 25 }), (cmds) => {
        localStorage.clear();
        return createRoot(() => {
          const mgr = createPaneManager();
          const model = emptyContentModel();
          const trace: string[] = [];
          for (const cmd of cmds) {
            cmd.apply(mgr, model);
            trace.push(cmd.describe());
            assertP2(mgr, model, trace);
          }
          return true;
        });
      }),
      { numRuns: 120 },
    );
  });
});
