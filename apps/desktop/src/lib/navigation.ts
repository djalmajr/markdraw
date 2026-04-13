import type { Accessor } from "solid-js";
import type { FSEntry, QualifiedPath } from "@asciimark/core/types.ts";
import { makeTabId } from "@asciimark/core/tabs.ts";
import type { AppState } from "@asciimark/ui/composables/create-app-state.ts";
import type { TabStore } from "@asciimark/ui/composables/create-tab-store.ts";
import { message } from "@tauri-apps/plugin-dialog";
import { readFileContent, readTree } from "./fs.ts";

interface NavigationDeps {
  loadFileContent: (entry: FSEntry, pushHistory?: boolean, force?: boolean, rootId?: string) => Promise<void>;
  rootPaths: Accessor<Map<string, string>>;
  state: AppState;
  tabStore?: TabStore;
  onActivateTab?: (tabId: string) => void;
}

export function createNavigation(deps: NavigationDeps) {
  const { loadFileContent, rootPaths, state, tabStore, onActivateTab } = deps;

  function canGoBack() {
    return state.navIndex() > 0;
  }

  function canGoForward() {
    return state.navIndex() < state.navStack().length - 1;
  }

  async function handleNavigate(targetPath: string, fragment?: string | null) {
    state.setPendingFragment(fragment ?? null);
    const currentRootId = state.selectedRootId();

    // Try finding in the current root first
    if (currentRootId) {
      const entry = state.findEntryByPath(targetPath, currentRootId);
      if (entry && entry.kind === "file") {
        loadFileContent(entry, true, false, currentRootId);
        return;
      }
    }

    // Try finding in all roots
    for (const root of state.rootsList()) {
      const entry = state.findEntryByPath(targetPath, root.id);
      if (entry && entry.kind === "file") {
        loadFileContent(entry, true, false, root.id);
        return;
      }
    }

    // Not in any tree -- try filesystem fallback using the current root
    const currentRootPath = currentRootId ? rootPaths().get(currentRootId) : null;
    if (currentRootPath) {
      // Try as directory first
      try {
        const absolutePath = `${currentRootPath}/${targetPath}`;
        const entries = await readTree(absolutePath, state.showHiddenEntries());
        if (entries.length > 0) {
          // Navigate into a subdirectory — add it as a new root
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
          return;
        }
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
        loadFileContent(syntheticEntry, true, false, currentRootId!);
        return;
      } catch {
        // File doesn't exist at that path
      }
    }

    void message(`File not found: ${targetPath}`, { title: "Navigation", kind: "error" });
  }

  function navigateToStackEntry(newIdx: number) {
    const stack = state.navStack();
    const qp: QualifiedPath = stack[newIdx]!;
    const entry = state.findEntryByPath(qp.path, qp.rootId);
    if (!entry || entry.kind !== "file") return;

    state.setNavIndex(newIdx);

    // If tabs are active, check if the target is already in a tab
    if (tabStore && onActivateTab) {
      const tabId = makeTabId(qp.rootId, qp.path);
      const tab = tabStore.getTab(tabId);
      if (tab) {
        onActivateTab(tabId);
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
