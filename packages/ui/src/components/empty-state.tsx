import { createMemo, For, Show } from "solid-js";
import type { RecentFile } from "@asciimark/core/recent-files.ts";
import type { RecentFolder } from "@asciimark/core/recent-folders.ts";
import type { FavoriteFile } from "@asciimark/core/favorites.ts";
import { isFavorite } from "@asciimark/core/favorites.ts";
import IconFolderOpen from "~icons/lucide/folder-open";
import IconFileText from "~icons/lucide/file-text";
import IconX from "~icons/lucide/x";
import IconUpload from "~icons/lucide/upload";
import IconKeyboard from "~icons/lucide/keyboard";
import IconStar from "~icons/lucide/star";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import { Button } from "./ui/button.tsx";

interface RecentItem {
  key: string;
  meta: string;
  name: string;
  onOpen: () => void | Promise<void>;
  onRemove: () => void;
  type: "file" | "folder";
  favoriteData?: FavoriteFile;
}

interface EmptyStateProps {
  favorites?: FavoriteFile[];
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
  onToggleFavorite?: (file: FavoriteFile) => void;
  onWindowDragStart?: () => void | Promise<void>;
  /**
   * Open the keyboard-shortcuts help modal. When supplied, a discreet
   * ghost button shows in the bottom-right corner of the welcome
   * screen — first-time users have something to click to discover
   * the available shortcuts. Hidden when omitted (extension passes
   * undefined when there's no Cmd+/ keydown wired).
   */
  onShowShortcutsHelp?: () => void;
}

export function EmptyState(props: EmptyStateProps) {
  const hasRecentFiles = () => (props.recentFiles?.length ?? 0) > 0;
  const hasRecentFolders = () => (props.recentFolders?.length ?? 0) > 0;
  const favs = () => props.favorites ?? [];

  const allItems = createMemo((): RecentItem[] => {
    const folderItems = (props.recentFolders ?? []).map((folder) => ({
      key: `folder:${folder.path}`,
      meta: folder.path,
      name: folder.name,
      onOpen: () => props.onOpenRecentFolder?.(folder.path),
      onRemove: () => props.onRemoveRecentFolder?.(folder.path),
      type: "folder" as const,
      favoriteData: {
        name: folder.name,
        path: folder.path,
        rootName: folder.name,
        rootPath: folder.path,
      },
    }));
    const fileItems = (props.recentFiles ?? []).map((recentFile) => ({
      key: `file:${recentFile.rootPath}:${recentFile.path}`,
      meta: `${recentFile.rootName}/${recentFile.path}`,
      name: recentFile.name,
      onOpen: () => props.onOpenRecentFile?.(recentFile),
      onRemove: () => props.onRemoveRecentFile?.(recentFile.path, recentFile.rootPath),
      type: "file" as const,
      favoriteData: {
        name: recentFile.name,
        path: recentFile.path,
        rootName: recentFile.rootName,
        rootPath: recentFile.rootPath,
      },
    }));
    return [...folderItems, ...fileItems];
  });

  // Pinned favorites first, then the rest — single sorted list
  const sortedItems = createMemo(() => {
    const pinned: RecentItem[] = [];
    const rest: RecentItem[] = [];
    for (const item of allItems()) {
      if (item.favoriteData && isFavorite(item.favoriteData.path, item.favoriteData.rootPath, favs())) {
        pinned.push(item);
      } else {
        rest.push(item);
      }
    }
    return [...pinned, ...rest];
  });

  const showRecentHistory = () =>
    !!props.showRecentHistory && (hasRecentFolders() || hasRecentFiles());

  function handleMouseDown(e: MouseEvent) {
    if (!props.onWindowDragStart) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const interactive = target.closest("button,a,input,select,textarea,.drop-zone");
    if (interactive) return;
    void props.onWindowDragStart();
  }

  function isItemFavorite(item: RecentItem): boolean {
    if (!item.favoriteData) return false;
    return isFavorite(item.favoriteData.path, item.favoriteData.rootPath, favs());
  }

  return (
    <div class="empty-state" onMouseDown={handleMouseDown}>
      <Show
        when={props.hasRoot}
        fallback={
          <div class="empty-home">
            <div class="drop-zone" onClick={props.onOpenFolder}>
              <IconUpload width={32} height={32} />
              <span>{(useLocale(), m.empty_dropzone_title())}</span>
              <p class="empty-hint">{(useLocale(), m.empty_dropzone_hint())}</p>
            </div>
            <Show when={showRecentHistory()}>
              <div class="recent-history">
                <div class="recent-section-header">
                  <h3>{(useLocale(), m.empty_recent_heading())}</h3>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => props.onClearRecentHistory?.()}
                  >
                    {(useLocale(), m.empty_recent_clear())}
                  </Button>
                </div>
                <ul class="recent-list">
                  <For each={sortedItems()}>
                    {(item) => {
                      const fav = () => isItemFavorite(item);
                      return (
                        <li class="recent-item" classList={{ "recent-item-pinned": fav() }}>
                          <button class="recent-item-main" type="button" onClick={item.onOpen}>
                            <Show
                              when={item.type === "folder"}
                              fallback={<IconFileText width={18} height={18} />}
                            >
                              <IconFolderOpen width={18} height={18} />
                            </Show>
                            <span class="recent-item-content">
                              <span class="recent-item-name">{item.name}</span>
                              <span class="recent-item-meta">{item.meta}</span>
                            </span>
                          </button>
                          <Show when={props.onToggleFavorite && item.favoriteData}>
                            <button
                              aria-label={fav() ? `Unpin ${item.name}` : `Pin ${item.name}`}
                              class="recent-item-star"
                              classList={{ "recent-item-star-active": fav() }}
                              type="button"
                              onClick={() => props.onToggleFavorite?.(item.favoriteData!)}
                            >
                              <IconStar width={14} height={14} />
                            </button>
                          </Show>
                          <button
                            aria-label={`Remove ${item.name}`}
                            class="recent-item-remove"
                            type="button"
                            onClick={item.onRemove}
                          >
                            <IconX width={14} height={14} />
                          </button>
                        </li>
                      );
                    }}
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
        <h2>{(useLocale(), m.empty_select_file_title())}</h2>
        <p>{(useLocale(), m.empty_select_file_hint())}</p>
      </Show>
      <Show when={!props.hasRoot && props.onShowShortcutsHelp}>
        <button
          aria-label={(useLocale(), m.empty_shortcuts_hint())}
          class="empty-shortcuts-hint"
          type="button"
          onClick={() => props.onShowShortcutsHelp?.()}
        >
          <IconKeyboard width={14} height={14} />
          <span>{(useLocale(), m.empty_shortcuts_hint())}</span>
        </button>
      </Show>
    </div>
  );
}
