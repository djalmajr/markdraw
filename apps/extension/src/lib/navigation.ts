import type { Accessor } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import type { AppState } from "@asciimark/ui/composables/create-app-state.ts";
import { getPathFromHash } from "./hash.ts";
import { dirOfUrl, resolveUrl } from "./url-source.ts";
import { resolveFileByPath } from "./fs.ts";

interface NavigationDeps {
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  fallbackFileMap: Accessor<Map<string, File> | null>;
  isUrlMode: boolean;
  loadFileContent: (entry: FSEntry, pushHistory?: boolean) => Promise<void>;
  rootHandle: Accessor<FileSystemDirectoryHandle | null>;
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
    if (!root && !fileMap) return;

    // Try existing tree first
    const entry = state.findEntryByPath(targetPath);
    if (entry && entry.kind === "file") {
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

    // Native mode: resolve from filesystem
    try {
      const fileHandle = await resolveFileByPath(root!, targetPath);
      if (fileHandle) {
        const name = targetPath.includes("/")
          ? targetPath.substring(targetPath.lastIndexOf("/") + 1)
          : targetPath;
        const syntheticEntry: FSEntry = { name, kind: "file", path: targetPath, handle: fileHandle };
        loadFileContent(syntheticEntry);
        return;
      }
    } catch {
      // Fall through
    }

    console.warn(`File not found: ${targetPath}`);
  }

  function onPopState() {
    if (isUrlMode) return;
    const hashPath = getPathFromHash();
    if (hashPath) {
      const stack = state.navStack();
      const idx = state.navIndex();
      if (hashPath === stack[idx - 1]) {
        state.setNavIndex(idx - 1);
      } else if (hashPath === stack[idx + 1]) {
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
    const path = stack[newIdx];
    if (path) {
      const entry = state.findEntryByPath(path);
      if (entry && entry.kind === "file") {
        state.setNavIndex(newIdx);
        history.back();
        loadFileContent(entry, false);
      }
    }
  }

  function handleGoForward() {
    if (!canGoForward()) return;
    const stack = state.navStack();
    const newIdx = state.navIndex() + 1;
    const path = stack[newIdx];
    if (path) {
      const entry = state.findEntryByPath(path);
      if (entry && entry.kind === "file") {
        state.setNavIndex(newIdx);
        history.forward();
        loadFileContent(entry, false);
      }
    }
  }

  function cleanup() {
    window.removeEventListener("popstate", onPopState);
  }

  return { cleanup, handleGoBack, handleGoForward, handleNavigate };
}
