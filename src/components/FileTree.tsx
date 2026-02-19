import { For } from "solid-js";
import { FileTreeItem } from "./FileTreeItem.tsx";
import type { FSEntry } from "../lib/fs.ts";

interface FileTreeProps {
  entries: FSEntry[];
  selectedPath: string | null;
  onSelect: (entry: FSEntry) => void;
}

export function FileTree(props: FileTreeProps) {
  return (
    <nav class="file-tree">
      <For each={props.entries} fallback={<div class="file-tree-empty">No .adoc files found</div>}>
        {(entry) => (
          <FileTreeItem
            entry={entry}
            selectedPath={props.selectedPath}
            onSelect={props.onSelect}
            depth={0}
          />
        )}
      </For>
    </nav>
  );
}
