import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installLocalStorageMock } from "@markdraw/core/test-utils.ts";
import { createPaneManager } from "./create-pane-manager.ts";

installLocalStorageMock();

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("createPaneManager", () => {
  it("starts with a single pane, active index 0, default split ratio 0.5", () => {
    const m = createPaneManager();
    expect(m.panes()).toHaveLength(1);
    expect(m.activePaneIndex()).toBe(0);
    expect(m.activePane()).toBe(m.panes()[0]!);
    expect(m.splitRatio()).toBe(0.5);
  });

  it("splitFromActive adds a second pane and focuses it", () => {
    const m = createPaneManager();
    expect(m.splitFromActive()).toBe(true);
    expect(m.panes()).toHaveLength(2);
    expect(m.activePaneIndex()).toBe(1);
    expect(m.activePane()).toBe(m.panes()[1]!);
  });

  it("splitFromActive is idempotent at MAX_PANES — third call is a no-op", () => {
    // Mutation captured: replacing `>= MAX_PANES` with `>` would let a
    // third pane through and the assertion below fails.
    const m = createPaneManager();
    expect(m.splitFromActive()).toBe(true);
    expect(m.splitFromActive()).toBe(false);
    expect(m.panes()).toHaveLength(2);
  });

  it("collapseRightPane removes the right pane and resets the active index", () => {
    const m = createPaneManager();
    m.splitFromActive();
    expect(m.panes()).toHaveLength(2);
    expect(m.activePaneIndex()).toBe(1);

    m.collapseRightPane();
    expect(m.panes()).toHaveLength(1);
    expect(m.activePaneIndex()).toBe(0);
  });

  it("collapseRightPane on a single-pane workspace is a no-op", () => {
    const m = createPaneManager();
    m.collapseRightPane();
    expect(m.panes()).toHaveLength(1);
  });

  it("setActivePane only accepts valid indices", () => {
    const m = createPaneManager();
    m.splitFromActive();

    m.setActivePane(0);
    expect(m.activePaneIndex()).toBe(0);
    m.setActivePane(1);
    expect(m.activePaneIndex()).toBe(1);

    // Out-of-range values are silently dropped — keeps the focus
    // contract (`activePaneIndex() < panes().length`) safe even when
    // the host fires a stale Cmd+2 right after a collapse.
    m.setActivePane(2);
    expect(m.activePaneIndex()).toBe(1);
    m.setActivePane(-1);
    expect(m.activePaneIndex()).toBe(1);
  });

  it("split ratio is clamped to [0.1, 0.9] so neither pane collapses to 0", () => {
    // Mutation captured: removing the `clamp` would let the user push
    // the splitter to 0 (invisible right pane) and the test below fails.
    const m = createPaneManager();
    m.setSplitRatio(0.05);
    expect(m.splitRatio()).toBe(0.1);
    m.setSplitRatio(0.95);
    expect(m.splitRatio()).toBe(0.9);
    m.setSplitRatio(0.42);
    expect(m.splitRatio()).toBe(0.42);
  });

  it("split ratio NaN falls back to the default", () => {
    const m = createPaneManager();
    m.setSplitRatio(Number.NaN);
    expect(m.splitRatio()).toBe(0.5);
  });

  it("split ratio persists to localStorage and is restored on next manager", () => {
    const m1 = createPaneManager();
    m1.setSplitRatio(0.32);
    const m2 = createPaneManager();
    expect(m2.splitRatio()).toBe(0.32);
  });

  it("explicit initialSplitRatio in config overrides the persisted value", () => {
    localStorage.setItem("markdraw-pane-split-ratio", "0.32");
    const m = createPaneManager({ initialSplitRatio: 0.7 });
    expect(m.splitRatio()).toBe(0.7);
  });

  it("each pane owns independent state (regression: setSelectedFile on pane 1 leaks)", () => {
    const m = createPaneManager();
    m.splitFromActive();
    const [left, right] = m.panes();

    left!.setEditorContent("left content");
    left!.setEditorMode("edit");
    right!.setEditorContent("right content");

    expect(left!.editorContent()).toBe("left content");
    expect(right!.editorContent()).toBe("right content");
    expect(left!.editorMode()).toBe("edit");
    expect(right!.editorMode()).toBe("preview");
  });

  it("activePane() reactively follows setActivePane", () => {
    const m = createPaneManager();
    m.splitFromActive();
    m.setActivePane(0);
    expect(m.activePane().paneId).toBe("pane-0");
    m.setActivePane(1);
    expect(m.activePane().paneId).toBe("pane-1");
  });

  it("layout persists: paneCount + activePaneIndex are restored on next manager", () => {
    // Mutation captured: removing the `persistLayout()` call inside
    // `splitFromActive` (or `setActivePane`) leaves the second manager
    // restored as single-pane / index 0 — fails this assertion.
    const m1 = createPaneManager();
    m1.splitFromActive();
    m1.setActivePane(1);
    expect(m1.panes()).toHaveLength(2);
    expect(m1.activePaneIndex()).toBe(1);

    const m2 = createPaneManager();
    expect(m2.panes()).toHaveLength(2);
    expect(m2.activePaneIndex()).toBe(1);
  });

  it("collapseRightPane shrinks the persisted layout back to single-pane", () => {
    const m1 = createPaneManager();
    m1.splitFromActive();
    expect(m1.panes()).toHaveLength(2);
    m1.collapseRightPane();
    expect(m1.panes()).toHaveLength(1);

    const m2 = createPaneManager();
    expect(m2.panes()).toHaveLength(1);
    expect(m2.activePaneIndex()).toBe(0);
  });

  it("invalid persisted layout (paneCount=99) is ignored — falls back to single pane", () => {
    localStorage.setItem(
      "markdraw-pane-layout",
      JSON.stringify({ paneCount: 99, activePaneIndex: 5 }),
    );
    const m = createPaneManager();
    expect(m.panes()).toHaveLength(1);
    expect(m.activePaneIndex()).toBe(0);
  });
});
