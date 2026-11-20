import { type Accessor } from "solid-js";
import type { FSEntry, QualifiedPath } from "@markdraw/core/types.ts";
import { makeTabId } from "@markdraw/core/tabs.ts";
import type { AppState } from "@markdraw/ui/composables/create-app-state.ts";
import type { TabStore } from "@markdraw/ui/composables/create-tab-store.ts";
import { showToast } from "@markdraw/ui/components/ui/toast.tsx";
import { readFileContent, readTree } from "./fs.ts";
import { resolveNavigationTarget } from "./navigation-target.ts";

interface NavigationDeps {
  loadFileContent: (entry: FSEntry, pushHistory?: boolean, force?: boolean, rootId?: string) => Promise<void>;
  rootPaths: Accessor<Map<string, string>>;
  state: AppState;
  /** Accessor returning the currently-active pane's TabStore. We pass a
   *  function (not a value) so navigation always operates on whichever
   *  pane is in focus when the user fires a back/forward / link click. */
  tabStore?: () => TabStore;
  onActivateTab?: (tabId: string) => void;
  onOpenHistoryTab?: (entry: FSEntry, rootId: string) => void;
  /** Open a link target as a tab in the active pane. Injected as a thunk
   *  because tabActions is created after navigation in app.tsx. */
  onOpenFile: (entry: FSEntry, rootId: string, pinned: boolean, pushHistory: boolean) => void | Promise<void>;
}

export function createNavigation(deps: NavigationDeps) {
  const { loadFileContent, rootPaths, state, tabStore: getTabStore, onActivateTab, onOpenHistoryTab, onOpenFile } = deps;

  function canGoBack() {
    return state.navIndex() > 0;
  }

  function canGoForward() {
    return state.navIndex() < state.navStack().length - 1;
  }

  async function openTarget(entry: FSEntry, rootId: string, fragment: string | null) {
    const paneId = state.paneManager.activePane().paneId;
    state.setPendingHtmlNavigation(paneId, fragment && /\.html?$/i.test(entry.path)
      ? { rootId, path: entry.path, fragment }
      : null);
    await onOpenFile(entry, rootId, false, true);
  }

  /** Try a single candidate path in the tree, then on the filesystem.
   *  Returns true when the navigation was handled (including a directory
   *  opened as a new root). */
  async function tryOpenTarget(targetPath: string, fragment: string | null, resolvedRootId?: string): Promise<boolean> {
    const currentRootId = state.selectedRootId();
    const preferredRootId = resolvedRootId ?? currentRootId;

    // Try finding in the current root first
    if (preferredRootId) {
      const entry = state.findEntryByPath(targetPath, preferredRootId);
      if (entry && entry.kind === "file") {
        await openTarget(entry, preferredRootId, fragment);
        return true;
      }
    }

    // Try finding in all roots
    for (const root of state.rootsList()) {
      const entry = state.findEntryByPath(targetPath, root.id);
      if (entry && entry.kind === "file") {
        await openTarget(entry, root.id, fragment);
        return true;
      }
    }

    // Not in any tree -- try filesystem fallback using the current root
    const fallbackRootId = preferredRootId ?? currentRootId;
    const currentRootPath = fallbackRootId ? rootPaths().get(fallbackRootId) : null;
    if (currentRootPath) {
      // Try as directory first
      try {
        const absolutePath = `${currentRootPath}/${targetPath}`;
        const entries = await readTree(absolutePath, state.showHiddenEntries());
        // A successful readTree means a directory even when it is empty —
        // read_dir rejects files before returning any entries.
        state.addRoot({
          collapsed: false,
          entries,
          id: absolutePath,
          name: targetPath.includes("/")
            ? targetPath.substring(targetPath.lastIndexOf("/") + 1)
            : targetPath,
        });
        state.setSelectedRootId(absolutePath);
        state.setSidebarVisible(true);
        state.setSelectedFile(null);
        state.setHtml("");
        return true;
      } catch {
        // Not a directory
      }

      // Try as file
      try {
        const absolutePath = `${currentRootPath}/${targetPath}`;
        await readFileContent(absolutePath);
        const name = targetPath.includes("/")
          ? targetPath.substring(targetPath.lastIndexOf("/") + 1)
          : targetPath;
        const syntheticEntry: FSEntry = { name, kind: "file", path: targetPath };
        await openTarget(syntheticEntry, fallbackRootId!, fragment);
        return true;
      } catch {
        // File doesn't exist at that path
      }
    }

    return false;
  }

  async function handleNavigate(targetPath: string, fragment?: string | null) {
    state.setPendingFragment(fragment ?? null);
    state.setPendingHtmlNavigation(state.paneManager.activePane().paneId, null);
    const resolved = resolveNavigationTarget(targetPath, rootPaths());
    // Preview maps AsciiDoc's generated `.html` xref links back to `.adoc`.
    // If that document is absent, try the literal `.html` file before failing.
    const candidates = resolved.path.endsWith(".adoc")
      ? [resolved.path, `${resolved.path.slice(0, -5)}.html`]
      : [resolved.path];
    for (const candidate of candidates) {
      if (await tryOpenTarget(candidate, fragment ?? null, resolved.rootId)) return;
    }
    showToast({ title: "File not found", description: resolved.path, duration: 4000 });
  }

  function navigateToStackEntry(newIdx: number) {
    const stack = state.navStack();
    const qp: QualifiedPath = stack[newIdx]!;
    const entry = state.findEntryByPath(qp.path, qp.rootId);
    if (!entry || entry.kind !== "file") return;

    state.setNavIndex(newIdx);

    // If tabs are active, check if the target is already in a tab
    if (getTabStore && onActivateTab) {
      const tabStore = getTabStore();
      const tabId = makeTabId(qp.rootId, qp.path);
      const tab = tabStore.getTab(tabId);
      if (tab) {
        onActivateTab(tabId);
        return;
      }
      if (onOpenHistoryTab) {
        onOpenHistoryTab(entry, qp.rootId);
        return;
      }
      // Target not in a tab — open it as a pinned tab
      tabStore.openTab(entry, qp.rootId);
    }

    loadFileContent(entry, false, false, qp.rootId);
  }

  function handleGoBack() {
    if (!canGoBack()) return;
    navigateToStackEntry(state.navIndex() - 1);
  }

  function handleGoForward() {
    if (!canGoForward()) return;
    navigateToStackEntry(state.navIndex() + 1);
  }

  function resetStacks() {
    // No-op — nav state is fully managed by the core state signals
  }

  return {
    canGoBack,
    canGoForward,
    handleGoBack,
    handleGoForward,
    handleNavigate,
    resetStacks,
  };
}
