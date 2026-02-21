import { createSignal, createEffect, Show, For, onMount, onCleanup } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import IconChevronRight from "~icons/lucide/chevron-right";
import IconFolder from "~icons/lucide/folder";
import IconFile from "~icons/lucide/file-text";
import { useApp } from "../context/app-context.tsx";

const INDENT_PER_DEPTH = 20;
const BASE_PADDING = 8;

interface FileTreeItemProps {
  depth: number;
  entry: FSEntry;
  focusedPath: string | null;
  forceExpand?: boolean;
  selectedPath: string | null;
  onSelect: (entry: FSEntry) => void;
}

export function FileTreeItem(props: FileTreeItemProps) {
  const app = useApp();
  const [expanded, setExpanded] = createSignal(props.depth < 1);
  let itemRef: HTMLDivElement | undefined;

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

  // Listen for custom expand/collapse events from keyboard handler
  onMount(() => {
    if (!itemRef) return;
    const onExpand = () => setExpanded(true);
    const onCollapse = () => setExpanded(false);
    itemRef.addEventListener("tree-expand", onExpand);
    itemRef.addEventListener("tree-collapse", onCollapse);
    onCleanup(() => {
      itemRef!.removeEventListener("tree-expand", onExpand);
      itemRef!.removeEventListener("tree-collapse", onCollapse);
    });
  });

  const isFocused = () => props.focusedPath === props.entry.path;
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
        class={`tree-item ${isSelected() ? "selected" : ""} ${isDirectory() ? "directory" : "file"} ${isFocused() ? "focused" : ""}`}
        data-expanded={isDirectory() ? String(expanded()) : undefined}
        data-kind={props.entry.kind}
        data-path={props.entry.path}
        ref={itemRef}
        style={{ "padding-left": `${indent()}px` }}
        title={props.entry.path}
        onClick={handleClick}
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
        <span class="tree-name">
          {props.entry.name}
          <Show when={app.isDirty() && app.selectedFile()?.path === props.entry.path}>
            <span class="tree-dirty">*</span>
          </Show>
        </span>
      </div>
      <Show when={isDirectory() && (expanded() || props.forceExpand) && props.entry.children}>
        <For each={props.entry.children}>
          {(child) => (
            <FileTreeItem
              depth={props.depth + 1}
              entry={child}
              focusedPath={props.focusedPath}
              forceExpand={props.forceExpand}
              selectedPath={props.selectedPath}
              onSelect={props.onSelect}
            />
          )}
        </For>
      </Show>
    </div>
  );
}
