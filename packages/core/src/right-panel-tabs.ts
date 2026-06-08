// Persistence for the right-panel tab strip UI state: which special panes
// (Outline / References) are currently open + pinned (and when they were
// opened, for left-to-right ordering), plus the encoded active tab. Chat
// sessions persist separately (`ai-chat-sessions.ts`); this module only covers
// the special tabs and the active-tab pointer so the strip restores on restart.
//
// All fields are optional-with-default so a partial/old/corrupt blob still
// parses into a usable state (lenient-on-read, like the rest of core).

import * as v from "valibot";
import { safeJsonParse } from "./schemas.ts";

const STORAGE_KEY = "asciimark-right-panel-tabs";

/** A special (non-chat) right-panel tab: the Outline or the References pane. */
const SpecialTabStateSchema = v.object({
  /** Whether the tab chip is shown in the strip (the pane is always mounted). */
  open: v.optional(v.boolean(), false),
  /** Pinned tabs sort left and resist bulk close. */
  pinned: v.optional(v.boolean(), false),
  /** Epoch ms when the tab was opened — the left-to-right order key. */
  openedAt: v.optional(v.number(), 0),
});

const RightPanelTabsStateSchema = v.object({
  toc: v.optional(SpecialTabStateSchema, { open: false, pinned: false, openedAt: 0 }),
  backlinks: v.optional(SpecialTabStateSchema, { open: false, pinned: false, openedAt: 0 }),
  /** Encoded active tab: "toc" | "backlinks" | "chat:<id>" | "" (none). */
  activeTab: v.optional(v.string(), ""),
});

type SpecialTabState = v.InferOutput<typeof SpecialTabStateSchema>;
type RightPanelTabsState = v.InferOutput<typeof RightPanelTabsStateSchema>;

/** A fresh, no-specials-open default (the AI chat is the default open tab). */
function defaultRightPanelTabsState(): RightPanelTabsState {
  return {
    toc: { open: false, pinned: false, openedAt: 0 },
    backlinks: { open: false, pinned: false, openedAt: 0 },
    activeTab: "",
  };
}

function getRightPanelTabsState(): RightPanelTabsState | null {
  return safeJsonParse(localStorage.getItem(STORAGE_KEY), RightPanelTabsStateSchema);
}

function setRightPanelTabsState(state: RightPanelTabsState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export type { RightPanelTabsState, SpecialTabState };
export {
  STORAGE_KEY as RIGHT_PANEL_TABS_KEY,
  RightPanelTabsStateSchema,
  defaultRightPanelTabsState,
  getRightPanelTabsState,
  setRightPanelTabsState,
};
