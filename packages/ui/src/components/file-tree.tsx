import { createSignal, createEffect, createMemo, For, Show } from "solid-js";
import { DragDropProvider, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/solid";
import { FileTreeItem } from "./file-tree-item.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Switch, SwitchControl, SwitchThumb } from "./ui/switch.tsx";
import IconChevronRight from "~icons/lucide/chevron-right";
import IconSlidersHorizontal from "~icons/lucide/sliders-horizontal";
import IconX from "~icons/lucide/x";
import IconFolderOpen from "~icons/lucide/folder-open";
import IconRefreshCw from "~icons/lucide/refresh-cw";
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
  showAllDirs?: boolean;
  showAllFiles?: boolean;
  onCloseRoot?: (rootId: string) => void;
  onRefreshRoot?: (rootId: string) => void;
  onReorderRoots?: (newOrder: string[]) => void;
  onSelect: (entry: FSEntry, rootId: string) => void;
  onToggleRootCollapsed?: (rootId: string) => void;
  onToggleShowAllDirs?: () => void;
  onToggleShowAllFiles?: () => void;
}

/**
 * Filter entries by visibility settings (showAllDirs, showAllFiles).
 * When showAllDirs is false, directories that contain no supported files (recursively) are hidden.
 * When showAllFiles is false, non-supported files are hidden.
 */
function filterByVisibility(entries: FSEntry[], showAllDirs: boolean, showAllFiles: boolean): FSEntry[] {
  if (showAllDirs && showAllFiles) return entries;

  return entries.reduce<FSEntry[]>((acc, entry) => {
    if (entry.kind === "directory") {
      const filteredChildren = filterByVisibility(entry.children ?? [], showAllDirs, showAllFiles);
      // Show directory if showAllDirs is true, or if it has visible children
      if (showAllDirs || filteredChildren.length > 0) {
        acc.push({ ...entry, children: filteredChildren });
      }
    } else {
      // File: show if showAllFiles is true, or if it's a supported file
      if (showAllFiles || isSupportedFile(entry.name)) {
        acc.push(entry);
      }
    }
    return acc;
  }, []);
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
  const [expandAction, setExpandAction] = createSignal<ExpandAction>({ action: "collapse", version: 0 });
  const [activeDragRootId, setActiveDragRootId] = createSignal<string | null>(null);
  let suppressRootClickUntil = 0;
  let navRef: HTMLDivElement | undefined;

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
            <Show when={props.onRefreshRoot}>
              <button
                class="workspace-root-btn"
                aria-label="Refresh"
                title="Refresh"
                onClick={(e: MouseEvent) => {
                  e.stopPropagation();
                  props.onRefreshRoot!(propsRoot.root.id);
                }}
              >
                <IconRefreshCw width={12} height={12} />
              </button>
            </Show>
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
                <IconX width={12} height={12} />
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
                expandAction={expandAction()}
                focusedPath={propsRoot.rootFocusedPath()}
                forceExpand={isFiltering()}
                selectedPath={propsRoot.rootSelectedPath()}
                onSelect={(e) => props.onSelect(e, propsRoot.root.id)}
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

  function expandAll() {
    setExpandAction((prev) => ({ action: "expand", version: prev.version + 1 }));
  }

  function collapseAll() {
    setExpandAction((prev) => ({ action: "collapse", version: prev.version + 1 }));
  }

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
        items[idx].click();
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
            <DropdownMenuItem onSelect={expandAll}>
              Expand All
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={collapseAll}>
              Collapse All
            </DropdownMenuItem>
            <Show when={props.onToggleShowAllDirs || props.onToggleShowAllFiles}>
              <DropdownMenuSeparator />
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
