import { createSignal, createEffect, createMemo, For, Show } from "solid-js";
import { DragDropProvider, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/solid";
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
  onCloseRoot?: (rootId: string) => void;
  onCopyPath?: (entry: FSEntry, rootId: string) => void | Promise<void>;
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
}

/**
 * Filter entries by visibility settings (showAllDirs, showAllFiles).
 *
 * Preserves entry references when nothing is filtered out, so Solid's
 * `<For>` can skip recreating FileTreeItem components on toggle. This is
 * critical for performance — without it, every toggle deep-clones the
 * whole tree and re-renders thousands of items.
 */
function filterByVisibility(entries: FSEntry[], showAllDirs: boolean, showAllFiles: boolean): FSEntry[] {
  if (showAllDirs && showAllFiles) return entries;

  const result: FSEntry[] = [];
  let changed = false;

  for (const entry of entries) {
    if (entry.kind === "directory") {
      const originalChildren = entry.children ?? [];
      const filteredChildren = filterByVisibility(originalChildren, showAllDirs, showAllFiles);
      if (showAllDirs || filteredChildren.length > 0) {
        if (filteredChildren === originalChildren) {
          // Children unchanged → reuse the original entry reference
          result.push(entry);
        } else {
          result.push({ ...entry, children: filteredChildren });
          changed = true;
        }
      } else {
        // Directory dropped entirely
        changed = true;
      }
    } else if (showAllFiles || isSupportedFile(entry.name)) {
      result.push(entry);
    } else {
      // File dropped
      changed = true;
    }
  }

  // If nothing actually changed, return the original array so Solid sees
  // the same reference and doesn't re-render anything.
  return changed ? result : entries;
}

function filterBySearch(entries: FSEntry[], text: string): FSEntry[] {
  if (!text) return entries;
  const lower = text.toLowerCase();

  return entries.reduce<FSEntry[]>((acc, entry) => {
    if (entry.kind === "directory" && entry.children) {
      const filtered = filterBySearch(entry.children, text);
      if (filtered.length > 0) {
        acc.push({ ...entry, children: filtered });
      }
    } else if (entry.name.toLowerCase().includes(lower)) {
      acc.push(entry);
    }
    return acc;
  }, []);
}

interface FilteredRoot {
  collapsed: boolean;
  entries: FSEntry[];
  id: string;
  name: string;
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
  // Mutable Set for O(1) read/write, signal counter for reactivity.
  const expandedSets = new Map<string, Set<string>>();
  const [expandedVersion, setExpandedVersion] = createSignal(0);

