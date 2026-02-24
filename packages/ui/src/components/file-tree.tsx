import { createSignal, createEffect, createMemo, Show, For } from "solid-js";
import { FileTreeItem } from "./file-tree-item.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Switch, SwitchControl, SwitchThumb } from "./ui/switch.tsx";
import IconSlidersHorizontal from "~icons/lucide/sliders-horizontal";
import IconX from "~icons/lucide/x";
import { isSupportedFile } from "@asciimark/core/utils.ts";
import type { FSEntry } from "@asciimark/core/types.ts";

export interface ExpandAction {
  action: "expand" | "collapse";
  version: number;
}

interface FileTreeProps {
  entries: FSEntry[];
  selectedPath: string | null;
  showAllDirs?: boolean;
  showAllFiles?: boolean;
  onSelect: (entry: FSEntry) => void;
  onRefreshTree?: () => void;
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

export function FileTree(props: FileTreeProps) {
  const [filterText, setFilterText] = createSignal("");
  const [focusedPath, setFocusedPath] = createSignal<string | null>(null);
  const [expandAction, setExpandAction] = createSignal<ExpandAction>({ action: "collapse", version: 0 });
  let navRef: HTMLElement | undefined;

  // Sync focused path when selection changes (e.g. via click)
  createEffect(() => {
    const sel = props.selectedPath;
    if (sel) setFocusedPath(sel);
  });

  const visibleEntries = createMemo(() =>
    filterByVisibility(props.entries, props.showAllDirs ?? false, props.showAllFiles ?? false)
  );

  const filteredEntries = createMemo(() =>
    filterBySearch(visibleEntries(), filterText())
  );

  const isFiltering = () => filterText().length > 0;

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
            <Show when={props.onRefreshTree}>
              <DropdownMenuItem onSelect={() => props.onRefreshTree?.()}>
                Refresh Tree
              </DropdownMenuItem>
            </Show>
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
        <For each={filteredEntries()} fallback={<div class="file-tree-empty">No supported files found</div>}>
          {(entry) => (
            <FileTreeItem
              depth={0}
              entry={entry}
              expandAction={expandAction()}
              focusedPath={focusedPath()}
              forceExpand={isFiltering()}
              selectedPath={props.selectedPath}
              onSelect={props.onSelect}
            />
          )}
        </For>
      </div>
    </nav>
  );
}
