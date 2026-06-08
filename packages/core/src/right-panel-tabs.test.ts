import { beforeEach, describe, expect, it } from "bun:test";
import {
  RIGHT_PANEL_TABS_KEY,
  defaultRightPanelTabsState,
  getRightPanelTabsState,
  setRightPanelTabsState,
} from "./right-panel-tabs.ts";
import { installLocalStorageMock } from "./test-utils.ts";

installLocalStorageMock();

describe("right-panel-tabs persistence", () => {
  beforeEach(() => localStorage.clear());

  it("returns null when nothing is stored", () => {
    expect(getRightPanelTabsState()).toBeNull();
  });

  it("round-trips a full state", () => {
    const state = {
      toc: { open: true, pinned: true, openedAt: 1000 },
      backlinks: { open: false, pinned: false, openedAt: 0 },
      activeTab: "toc",
    };
    setRightPanelTabsState(state);
    expect(getRightPanelTabsState()).toEqual(state);
  });

  it("fills defaults for a partial/old blob (lenient read)", () => {
    localStorage.setItem(RIGHT_PANEL_TABS_KEY, JSON.stringify({ toc: { open: true } }));
    const got = getRightPanelTabsState();
    expect(got).toEqual({
      toc: { open: true, pinned: false, openedAt: 0 },
      backlinks: { open: false, pinned: false, openedAt: 0 },
      activeTab: "",
    });
  });

  it("falls back to defaults on a completely empty object", () => {
    localStorage.setItem(RIGHT_PANEL_TABS_KEY, "{}");
    expect(getRightPanelTabsState()).toEqual(defaultRightPanelTabsState());
  });

  it("returns null on corrupt JSON", () => {
    localStorage.setItem(RIGHT_PANEL_TABS_KEY, "{not json");
    expect(getRightPanelTabsState()).toBeNull();
  });
});
