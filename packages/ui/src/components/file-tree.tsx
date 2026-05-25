import { createSignal, createEffect, createMemo, For, Show } from "solid-js";
import { DragDropProvider, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/solid";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import { FileTreeItem } from "./file-tree-item.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Switch, SwitchControl, SwitchThumb } from "./ui/switch.tsx";
import IconChevronRight from "~icons/lucide/chevron-right";
import CollapseIcon from "~icons/fluent/arrow-between-up-20-filled";
import ExpandIcon from "~icons/fluent/arrow-between-down-20-filled";
import IconSlidersHorizontal from "~icons/lucide/sliders-horizontal";
import IconX from "~icons/lucide/x";
import IconFolderOpen from "~icons/lucide/folder-open";
import { isSupportedFile } from "@asciimark/core/utils.ts";
import type { FSEntry, WorkspaceRoot } from "@asciimark/core/types.ts";

export interface ExpandAction {
  action: "expand" | "collapse";
  version: number;
}

interface FileTreeProps {
  roots: WorkspaceRoot[];
  selectedPath: string | null;
  selectedRootId: string | null;
  showHiddenEntries?: boolean;
  showAllDirs?: boolean;
  showAllFiles?: boolean;
  /** Desktop-only: paired with `onToggleRespectGitignore`, drives a
   *  new dropdown item that filters tree entries through the
   *  workspace's `.gitignore`. The Chrome extension passes nothing
   *  (no FS access) and the toggle is hidden. */
  respectGitignore?: boolean;
  onCloseRoot?: (rootId: string) => void;
  onCopyPath?: (entry: FSEntry, rootId: string) => void | Promise<void>;
  onRevealInFileManager?: (entry: FSEntry, rootId: string) => void | Promise<void>;
  onRename?: (entry: FSEntry, rootId: string, newName: string) => Promise<void>;
  onDelete?: (entry: FSEntry, rootId: string) => Promise<void>;
  onReorderRoots?: (newOrder: string[]) => void;
  onSelect: (entry: FSEntry, rootId: string) => void;
  onOpenInNewTab?: (entry: FSEntry, rootId: string) => void;
  onDoubleClickFile?: (entry: FSEntry, rootId: string) => void;
  onToggleRootCollapsed?: (rootId: string) => void;
  onToggleShowHiddenEntries?: () => void;
  onToggleShowAllDirs?: () => void;
  onToggleShowAllFiles?: () => void;
  /** Desktop-only: flips the `respectGitignore` preference. When
   *  undefined the dropdown item is hidden — matches the existing
   *  pattern with the other three visibility toggles. */
  onToggleRespectGitignore?: () => void;
  /** Forwarded to each `FileTreeItem`. Hides the per-item three-dot
   *  dropdown and the right-click context menu when false. Used by the
   *  extension where the only menu entry would be "Copy path" of a
   *  workspace-relative string. Defaults to true. */
  showItemMenu?: boolean;
}

/**
 * Walk the tree and produce a Set of paths that should be visible given the
 * current filter flags and search text.
 *
 * Returning a Set instead of transforming the entries keeps every FSEntry
 * reference stable across toggles — Solid's `<For>` reuses the existing
 * `FileTreeItem` instances, and we just flip a `Show` per item. Without
 * this, toggling Show All Files unmounts/remounts every visible item plus
 * its Kobalte ContextMenu/DropdownMenu, which is what made the screen
 * freeze on large trees.
 */
function computeVisiblePaths(
  entries: FSEntry[],
  showAllDirs: boolean,
  showAllFiles: boolean,
  search: string,
): Set<string> {
  const result = new Set<string>();
  const lowerSearch = search ? search.toLowerCase() : "";

  function walk(list: FSEntry[]): boolean {
    let anyVisible = false;
    for (const entry of list) {
      if (entry.kind === "directory") {
        const childrenVisible = entry.children ? walk(entry.children) : false;
        const dirAllowed = showAllDirs || childrenVisible;
        const dirMatchesSearch = !lowerSearch || entry.name.toLowerCase().includes(lowerSearch);
        if (dirAllowed && (!lowerSearch || childrenVisible || dirMatchesSearch)) {
          result.add(entry.path);
          anyVisible = true;
        }
      } else {
        const typeAllowed = showAllFiles || isSupportedFile(entry.name);
        const matchesSearch = !lowerSearch || entry.name.toLowerCase().includes(lowerSearch);
        if (typeAllowed && matchesSearch) {
          result.add(entry.path);
          anyVisible = true;
        }
      }
    }
    return anyVisible;
  }

  walk(entries);
  return result;
}

