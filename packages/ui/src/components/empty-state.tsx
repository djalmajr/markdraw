import { Show } from "solid-js";
import IconFileText from "~icons/lucide/file-text";
import IconUpload from "~icons/lucide/upload";

interface EmptyStateProps {
  hasRoot: boolean;
  onOpenFolder?: () => void;
  onWindowDragStart?: () => void | Promise<void>;
}

export function EmptyState(props: EmptyStateProps) {
  function handleMouseDown(e: MouseEvent) {
    if (!props.onWindowDragStart) return;
    if (e.button !== 0) return;

    const target = e.target as HTMLElement | null;
    if (!target) return;

    const interactive = target.closest("button,a,input,select,textarea,.drop-zone");
    if (interactive) return;

    void props.onWindowDragStart();
  }

  return (
    <div class="empty-state" onMouseDown={handleMouseDown}>
      <Show
        when={props.hasRoot}
        fallback={
          <div class="drop-zone" onClick={props.onOpenFolder}>
            <IconUpload width={32} height={32} />
            <span>Drop a folder/file here or click to open</span>
            <p class="empty-hint">Supports .adoc and .md files</p>
          </div>
        }
      >
        <div class="empty-icon">
          <IconFileText width={64} height={64} />
        </div>
        <h2>Select a file</h2>
        <p>Choose an .adoc file from the sidebar to preview it.</p>
      </Show>
    </div>
  );
}
