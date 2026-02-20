import { Show } from "solid-js";
import IconFolderOpen from "~icons/lucide/folder-open";
import IconFileText from "~icons/lucide/file-text";
import { Button } from "./ui/button.tsx";

interface EmptyStateProps {
  hasRoot: boolean;
  onOpenFolder: () => void;
}

export function EmptyState(props: EmptyStateProps) {
  return (
    <div class="empty-state">
      <Show
        when={props.hasRoot}
        fallback={
          <>
            <div class="empty-icon">
              <IconFolderOpen width={64} height={64} />
            </div>
            <h2>AsciiMark</h2>
            <p>Open a folder to browse and preview your AsciiDoc files.</p>
            <Button size="lg" onClick={props.onOpenFolder}>
              Open Folder
            </Button>
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
