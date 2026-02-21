import { createSignal, createEffect, createMemo, Show, For } from "solid-js";
import { FileTreeItem } from "./FileTreeItem.tsx";
import IconX from "~icons/lucide/x";
import type { FSEntry } from "../lib/fs.ts";

interface FileTreeProps {
  entries: FSEntry[];
  selectedPath: string | null;
  onSelect: (entry: FSEntry) => void;
}

function filterEntries(entries: FSEntry[], text: string): FSEntry[] {
  if (!text) return entries;
  const lower = text.toLowerCase();

  return entries.reduce<FSEntry[]>((acc, entry) => {
    if (entry.kind === "directory" && entry.children) {
      const filtered = filterEntries(entry.children, text);
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
  let navRef: HTMLElement | undefined;

  // Sync focused path when selection changes (e.g. via click)
  createEffect(() => {
    const sel = props.selectedPath;
    if (sel) setFocusedPath(sel);
  });

  const filteredEntries = createMemo(() =>
    filterEntries(props.entries, filterText())
  );

  const isFiltering = () => filterText().length > 0;

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
      ref={navRef}
      tabindex="0"
      onKeyDown={handleKeyDown}
    >
      <div class="file-tree-search-wrapper">
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
      <For each={filteredEntries()} fallback={<div class="file-tree-empty">No supported files found</div>}>
        {(entry) => (
          <FileTreeItem
            depth={0}
            entry={entry}
            focusedPath={focusedPath()}
            forceExpand={isFiltering()}
            selectedPath={props.selectedPath}
            onSelect={props.onSelect}
          />
        )}
      </For>
    </nav>
  );
}
