import { createSignal } from "solid-js";
import type { Accessor, Setter } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import type { AppState } from "@asciimark/ui/composables/create-app-state.ts";
import { readFileContent, readTree } from "./fs.ts";

interface NavContext {
  html: string;
  rootName: string;
  rootPath: string;
  selectedFile: FSEntry | null;
  tree: FSEntry[];
}

interface NavigationDeps {
  loadFileContent: (entry: FSEntry, pushHistory?: boolean) => Promise<void>;
  rootPath: Accessor<string | null>;
  setRootPath: Setter<string | null>;
  state: AppState;
}

export function createNavigation(deps: NavigationDeps) {
  const { loadFileContent, rootPath, setRootPath, state } = deps;

  const [contextStack, setContextStack] = createSignal<NavContext[]>([]);
  const [forwardContextStack, setForwardContextStack] = createSignal<NavContext[]>([]);

  function currentContext(): NavContext {
    return {
      html: state.html(),
      rootName: state.rootName(),
      rootPath: rootPath() ?? "",
      selectedFile: state.selectedFile(),
      tree: state.tree(),
    };
  }

  function restoreContext(ctx: NavContext) {
    setRootPath(ctx.rootPath);
    state.setRootName(ctx.rootName);
    state.setTree(ctx.tree);
    state.setSelectedFile(ctx.selectedFile);
    state.setHtml(ctx.html);
    state.setSidebarVisible(
      ctx.tree.length > 1 || ctx.tree.some((e) => e.kind === "directory"),
    );
    state.setNavStack([]);
    state.setNavIndex(-1);
  }

  function canGoBack() {
    return state.navIndex() > 0 || contextStack().length > 0;
  }

  function canGoForward() {
    return state.navIndex() < state.navStack().length - 1 || forwardContextStack().length > 0;
  }

  async function handleNavigate(targetPath: string, fragment?: string | null) {
    state.setPendingFragment(fragment ?? null);
    const root = rootPath();

    // Try finding in the existing tree first
    const entry = state.findEntryByPath(targetPath);
    if (entry && entry.kind === "file") {
      loadFileContent(entry);
      return;
    }

    // Not in tree -- try reading directly from filesystem
    if (root) {
      // Try as directory first
      try {
        const absolutePath = `${root}/${targetPath}`;
        const entries = await readTree(absolutePath);
        if (entries.length > 0) {
          // Save current context so we can go back
          setContextStack((prev) => [...prev, currentContext()]);

          setRootPath(absolutePath);
          const dirName = targetPath.includes("/")
            ? targetPath.substring(targetPath.lastIndexOf("/") + 1)
            : targetPath;
          state.setRootName(dirName);
          state.setTree(entries);
          state.setSidebarVisible(true);
          state.setSelectedFile(null);
          state.setHtml("");
          setForwardContextStack([]);
          state.setNavStack([]);
          state.setNavIndex(-1);
          return;
        }
      } catch {
        // Not a directory
      }

      // Try as file
      try {
        const absolutePath = `${root}/${targetPath}`;
        await readFileContent(absolutePath);
        const name = targetPath.includes("/")
          ? targetPath.substring(targetPath.lastIndexOf("/") + 1)
          : targetPath;
        const syntheticEntry: FSEntry = { name, kind: "file", path: targetPath };
        loadFileContent(syntheticEntry);
        return;
      } catch {
        // File doesn't exist at that path
      }
    }

    console.warn(`File not found: ${targetPath}`);
  }

  function handleGoBack() {
    if (!canGoBack()) return;

    // If at the beginning of current navStack, restore previous context
    if (state.navIndex() <= 0 && contextStack().length > 0) {
      const contexts = contextStack();
      const prev = contexts[contexts.length - 1]!;
      setForwardContextStack((fwd) => [...fwd, currentContext()]);
      setContextStack(contexts.slice(0, -1));
      restoreContext(prev);
      return;
    }

    const stack = state.navStack();
    const newIdx = state.navIndex() - 1;
    const path = stack[newIdx];
    if (path) {
      const entry = state.findEntryByPath(path);
      if (entry && entry.kind === "file") {
        state.setNavIndex(newIdx);
        loadFileContent(entry, false);
      }
    }
  }

  function handleGoForward() {
    if (!canGoForward()) return;

    // If at the end of current navStack, restore forward context
    if (state.navIndex() >= state.navStack().length - 1 && forwardContextStack().length > 0) {
      const fwdStack = forwardContextStack();
      const next = fwdStack[fwdStack.length - 1]!;
      setContextStack((prev) => [...prev, currentContext()]);
      setForwardContextStack(fwdStack.slice(0, -1));
      restoreContext(next);
      return;
    }

    const stack = state.navStack();
    const newIdx = state.navIndex() + 1;
    const path = stack[newIdx];
    if (path) {
      const entry = state.findEntryByPath(path);
      if (entry && entry.kind === "file") {
        state.setNavIndex(newIdx);
        loadFileContent(entry, false);
      }
    }
  }

  function resetStacks() {
    setContextStack([]);
    setForwardContextStack([]);
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