const ROOT_DND_PREFIX = "root::";

function toRootDndId(rootId: string): string {
  return `${ROOT_DND_PREFIX}${rootId}`;
}

function fromRootDndId(dndId: unknown): string | null {
  if (typeof dndId !== "string") return null;
  if (!dndId.startsWith(ROOT_DND_PREFIX)) return null;
  return dndId.slice(ROOT_DND_PREFIX.length);
}

export function FileTree(props: FileTreeProps) {
  const [filterText, setFilterText] = createSignal("");
  const [focusedPath, setFocusedPath] = createSignal<string | null>(null);
  const [expandActions, setExpandActions] = createSignal<Record<string, ExpandAction>>({});
  const [activeDragRootId, setActiveDragRootId] = createSignal<string | null>(null);
  // Expanded state lives outside FileTreeItem so it survives entry reconciliation.
  // One signal per root holds a frozen Set; we replace it to trigger reactivity.
  const expandedSignals = new Map<string, ReturnType<typeof createSignal<Set<string>>>>();

  function getOrCreateExpandedSignal(rootId: string) {
    let sig = expandedSignals.get(rootId);
    if (!sig) {
      sig = createSignal<Set<string>>(new Set());
      expandedSignals.set(rootId, sig);
    }
    return sig;
  }

  function isPathExpanded(rootId: string, path: string): boolean {
    const [get] = getOrCreateExpandedSignal(rootId);
    return get().has(path);
  }

  function setPathExpanded(rootId: string, path: string, value: boolean) {
    const [get, set] = getOrCreateExpandedSignal(rootId);
    const next = new Set(get());
    if (value) next.add(path);
    else next.delete(path);
    set(next);
  }

  function expandPaths(rootId: string, paths: string[]) {
    const [get, set] = getOrCreateExpandedSignal(rootId);
    const current = get();
    const next = new Set(current);
    let changed = false;
    for (const p of paths) {
      if (!next.has(p)) { next.add(p); changed = true; }
    }
    if (changed) set(next);
  }

  // When selection changes (e.g. tab activation), ensure all ancestor
  // directories are expanded and scroll into view. Only runs when the
  // selectedPath actually changes, so manual collapse isn't undone.
  let lastRevealedPath: string | null = null;
  let lastRevealedRootId: string | null = null;
  createEffect(() => {
    const sel = props.selectedPath;
    const rootId = props.selectedRootId;
    if (!sel || !rootId) {
      lastRevealedPath = sel;
      lastRevealedRootId = rootId;
      return;
    }
    if (sel === lastRevealedPath && rootId === lastRevealedRootId) return;
    lastRevealedPath = sel;
    lastRevealedRootId = rootId;

    if (sel.includes("/")) {
      const parts = sel.split("/");
      const ancestors: string[] = [];
      for (let i = 1; i < parts.length; i++) {
        ancestors.push(parts.slice(0, i).join("/"));
      }
      expandPaths(rootId, ancestors);
    }

    queueMicrotask(() => {
      if (!navRef) return;
      const el = navRef.querySelector<HTMLElement>(`.tree-item[data-path="${CSS.escape(sel)}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    });
  });

  let suppressRootClickUntil = 0;
  let navRef: HTMLDivElement | undefined;

  const defaultExpandAction: ExpandAction = { action: "collapse", version: 0 };

  const canReorderRoots = createMemo(() => !!props.onReorderRoots && props.roots.length > 1);

  // ── Root drag-and-drop reordering ──────────────────────────────────────

  function handleProviderDragStart(event: any) {
    if (!canReorderRoots()) return;
    const sourceRootId = fromRootDndId(event?.operation?.source?.id);
    setActiveDragRootId(sourceRootId);
  }

  function handleProviderDragEnd(event: any) {
    const sourceRootId =
      fromRootDndId(event?.operation?.source?.id) ??
      activeDragRootId();
    const targetRootId = fromRootDndId(event?.operation?.target?.id);
    setActiveDragRootId(null);

    if (sourceRootId) {
      suppressRootClickUntil = Date.now() + 150;
    }

    if (event?.canceled) return;
    if (!sourceRootId || !targetRootId || sourceRootId === targetRootId || !props.onReorderRoots) {
      return;
    }

    const newOrder = props.roots.map((r) => r.id);
    const sourceIdx = newOrder.indexOf(sourceRootId);
    const targetIdx = newOrder.indexOf(targetRootId);

    if (sourceIdx === -1 || targetIdx === -1) return;

    const sourceVal = newOrder[sourceIdx];
    const targetVal = newOrder[targetIdx];
    newOrder[sourceIdx] = targetVal;
    newOrder[targetIdx] = sourceVal;
    props.onReorderRoots(newOrder);
  }

  function getRootNameByDndId(dndId: unknown): string {
    const rootId = fromRootDndId(dndId);
    if (!rootId) return "";
    return props.roots.find((root) => root.id === rootId)?.name ?? rootId;
  }

  interface RootHeaderProps {
    rootId: string;
    root: () => WorkspaceRoot;
    visiblePaths: () => Set<string>;
    rootFocusedPath: () => string | null;
    rootSelectedPath: () => string | null;
  }

  function RootHeader(propsRoot: RootHeaderProps) {
    const rootId = propsRoot.rootId;
    const dndId = toRootDndId(rootId);
    const draggable = useDraggable({
      id: dndId,
      get disabled() {
        return !canReorderRoots();
      },
    });
    const droppable = useDroppable({
      id: dndId,
      get disabled() {
        return !canReorderRoots();
      },
    });

    const isDropTarget = () =>
      droppable.isDropTarget() && activeDragRootId() !== rootId;
    const isRootCollapsed = () => propsRoot.root().collapsed;
    const currentExpandAction = () => expandActions()[rootId] ?? null;

    const nextRootBulkAction = (): ExpandAction["action"] => {
      const current = currentExpandAction();
      if (!current) return "expand";
      return current.action === "expand" ? "collapse" : "expand";
    };

    function triggerRootExpandAll() {
      setExpandActions((prev) => {
        const current = prev[rootId] ?? defaultExpandAction;
        return {
          ...prev,
          [rootId]: { action: "expand", version: current.version + 1 },
        };
      });
    }

    function triggerRootCollapseAll() {
      setExpandActions((prev) => {
        const current = prev[rootId] ?? defaultExpandAction;
        return {
          ...prev,
          [rootId]: { action: "collapse", version: current.version + 1 },
        };
      });
    }

    return (
      <div
        class="workspace-root-block"
        classList={{
          "drag-over": isDropTarget(),
          "dragging": draggable.isDragging(),
        }}
        ref={droppable.ref}
      >
        <div
          class="workspace-root-header"
          classList={{
            "workspace-root-active": props.selectedRootId === rootId,
            "draggable-root": canReorderRoots(),
          }}
          ref={draggable.ref}
          onClick={() => {
            if (Date.now() < suppressRootClickUntil) return;
            setExpandActions((prev) => {
              if (!(rootId in prev)) return prev;
              const next = { ...prev };
              delete next[rootId];
              return next;
            });
            props.onToggleRootCollapsed?.(rootId);
          }}
        >
          <div class="workspace-root-main">
            <Show when={canReorderRoots()}>
              <span
                class="workspace-root-drag-handle"
                aria-label="Reorder root"
                title="Drag to reorder"
                ref={draggable.handleRef}
                onClick={(e: MouseEvent) => e.stopPropagation()}
              />
            </Show>
            <span class="tree-icon">
              <IconChevronRight
                width={14}
                height={14}
                class={!propsRoot.root().collapsed ? "chevron-expanded" : "chevron-collapsed"}
              />
            </span>
            <span class="tree-icon workspace-root-icon">
              <IconFolderOpen width={14} height={14} />
            </span>
            <span class="workspace-root-name">{propsRoot.root().name}</span>
          </div>
          <div class="workspace-root-actions">
            <button
              class="workspace-root-btn"
              aria-label={nextRootBulkAction() === "expand" ? "Expand all" : "Collapse all"}
              title={nextRootBulkAction() === "expand" ? "Expand all" : "Collapse all"}
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                const action = nextRootBulkAction();

                if (action === "expand" && isRootCollapsed()) {
                  props.onToggleRootCollapsed?.(rootId);
                }

                if (action === "expand") {
                  triggerRootExpandAll();
                } else {
                  triggerRootCollapseAll();
                }
              }}
            >
              <Show when={nextRootBulkAction() === "expand"} fallback={<CollapseIcon width={14} height={14} />}>
                <ExpandIcon width={14} height={14} />
              </Show>
            </button>
            <Show when={props.onCloseRoot}>
              <button
                class="workspace-root-btn"
                aria-label="Close"
                title="Close"
                onClick={(e: MouseEvent) => {
                  e.stopPropagation();
                  props.onCloseRoot!(rootId);
                }}
              >
                <IconX width={14} height={14} />
              </button>
            </Show>
          </div>
        </div>
        <Show when={!propsRoot.root().collapsed}>
          <For each={propsRoot.root().entries}>
            {(entry) => (
              <FileTreeItem
                depth={1}
                entry={entry}
                visiblePaths={propsRoot.visiblePaths}
                expandAction={expandActions()[rootId] ?? defaultExpandAction}
                isExpanded={(path) => isPathExpanded(rootId, path)}
                onSetExpanded={(path, exp) => setPathExpanded(rootId, path, exp)}
                focusedPath={propsRoot.rootFocusedPath()}
                forceExpand={isFiltering()}
                rootId={rootId}
                selectedPath={propsRoot.rootSelectedPath()}
                onCopyPath={props.onCopyPath}
                onRevealInFileManager={props.onRevealInFileManager}
                onRename={props.onRename}
                onDelete={props.onDelete}
                onSelect={(e) => props.onSelect(e, rootId)}
                onOpenInNewTab={props.onOpenInNewTab ? (e) => props.onOpenInNewTab!(e, rootId) : undefined}
                onDoubleClickFile={props.onDoubleClickFile ? (e) => props.onDoubleClickFile!(e, rootId) : undefined}
                showItemMenu={props.showItemMenu}
              />
            )}
          </For>
        </Show>
      </div>
    );
  }

  // ── Focus / keyboard ───────────────────────────────────────────────────

  // Sync focused path when selection changes (e.g. via click)
  createEffect(() => {
    const sel = props.selectedPath;
    if (sel) setFocusedPath(sel);
  });

  const rootIds = createMemo(() => props.roots.map((r) => r.id));

  function findRoot(rootId: string): WorkspaceRoot | undefined {
    return props.roots.find((r) => r.id === rootId);
  }

  const isFiltering = () => filterText().length > 0;

  const hasAnyEntries = createMemo(() => {
    const showAllDirs = props.showAllDirs ?? false;
    const showAllFiles = props.showAllFiles ?? false;
    const text = filterText();
    return props.roots.some(
      (r) => computeVisiblePaths(r.entries, showAllDirs, showAllFiles, text).size > 0,
    );
  });

  function getVisibleItems(): HTMLElement[] {
    if (!navRef) return [];
    // offsetParent is null when the element (or any ancestor) has display:none,
    // which is how we hide entries that don't pass the current filter.
    return Array.from(navRef.querySelectorAll<HTMLElement>(".tree-item"))
      .filter((el) => el.offsetParent !== null);
  }

  function findFocusedIndex(items: HTMLElement[]): number {
    const fp = focusedPath();
    if (!fp) return -1;
    return items.findIndex((el) => el.dataset.path === fp);
  }

  function moveFocus(items: HTMLElement[], index: number) {
    const el = items[index];
    if (el?.dataset.path) {
      setFocusedPath(el.dataset.path);
      el.scrollIntoView({ block: "nearest" });
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    const items = getVisibleItems();
    if (items.length === 0) return;

    let idx = findFocusedIndex(items);

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const next = idx < items.length - 1 ? idx + 1 : idx;
        moveFocus(items, next);
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const prev = idx > 0 ? idx - 1 : 0;
        moveFocus(items, prev);
        break;
      }
      case "ArrowRight": {
        e.preventDefault();
        if (idx < 0) break;
        const el = items[idx];
        if (el.dataset.kind === "directory") {
          if (el.dataset.expanded === "false") {
            el.dispatchEvent(new Event("tree-expand"));
          } else if (idx + 1 < items.length) {
            moveFocus(items, idx + 1);
          }
        }
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        if (idx < 0) break;
        const el = items[idx];
        if (el.dataset.kind === "directory" && el.dataset.expanded === "true") {
          el.dispatchEvent(new Event("tree-collapse"));
        } else {
          // Move to parent directory
          const currentPath = el.dataset.path;
          if (currentPath && currentPath.includes("/")) {
            const parentPath = currentPath.substring(0, currentPath.lastIndexOf("/"));
            const parentIdx = items.findIndex((it) => it.dataset.path === parentPath);
            if (parentIdx >= 0) moveFocus(items, parentIdx);
          }
        }
        break;
      }
      case "Enter":
      case " ": {
        e.preventDefault();
        if (idx < 0) break;
        // macOS rename shortcut: Cmd+Enter dispatches a rename event instead
        // of activating the item.
        if (e.metaKey && e.key === "Enter") {
          items[idx].dispatchEvent(new Event("tree-rename"));
        } else {
          items[idx].click();
        }
        break;
      }
      case "F2": {
        // Cross-platform rename shortcut (primary on Windows/Linux).
        e.preventDefault();
        if (idx < 0) break;
        items[idx].dispatchEvent(new Event("tree-rename"));
        break;
      }
      case "c":
      case "C": {
        // Copy focused item's absolute path. Shortcut: ⇧⌘C on macOS,
        // Alt+Shift+C on Windows/Linux. Dispatched as an event so the item
        // can call its platform-provided `onCopyPath` (which knows the
        // workspace root and can build the absolute path).
        if (!e.shiftKey) return;
        const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
        const modifierOk = isMac ? e.metaKey : e.altKey;
        if (!modifierOk) return;
        if (idx < 0) return;
        e.preventDefault();
        items[idx].dispatchEvent(new Event("tree-copy-path"));
        break;
      }
      case "Home": {
        e.preventDefault();
        moveFocus(items, 0);
        break;
      }
      case "End": {
        e.preventDefault();
        moveFocus(items, items.length - 1);
        break;
      }
      default:
        return;
    }
  }

  return (
    <nav
      class="file-tree"
      tabindex="0"
      onKeyDown={handleKeyDown}
    >
      <div class="file-tree-search-wrapper">
        <div class="file-tree-search-field">
          <input
            class="file-tree-search"
            placeholder={(useLocale(), m.tree_filter_files())}
            type="text"
            value={filterText()}
            onInput={(e) => setFilterText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFilterText("");
                e.currentTarget.blur();
              }
              e.stopPropagation();
            }}
          />
          <Show when={filterText()}>
            <button
              class="file-tree-search-clear"
              aria-label="Clear filter"
              tabindex={-1}
              onClick={() => setFilterText("")}
            >
              <IconX width={12} height={12} />
            </button>
          </Show>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            as="button"
            class="file-tree-levels"
            aria-label="Tree options"
            title="Tree options"
            tabindex={-1}
          >
            <IconSlidersHorizontal width={16} height={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <Show
              when={
                props.onToggleShowAllDirs
                || props.onToggleShowAllFiles
                || props.onToggleShowHiddenEntries
                || props.onToggleRespectGitignore
              }
            >
              <Show when={props.onToggleRespectGitignore}>
                <DropdownMenuItem
                  closeOnSelect={false}
                  onSelect={() => props.onToggleRespectGitignore?.()}
                >
                  <span class="flex-1">{(useLocale(), m.file_tree_respect_gitignore())}</span>
                  <Switch checked={props.respectGitignore ?? false} class="file-tree-switch">
                    <SwitchControl class="file-tree-switch-control">
                      <SwitchThumb class="file-tree-switch-thumb" />
                    </SwitchControl>
                  </Switch>
                </DropdownMenuItem>
              </Show>
              <Show when={props.onToggleShowHiddenEntries}>
                <DropdownMenuItem
                  closeOnSelect={false}
                  onSelect={() => props.onToggleShowHiddenEntries?.()}
                >
                  <span class="flex-1">Show Hidden</span>
                  <Switch checked={props.showHiddenEntries ?? false} class="file-tree-switch">
                    <SwitchControl class="file-tree-switch-control">
                      <SwitchThumb class="file-tree-switch-thumb" />
                    </SwitchControl>
                  </Switch>
                </DropdownMenuItem>
              </Show>
              <Show when={props.onToggleShowAllDirs}>
                <DropdownMenuItem
                  closeOnSelect={false}
                  onSelect={() => props.onToggleShowAllDirs?.()}
                >
                  <span class="flex-1">Show All Folders</span>
                  <Switch checked={props.showAllDirs ?? false} class="file-tree-switch">
                    <SwitchControl class="file-tree-switch-control">
                      <SwitchThumb class="file-tree-switch-thumb" />
                    </SwitchControl>
                  </Switch>
                </DropdownMenuItem>
              </Show>
              <Show when={props.onToggleShowAllFiles}>
                <DropdownMenuItem
                  closeOnSelect={false}
                  onSelect={() => props.onToggleShowAllFiles?.()}
                >
                  <span class="flex-1">Show All Files</span>
                  <Switch checked={props.showAllFiles ?? false} class="file-tree-switch">
                    <SwitchControl class="file-tree-switch-control">
                      <SwitchThumb class="file-tree-switch-thumb" />
                    </SwitchControl>
                  </Switch>
                </DropdownMenuItem>
              </Show>
            </Show>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div class="file-tree-list" ref={navRef}>
        <Show when={hasAnyEntries()} fallback={<div class="file-tree-empty">{(useLocale(), m.tree_no_files_found())}</div>}>
          <DragDropProvider
            onDragStart={handleProviderDragStart}
            onDragEnd={handleProviderDragEnd}
          >
            <For each={rootIds()}>
              {(rootId) => {
                const root = createMemo(() => findRoot(rootId)!);
                const visiblePaths = createMemo(() => {
                  const r = root();
                  if (!r) return new Set<string>();
                  return computeVisiblePaths(
                    r.entries,
                    props.showAllDirs ?? false,
                    props.showAllFiles ?? false,
                    filterText(),
                  );
                });
                const isActiveRoot = () => props.selectedRootId === rootId;
                const rootSelectedPath = () => isActiveRoot() ? props.selectedPath : null;
                const rootFocusedPath = () => isActiveRoot() ? focusedPath() : null;

                return (
                  <Show when={root()}>
                    <RootHeader
                      rootId={rootId}
                      root={root}
                      visiblePaths={visiblePaths}
                      rootFocusedPath={rootFocusedPath}
                      rootSelectedPath={rootSelectedPath}
                    />
                  </Show>
                );
              }}
            </For>
            <DragOverlay>
              {(source: any) => (
                <div class="workspace-root-overlay">{getRootNameByDndId(source?.id)}</div>
              )}
            </DragOverlay>
          </DragDropProvider>
        </Show>
      </div>
    </nav>
  );
}
