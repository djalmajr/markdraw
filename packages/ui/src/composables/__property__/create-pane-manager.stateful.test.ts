// Stateful property-based testing for createPaneManager. Defines a small
// algebra of commands (Split / Collapse / Focus / SetRatio) and lets
// fast-check explore random sequences looking for an order that
// breaks an invariant.
//
// The unit tests in create-pane-manager.test.ts exercise each command
// in isolation; this suite finds bugs in the *interactions* between
// them — e.g. "split → focus 1 → collapse" leaves a stale active
// index pointing past the end of the panes array.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { installLocalStorageMock } from "@asciimark/core/test-utils.ts";
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
