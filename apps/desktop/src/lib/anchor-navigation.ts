import * as m from "@markdraw/i18n";
import { resolveAnchor, type AnchorIndex } from "@markdraw/core/asciidoc-anchors.ts";
import type { TabState } from "@markdraw/core/tabs.ts";
import type { QualifiedPath } from "@markdraw/core/types.ts";
import type { FragmentSource } from "@markdraw/ui/composables/create-app-state.ts";
import type { PaneStore } from "@markdraw/ui/composables/create-pane-store.ts";
import { showToast } from "@markdraw/ui/components/ui/toast.tsx";

/** The workspace anchor build can still be in flight when a link is clicked.
 *  A new build replaces the whole snapshot, so identity tells a waiter that
 *  it must wait again. */
export interface AnchorIndexState {
  index: AnchorIndex | null;
  pending: Promise<void> | null;
}

export interface AnchorNavigationDeps {
  getActivePane: () => Pick<PaneStore, "paneId" | "selectedFile"> & {
    tabs: { getActiveTab: () => Pick<TabState, "id" | "rootId" | "filePath"> | undefined };
  };
  getState: () => AnchorIndexState;
  navigate: (target: QualifiedPath, fragment: string) => void | Promise<void>;
}

const ASCIIDOC_FILE = /\.(?:adoc|asciidoc|asc)$/i;

export function createAnchorNavigation(deps: AnchorNavigationDeps) {
  return async function handleUnresolvedFragment(source: FragmentSource): Promise<void> {
    if (!ASCIIDOC_FILE.test(source.path)) return;

    let state = deps.getState();
    while (state.pending) {
      await state.pending;
      const next = deps.getState();
      if (next.pending === state.pending && next.index === state.index) break;
      state = next;
    }

    const pane = deps.getActivePane();
    if (pane.paneId !== source.paneId) return;
    const tab = pane.tabs.getActiveTab();
    if (tab?.id !== source.tabId || tab.rootId !== source.rootId
      || tab.filePath !== source.path || pane.selectedFile()?.path !== source.path) return;

    const target = state.index
      ? resolveAnchor(state.index, source.id, source)
      : undefined;
    if (!target) {
      showToast({
        title: m.anchor_target_not_found(),
        description: source.id,
        duration: 4000,
      });
      return;
    }

    await deps.navigate(target, source.id);
  };
}
