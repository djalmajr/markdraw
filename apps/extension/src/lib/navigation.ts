import type { Accessor } from "solid-js";
import type { FSEntry } from "@markdraw/core/types.ts";
import type { AppState } from "@markdraw/ui/composables/create-app-state.ts";
import { getPathFromHash } from "./hash.ts";
import { dirOfUrl, resolveUrl } from "./url-source.ts";
import { resolveFileByPath } from "./fs.ts";

interface NavigationDeps {
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  fallbackFileMap: Accessor<Map<string, File> | null>;
  isUrlMode: boolean;
  loadFileContent: (entry: FSEntry, pushHistory?: boolean, force?: boolean, rootId?: string) => Promise<void>;
  rootHandle: Accessor<FileSystemDirectoryHandle | null>;
  rootHandles: Accessor<Map<string, FileSystemDirectoryHandle>>;
  sourceUrl: string | null;
  state: AppState;
}

export function createNavigation(deps: NavigationDeps) {
  const {
    canGoBack,
    canGoForward,
    fallbackFileMap,
    isUrlMode,
    loadFileContent,
    rootHandle,
    rootHandles,
    sourceUrl,
    state,
  } = deps;

  async function handleNavigate(targetPath: string, fragment?: string | null) {
    state.setPendingFragment(fragment ?? null);

    if (isUrlMode) {
      let targetUrl: string;

      if (/^file:\/\//i.test(targetPath) || /^https?:\/\//i.test(targetPath)) {
        targetUrl = targetPath;
      } else {
        const baseUrl = dirOfUrl(sourceUrl!);
        targetUrl = resolveUrl(baseUrl, targetPath);
      }

      const viewerUrl =
        window.location.pathname + "?url=" + encodeURIComponent(targetUrl) +
        (fragment ? "#" + encodeURIComponent(fragment) : "");
      window.location.href = viewerUrl;
      return;
    }

    const root = rootHandle();
    const fileMap = fallbackFileMap();
    if (!root && !fileMap && rootHandles().size === 0) return;

    // Try current root first
    const currentRootId = state.selectedRootId();
    if (currentRootId) {
      const entry = state.findEntryByPath(targetPath, currentRootId);
      if (entry && entry.kind === "file") {
        loadFileContent(entry, true, false, currentRootId);
        return;
      }
    }

    // Try all roots
    const entry = state.findEntryByPath(targetPath);
    if (entry && entry.kind === "file") {
      // Find which root this entry belongs to
      for (const wsRoot of state.rootsList()) {
        const found = state.findEntryByPath(targetPath, wsRoot.id);
        if (found) {
          loadFileContent(found, true, false, wsRoot.id);
          return;
        }
      }
      // Fallback: load without specific root
      loadFileContent(entry);
      return;
    }

    // Fallback mode: look up in flat file map
    if (!root && fileMap) {
      const file = fileMap.get(targetPath);
      if (file) {
        const name = targetPath.includes("/")
          ? targetPath.substring(targetPath.lastIndexOf("/") + 1)
          : targetPath;
        const syntheticEntry: FSEntry = { name, kind: "file", path: targetPath, file };
        loadFileContent(syntheticEntry);
        return;
      }
      console.warn(`File not found in fallback map: ${targetPath}`);
      return;
    }

    // Native mode: resolve from filesystem — try current root's handle first, then all
    const handleToTry: Array<[string, FileSystemDirectoryHandle]> = [];
    if (currentRootId) {
      const h = rootHandles().get(currentRootId);
      if (h) handleToTry.push([currentRootId, h]);
    }
    for (const [id, h] of rootHandles()) {
      if (id !== currentRootId) handleToTry.push([id, h]);
    }

    for (const [rId, handle] of handleToTry) {
      try {
        const fileHandle = await resolveFileByPath(handle, targetPath);
        if (fileHandle) {
          const name = targetPath.includes("/")
            ? targetPath.substring(targetPath.lastIndexOf("/") + 1)
            : targetPath;
          const syntheticEntry: FSEntry = { name, kind: "file", path: targetPath, handle: fileHandle };
          loadFileContent(syntheticEntry, true, false, rId);
          return;
        }
      } catch {
        // Try next root
      }
    }

    console.warn(`File not found: ${targetPath}`);
  }

  function onPopState() {
    if (isUrlMode) return;
    const hashPath = getPathFromHash();
    if (hashPath) {
      const stack = state.navStack();
      const idx = state.navIndex();
      const prevQp = stack[idx - 1];
      const nextQp = stack[idx + 1];

      if (prevQp && hashPath === prevQp.path) {
        state.setNavIndex(idx - 1);
      } else if (nextQp && hashPath === nextQp.path) {
        state.setNavIndex(idx + 1);
      }

      const entry = state.findEntryByPath(hashPath);
      if (entry && entry.kind === "file") {
        loadFileContent(entry, false);
      }
    }
  }

  window.addEventListener("popstate", onPopState);

  function handleGoBack() {
    if (!canGoBack()) return;
    const stack = state.navStack();
    const newIdx = state.navIndex() - 1;
    const qp = stack[newIdx];
    if (qp) {
      const entry = state.findEntryByPath(qp.path, qp.rootId);
      if (entry && entry.kind === "file") {
        state.setNavIndex(newIdx);
        history.back();
        loadFileContent(entry, false, false, qp.rootId);
      }
    }
  }

  function handleGoForward() {
    if (!canGoForward()) return;
    const stack = state.navStack();
    const newIdx = state.navIndex() + 1;
    const qp = stack[newIdx];
    if (qp) {
      const entry = state.findEntryByPath(qp.path, qp.rootId);
      if (entry && entry.kind === "file") {
        state.setNavIndex(newIdx);
        history.forward();
        loadFileContent(entry, false, false, qp.rootId);
      }
    }
  }

  function cleanup() {
    window.removeEventListener("popstate", onPopState);
  }

  return { cleanup, handleGoBack, handleGoForward, handleNavigate };
}
