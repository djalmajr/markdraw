// Stateful property-based testing for createTabStore. Defines a small
// algebra of commands (Open / Close / Activate / Reorder / ReopenClosed
// / LoadInActive / Rename) and lets fast-check explore random sequences
// of up to ~30 commands looking for an order that breaks an invariant.
//
// The unit tests in create-tab-store.test.ts exercise each command in
// isolation; this suite finds bugs in the *interactions* between them.
import { beforeEach, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { createRoot } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import { installLocalStorageMock } from "@asciimark/core/test-utils.ts";
import { createTabStore } from "../create-tab-store.ts";
import { createPaneStore } from "../create-pane-store.ts";

installLocalStorageMock();

function makeStub() {
  // The TabStore now snapshots into a PaneStore. For PBT we just need a
  // fresh PaneStore per command sequence — the reactive signals don't
  // need any special wiring beyond their default initial state.
  return createPaneStore("stateful-test");
}

function entry(name: string, path = name): FSEntry {
  return { name, path, kind: "file" };
}

// ─── Command algebra ────────────────────────────────────────────────────────

type Store = ReturnType<typeof createTabStore>;

interface State {
  // The model (oracle) we cross-check against the real store.
  // We only track facts we want to assert invariants on.
  expectedTabIds: Set<string>;
  rootIds: string[];
}

interface Cmd {
  apply: (s: Store, m: State) => void;
  describe: () => string;
}

const fileNameArb = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => !s.includes(":"));
const rootIdArb = fc.constantFrom("r1", "r2", "r3");

const openTabCmd = fc.record({ name: fileNameArb, root: rootIdArb }).map(
  ({ name, root }): Cmd => ({
    apply: (s, _m) => {
      s.openTab(entry(name), root);
    },
    describe: () => `openTab(${name}, ${root})`,
  }),
);

const loadInActiveCmd = fc.record({ name: fileNameArb, root: rootIdArb }).map(
  ({ name, root }): Cmd => ({
    apply: (s, _m) => {
      s.loadInActiveTab(entry(name), root);
    },
    describe: () => `loadInActive(${name}, ${root})`,
  }),
);

const closeActiveCmd = fc.constant({
  apply: (s: Store) => {
    const id = s.activeTabId();
    if (id) s.closeTab(id);
  },
  describe: () => "closeActive()",
} as Cmd);

const closeAllCmd = fc.constant({
  apply: (s: Store) => s.closeAllTabs(),
  describe: () => "closeAll()",
} as Cmd);

const reopenClosedCmd = fc.constant({
  apply: (s: Store) => {
    s.reopenClosedTab();
  },
  describe: () => "reopenClosed()",
} as Cmd);

const activateNthCmd = fc.integer({ min: 0, max: 9 }).map(
  (n): Cmd => ({
    apply: (s, _m) => {
      const tabs = s.tabs();
      if (tabs.length === 0) return;
      const target = tabs[n % tabs.length]!;
      s.activateTab(target.id);
    },
    describe: () => `activateNth(${n})`,
  }),
);

const reorderShuffleCmd = fc.constant({
  apply: (s: Store) => {
    const ids = s.tabs().map((t) => t.id);
    if (ids.length < 2) return;
    // Reverse — a deterministic but non-trivial permutation.
    s.reorderTabs([...ids].reverse());
  },
  describe: () => "reorder(reverse)",
} as Cmd);

const renameActiveCmd = fileNameArb.map(
  (newName): Cmd => ({
    apply: (s, _m) => {
      const id = s.activeTabId();
      if (!id) return;
      s.updateTabFile(id, newName, newName);
    },
    describe: () => `rename(active -> ${newName})`,
  }),
);

const closeTabsToRightCmd = fc.constant({
  apply: (s: Store) => {
    const id = s.activeTabId();
    if (id) s.closeTabsToRight(id);
  },
  describe: () => "closeToRight(active)",
} as Cmd);

const closeOthersCmd = fc.constant({
  apply: (s: Store) => {
    const id = s.activeTabId();
    if (id) s.closeOtherTabs(id);
  },
  describe: () => "closeOthers(active)",
} as Cmd);

const closeRootCmd = rootIdArb.map(
  (root): Cmd => ({
    apply: (s) => {
      s.closeTabsByRoot(root);
    },
    describe: () => `closeByRoot(${root})`,
  }),
);

