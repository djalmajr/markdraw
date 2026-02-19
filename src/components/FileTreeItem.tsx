import { createSignal, Show, For } from "solid-js";
import type { FSEntry } from "../lib/fs.ts";
import IconChevronRight from "~icons/lucide/chevron-right";
import IconFolder from "~icons/lucide/folder";
import IconFile from "~icons/lucide/file-text";

interface FileTreeItemProps {
  entry: FSEntry;
  selectedPath: string | null;
  onSelect: (entry: FSEntry) => void;
  depth: number;
}

export function FileTreeItem(props: FileTreeItemProps) {
  const [expanded, setExpanded] = createSignal(props.depth < 1);

  const isSelected = () => props.selectedPath === props.entry.path;
  const isDirectory = () => props.entry.kind === "directory";
  const indent = () => props.depth * 16;

  function handleClick() {
    if (isDirectory()) {
      setExpanded((v) => !v);
    } else {
      props.onSelect(props.entry);
    }
  }

  return (
    <div class="tree-item-wrapper">
      <div
        class={`tree-item ${isSelected() ? "selected" : ""} ${isDirectory() ? "directory" : "file"}`}
        style={{ "padding-left": `${indent() + 8}px` }}
        onClick={handleClick}
        title={props.entry.path}
      >
        <span class="tree-icon">
          <Show
            when={isDirectory()}
            fallback={<IconFile width={14} height={14} />}
          >
            <IconChevronRight
              width={14}
              height={14}
              class={expanded() ? "chevron-expanded" : "chevron-collapsed"}
            />
          </Show>
        </span>
        <Show when={isDirectory()}>
          <span class="tree-icon folder-icon">
            <IconFolder width={14} height={14} />
          </span>
        </Show>
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
