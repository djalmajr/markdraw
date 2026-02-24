import { For, Show } from "solid-js";
import type { RecentFile } from "@asciimark/core/recent-files.ts";
import type { RecentFolder } from "@asciimark/core/recent-folders.ts";
import IconFolderOpen from "~icons/lucide/folder-open";
import IconFileText from "~icons/lucide/file-text";
import IconX from "~icons/lucide/x";
import IconUpload from "~icons/lucide/upload";
import { Button } from "./ui/button.tsx";

interface RecentItem {
  key: string;
  meta: string;
  name: string;
  onOpen: () => void | Promise<void>;
  onRemove: () => void;
  type: "file" | "folder";
}

interface EmptyStateProps {
  hasRoot: boolean;
  recentFiles?: RecentFile[];
  recentFolders?: RecentFolder[];
  showRecentHistory?: boolean;
  onClearRecentHistory?: () => void;
  onOpenFolder?: () => void;
  onOpenRecentFile?: (recentFile: RecentFile) => void | Promise<void>;
  onOpenRecentFolder?: (path: string) => void | Promise<void>;
  onRemoveRecentFile?: (path: string, rootPath: string) => void;
  onRemoveRecentFolder?: (path: string) => void;
  onWindowDragStart?: () => void | Promise<void>;
}

export function EmptyState(props: EmptyStateProps) {
  const hasRecentFiles = () => (props.recentFiles?.length ?? 0) > 0;
  const hasRecentFolders = () => (props.recentFolders?.length ?? 0) > 0;
  const recentItems = (): RecentItem[] => {
    const folderItems = (props.recentFolders ?? []).map((folder) => {
      return {
        key: `folder:${folder.path}`,
        meta: folder.path,
        name: folder.name,
        onOpen: () => props.onOpenRecentFolder?.(folder.path),
        onRemove: () => props.onRemoveRecentFolder?.(folder.path),
        type: "folder",
      } satisfies RecentItem;
    });
    const fileItems = (props.recentFiles ?? []).map((recentFile) => {
      return {
        key: `file:${recentFile.rootPath}:${recentFile.path}`,
        meta: `${recentFile.rootName}/${recentFile.path}`,
        name: recentFile.name,
        onOpen: () => props.onOpenRecentFile?.(recentFile),
        onRemove: () => props.onRemoveRecentFile?.(recentFile.path, recentFile.rootPath),
        type: "file",
      } satisfies RecentItem;
    });
    return [...folderItems, ...fileItems];
  };
  const showRecentHistory = () => {
    return !!props.showRecentHistory && (hasRecentFolders() || hasRecentFiles());
  };

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
          <div class="empty-home">
            <div class="drop-zone" onClick={props.onOpenFolder}>
              <IconUpload width={32} height={32} />
              <span>Drop a folder/file here or click to open</span>
              <p class="empty-hint">Supports .adoc and .md files</p>
            </div>
            <Show when={showRecentHistory()}>
              <div class="recent-history">
                <div class="recent-section-header">
                  <h3>Recent</h3>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => props.onClearRecentHistory?.()}
                  >
                    Clear
                  </Button>
                </div>
                <ul class="recent-list">
                  <For each={recentItems()}>
                    {(item) => (
                      <li class="recent-item">
                        <button
                          class="recent-item-main"
                          type="button"
                          onClick={item.onOpen}
                        >
                          <Show
                            when={item.type === "folder"}
                            fallback={<IconFileText width={20} height={20} />}
                          >
                            <IconFolderOpen width={20} height={20} />
                          </Show>
                          <span class="recent-item-content">
                            <span class="recent-item-name">{item.name}</span>
                            <span class="recent-item-meta">{item.meta}</span>
                          </span>
                        </button>
                        <button
                          aria-label={`Remove ${item.name}`}
                          class="recent-item-remove"
                          type="button"
                          onClick={item.onRemove}
                        >
                          <IconX width={15} height={15} />
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>
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