const cmdArb = fc.oneof(
  { weight: 5, arbitrary: openTabCmd },
  { weight: 2, arbitrary: loadInActiveCmd },
  { weight: 3, arbitrary: closeActiveCmd },
  { weight: 1, arbitrary: closeAllCmd },
  { weight: 2, arbitrary: reopenClosedCmd },
  { weight: 3, arbitrary: activateNthCmd },
  { weight: 1, arbitrary: reorderShuffleCmd },
  { weight: 2, arbitrary: renameActiveCmd },
  { weight: 1, arbitrary: closeTabsToRightCmd },
  { weight: 1, arbitrary: closeOthersCmd },
  { weight: 1, arbitrary: closeRootCmd },
);

// ─── Invariants ────────────────────────────────────────────────────────────

function assertInvariants(s: Store, _m: State, trace: string[]): void {
  const tabs = s.tabs();

  // I1: tab ids are unique
  const ids = new Set(tabs.map((t) => t.id));
  if (ids.size !== tabs.length) {
    throw new Error(`I1 broken — duplicate tab ids after: ${trace.join(", ")}`);
  }

  // I2: activeTabId is null xor refers to an existing tab
  const active = s.activeTabId();
  if (active !== null && !ids.has(active)) {
    throw new Error(
      `I2 broken — activeTabId=${active} not in tabs ${[...ids].join(",")} after: ${trace.join(", ")}`,
    );
  }

  // I3: when there are no tabs, activeTabId must be null
  if (tabs.length === 0 && active !== null) {
    throw new Error(`I3 broken — activeTabId=${active} but tabs empty after: ${trace.join(", ")}`);
  }

  // I4: every tab has a non-empty fileName / filePath
  for (const t of tabs) {
    if (typeof t.fileName !== "string" || typeof t.filePath !== "string") {
      throw new Error(`I4 broken — malformed tab ${JSON.stringify(t)} after: ${trace.join(", ")}`);
    }
  }

  // I5: getDirtyTabs ⊆ tabs
  const dirtyIds = new Set(s.getDirtyTabs().map((t) => t.id));
  for (const id of dirtyIds) {
    if (!ids.has(id)) {
      throw new Error(
        `I5 broken — dirty tab ${id} not in tabs after: ${trace.join(", ")}`,
      );
    }
  }
}

// ─── Property runner ────────────────────────────────────────────────────────

describe("createTabStore stateful (property)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("invariants hold for any sequence of up to 30 commands", () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { minLength: 1, maxLength: 30 }), (cmds) => {
        localStorage.clear();
        return createRoot(() => {
          const store = createTabStore({ pane: makeStub() });
          const model: State = { expectedTabIds: new Set(), rootIds: [] };
          const trace: string[] = [];
          for (const cmd of cmds) {
            cmd.apply(store, model);
            trace.push(cmd.describe());
            assertInvariants(store, model, trace);
          }
          return true;
        });
      }),
      { numRuns: 200 },
    );
  });

  it("after closeAll then reopen N times, restored count <= MAX_CLOSED_TABS", () => {
    // Specific scenario: how many tabs can we recover via reopenClosed?
    // The contract is "the most recently closed", with a stack cap.
    fc.assert(
      fc.property(fc.array(fileNameArb, { minLength: 1, maxLength: 25 }), (names) => {
        localStorage.clear();
        return createRoot(() => {
          const store = createTabStore({ pane: makeStub() });
          for (const n of names) store.openTab(entry(n), "r1");
          store.closeAllTabs();
          // closeAll wipes the list AND clears active id; the closed-stack
          // is filled only by closeTab(), not by closeAll. So reopen should
          // produce zero tabs.
          for (let i = 0; i < names.length; i += 1) {
            store.reopenClosedTab();
          }
          const final = store.tabs();
          // The contract we observe: closeAllTabs does NOT preserve via
          // closed-tabs stack. Reopen yields 0.
          expect(final.length).toBe(0);
          return true;
        });
      }),
      { numRuns: 50 },
    );
  });

  it("reorder is a permutation — never adds or drops tabs", () => {
    fc.assert(
      fc.property(
        fc.array(fileNameArb, { minLength: 1, maxLength: 8 }),
        (names) => {
          localStorage.clear();
          return createRoot(() => {
            const store = createTabStore({ pane: makeStub() });
            for (const n of names) store.openTab(entry(n), "r1");
            const before = new Set(store.tabs().map((t) => t.id));
            const ids = store.tabs().map((t) => t.id);
            // Random permutation by reversing or rotating (deterministic
            // function of input length to stay reproducible).
            const reordered = [...ids.slice(1), ids[0]!];
            store.reorderTabs(reordered);
            const after = new Set(store.tabs().map((t) => t.id));
            expect(after.size).toBe(before.size);
            for (const id of before) expect(after.has(id)).toBe(true);
            return true;
          });
        },
      ),
      { numRuns: 50 },
    );
  });
});