  function getExpandedSet(rootId: string): Set<string> {
    let set = expandedSets.get(rootId);
    if (!set) {
      set = new Set();
      expandedSets.set(rootId, set);
    }
    return set;
  }

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
    root: FilteredRoot;
    rootFocusedPath: () => string | null;
    rootSelectedPath: () => string | null;
  }

  function RootHeader(propsRoot: RootHeaderProps) {
    const dndId = () => toRootDndId(propsRoot.root.id);
    const draggable = useDraggable({
      get id() {
        return dndId();
      },
      disabled: !canReorderRoots(),
    });
    const droppable = useDroppable({
      get id() {
        return dndId();
      },
      disabled: !canReorderRoots(),
    });

    const isDropTarget = () =>
      droppable.isDropTarget() && activeDragRootId() !== propsRoot.root.id;
    const isRootCollapsed = () => propsRoot.root.collapsed;
    const currentExpandAction = () => expandActions()[propsRoot.root.id] ?? null;

    const nextRootBulkAction = (): ExpandAction["action"] => {
      const current = currentExpandAction();
      if (!current) return "expand";
      return current.action === "expand" ? "collapse" : "expand";
    };

    function triggerRootExpandAll(rootId: string) {
      setExpandActions((prev) => {
        const current = prev[rootId] ?? defaultExpandAction;
        return {
          ...prev,
          [rootId]: { action: "expand", version: current.version + 1 },
        };
      });
    }

    function triggerRootCollapseAll(rootId: string) {
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
            "workspace-root-active": props.selectedRootId === propsRoot.root.id,
            "draggable-root": canReorderRoots(),
          }}
          ref={draggable.ref}
          onClick={() => {
            if (Date.now() < suppressRootClickUntil) return;
            setExpandActions((prev) => {
              if (!(propsRoot.root.id in prev)) return prev;
              const next = { ...prev };
              delete next[propsRoot.root.id];
              return next;
            });
            props.onToggleRootCollapsed?.(propsRoot.root.id);
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
            <span
              class="workspace-root-chevron"
              classList={{ "workspace-root-chevron-open": !propsRoot.root.collapsed }}
            >
              <IconChevronRight width={14} height={14} />
            </span>
            <IconFolderOpen width={14} height={14} class="workspace-root-icon" />
            <span class="workspace-root-name">{propsRoot.root.name}</span>
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
                  props.onToggleRootCollapsed?.(propsRoot.root.id);
                }

                if (action === "expand") {
                  triggerRootExpandAll(propsRoot.root.id);
                } else {
                  triggerRootCollapseAll(propsRoot.root.id);
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
                  props.onCloseRoot!(propsRoot.root.id);
                }}
              >
                <IconX width={14} height={14} />
              </button>
            </Show>
          </div>
        </div>
        <Show when={!propsRoot.root.collapsed}>
          <For each={propsRoot.root.entries}>
            {(entry) => (
              <FileTreeItem
                depth={1}
                entry={entry}
                expandAction={expandActions()[propsRoot.root.id] ?? defaultExpandAction}
                isExpanded={(path) => { expandedVersion(); return getExpandedSet(propsRoot.root.id).has(path); }}
                onSetExpanded={(path, exp) => {
                  const set = getExpandedSet(propsRoot.root.id);
                  if (exp) set.add(path); else set.delete(path);
                  setExpandedVersion((v) => v + 1);
                }}
                focusedPath={propsRoot.rootFocusedPath()}
                forceExpand={isFiltering()}
                rootId={propsRoot.root.id}
                selectedPath={propsRoot.rootSelectedPath()}
                onCopyPath={props.onCopyPath}
                onRename={props.onRename}
                onDelete={props.onDelete}
                onSelect={(e) => props.onSelect(e, propsRoot.root.id)}
                onOpenInNewTab={props.onOpenInNewTab ? (e) => props.onOpenInNewTab!(e, propsRoot.root.id) : undefined}
                onDoubleClickFile={props.onDoubleClickFile ? (e) => props.onDoubleClickFile!(e, propsRoot.root.id) : undefined}
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

  const filteredRoots = createMemo((): FilteredRoot[] =>
    props.roots.map((root) => {
      const visible = filterByVisibility(root.entries, props.showAllDirs ?? false, props.showAllFiles ?? false);
      const filtered = filterBySearch(visible, filterText());
      return { collapsed: root.collapsed, entries: filtered, id: root.id, name: root.name };
    })
  );

  const isFiltering = () => filterText().length > 0;

  const hasAnyEntries = () => filteredRoots().some((r) => r.entries.length > 0);

  function getVisibleItems(): HTMLElement[] {
    if (!navRef) return [];
    return Array.from(navRef.querySelectorAll<HTMLElement>(".tree-item"));
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
            placeholder="Filter files..."
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
            <Show when={props.onToggleShowAllDirs || props.onToggleShowAllFiles || props.onToggleShowHiddenEntries}>
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
        <Show when={hasAnyEntries()} fallback={<div class="file-tree-empty">No supported files found</div>}>
          <DragDropProvider
            onDragStart={handleProviderDragStart}
            onDragEnd={handleProviderDragEnd}
          >
            <For each={filteredRoots()}>
              {(root) => {
                const isActiveRoot = () => props.selectedRootId === root.id;
                const rootSelectedPath = () => isActiveRoot() ? props.selectedPath : null;
                const rootFocusedPath = () => isActiveRoot() ? focusedPath() : null;

                return (
                  <RootHeader
                    root={root}
                    rootFocusedPath={rootFocusedPath}
                    rootSelectedPath={rootSelectedPath}
                  />
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
