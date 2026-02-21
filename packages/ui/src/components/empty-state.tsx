import { Show } from "solid-js";
import IconFileText from "~icons/lucide/file-text";
import IconUpload from "~icons/lucide/upload";
import { Button } from "./ui/button.tsx";

interface EmptyStateProps {
  hasRoot: boolean;
  onOpenFolder?: () => void;
}

export function EmptyState(props: EmptyStateProps) {
  return (
    <div class="empty-state">
      <Show
        when={props.hasRoot}
        fallback={
          <>
            <div class="drop-zone">
              <IconUpload width={32} height={32} />
              <span>Drop a folder or file here</span>
            </div>
            <p class="empty-hint">
              Supports .adoc and .md files
            </p>
            <Show when={props.onOpenFolder}>
              <p class="empty-hint">or</p>
              <Button onClick={props.onOpenFolder}>
                Open Folder
              </Button>
            </Show>
          </>
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
