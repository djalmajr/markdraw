import { createSignal, createEffect, Show, For } from "solid-js";
import type { FSEntry } from "../lib/fs.ts";
import IconChevronRight from "~icons/lucide/chevron-right";
import IconFolder from "~icons/lucide/folder";
import IconFile from "~icons/lucide/file-text";

const INDENT_PER_DEPTH = 20;
const BASE_PADDING = 8;

interface FileTreeItemProps {
  entry: FSEntry;
  selectedPath: string | null;
  onSelect: (entry: FSEntry) => void;
  depth: number;
}

export function FileTreeItem(props: FileTreeItemProps) {
  const [expanded, setExpanded] = createSignal(props.depth < 1);

  // Auto-expand directories that contain the selected file
  createEffect(() => {
    const sel = props.selectedPath;
    if (sel && props.entry.kind === "directory") {
      const dirPrefix = props.entry.path + "/";
      if (sel.startsWith(dirPrefix)) {
        setExpanded(true);
      }
    }
  });

  const isSelected = () => props.selectedPath === props.entry.path;
  const isDirectory = () => props.entry.kind === "directory";
  const indent = () => props.depth * INDENT_PER_DEPTH + BASE_PADDING;

  function handleClick() {
    if (isDirectory()) {
      setExpanded(!expanded());
    } else {
      props.onSelect(props.entry);
    }
  }

  return (
    <div class="tree-item-wrapper">
      <div
        class={`tree-item ${isSelected() ? "selected" : ""} ${isDirectory() ? "directory" : "file"}`}
        style={{ "padding-left": `${indent()}px` }}
        onClick={handleClick}
        title={props.entry.path}
      >
        <span class="tree-icon">
          <Show when={isDirectory()}>
            <IconChevronRight
              width={14}
              height={14}
              class={expanded() ? "chevron-expanded" : "chevron-collapsed"}
            />
          </Show>
        </span>

        <span class={`tree-icon ${isDirectory() ? "folder-icon" : ""}`}>
          <Show
            when={isDirectory()}
            fallback={<IconFile width={14} height={14} />}
          >
            <IconFolder width={14} height={14} />
          </Show>
        </span>

        <span class="tree-name">{props.entry.name}</span>
      </div>

      <Show when={isDirectory() && expanded() && props.entry.children}>
        <For each={props.entry.children}>
          {(child) => (
            <FileTreeItem
              entry={child}
              selectedPath={props.selectedPath}
              onSelect={props.onSelect}
              depth={props.depth + 1}
            />
          )}
        </For>
      </Show>
    </div>
  );
}
