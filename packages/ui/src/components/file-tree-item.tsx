import { createSignal, createEffect, createMemo, Show, For, onMount, onCleanup, type JSX } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import { fileKind, fileManagerKind } from "@asciimark/core/utils.ts";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import type { ExpandAction } from "./file-tree.tsx";
import IconChevronRight from "~icons/lucide/chevron-right";
import IconFolder from "~icons/lucide/folder";
import IconFile from "~icons/lucide/file-text";
import IconFileImage from "~icons/lucide/file-image";
import IconFilePlain from "~icons/lucide/file";
import IconEllipsisVertical from "~icons/lucide/ellipsis-vertical";
import IconClipboard from "~icons/lucide/clipboard-copy";
import IconPencil from "~icons/lucide/pencil";
import IconTrash from "~icons/lucide/trash-2";
import IconFolderOpen from "~icons/lucide/folder-open";
import IconExternalLink from "~icons/lucide/external-link";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "./ui/context-menu.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { useApp } from "../context/app-context.tsx";

// Children render as `.tree-item` (margin-left: 4px) while the root renders
// as `.workspace-root-header` (no margin, padding-left: 8px). BASE_PADDING=4
// makes a child's leading edge land at 4 (margin) + 4 = 8 — the same x as the
// root header's content — so a child's chevron aligns with the parent folder
// icon at every depth, including the root.
const INDENT_PER_DEPTH = 20;
const BASE_PADDING = 4;

const IS_MAC = typeof navigator !== "undefined"
  && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

/** Platform-conventional rename shortcut, formatted for display in menus. */
const RENAME_SHORTCUT_LABEL = IS_MAC ? "⌘↵" : "F2";
/** Copy-path shortcut: ⇧⌘C on macOS, Alt+Shift+C elsewhere. */
const COPY_SHORTCUT_LABEL = IS_MAC ? "⇧⌘C" : "Alt+Shift+C";

/** Middle-click affordance glyph shown next to "Open in New Tab". */
function MiddleClickGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="6" y="3" width="12" height="18" rx="6" />
      <line x1="12" y1="7" x2="12" y2="11" />
    </svg>
  );
}

/** One row of the file-item menu, shared by the right-click ContextMenu
 *  and the ⋮ DropdownMenu. `label` is a Paraglide thunk so each render
 *  site can track the locale signal. `shortcut` is a string (mono label)
 *  or an element (glyph); absent for actions without a shortcut. */
interface TreeMenuEntry {
  id: string;
  icon: JSX.Element;
  label: () => string;
  onSelect: () => void;
  shortcut?: JSX.Element | string;
  separatorBefore?: boolean;
  itemClass: string;
}

interface FileTreeItemProps {
  depth: number;
  entry: FSEntry;
  /**
   * Set of paths that should currently be visible. Passed down so each item
   * can decide on its own whether to render — this lets us keep entry refs
   * stable across visibility toggles, so Solid's `<For>` reuses every
   * existing item instead of unmounting and remounting (which would
   * recreate the Kobalte ContextMenu/DropdownMenu and freeze the UI).
   */
  visiblePaths: () => Set<string>;
  expandAction: ExpandAction;
  isExpanded: (path: string) => boolean;
  onSetExpanded: (path: string, expanded: boolean) => void;
  focusedPath: string | null;
  forceExpand?: boolean;
  rootId: string;
  selectedPath: string | null;
  /**
   * Platform-provided copy-path action. Should write the absolute filesystem
   * path to the clipboard. When omitted (web/extension without filesystem
   * access), the relative `entry.path` is copied as a fallback.
   */
  onCopyPath?: (entry: FSEntry, rootId: string) => void | Promise<void>;
  /** Platform-provided "reveal in OS file manager" action (Finder /
   *  Explorer / file manager). Desktop-only; omitted on web/extension,
   *  where the menu entry is hidden. */
  onRevealInFileManager?: (entry: FSEntry, rootId: string) => void | Promise<void>;
  onRename?: (entry: FSEntry, rootId: string, newName: string) => Promise<void>;
  onDelete?: (entry: FSEntry, rootId: string) => Promise<void>;
  onSelect: (entry: FSEntry) => void;
  /** Open file in a new pinned tab (right-click / middle-click). */
  onOpenInNewTab?: (entry: FSEntry) => void;
  /** Double-click on file — pin the tab. */
  onDoubleClickFile?: (entry: FSEntry) => void;
  /**
   * Render the per-item context menu and the three-dot dropdown
   * (Copy path / Rename / Delete / Open in New Tab). When false, the
   * tree shows pure rows — no menus. Used by the browser extension
   * where the only action that would be available is "Copy path"
   * (a workspace-relative string) and a single-item menu is more
   * noise than value. Defaults to true so desktop keeps the menu.
   */
  showItemMenu?: boolean;
}

/** Reject empty, traversal segments, and characters disallowed on common filesystems. */
function isValidFilename(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return false;
  // Disallow path separators and common reserved/control characters
  // eslint-disable-next-line no-control-regex
  return !/[<>:"/\\|?*\x00-\x1f]/.test(trimmed);
}

/** File-row icon, chosen by kind so images and PDFs read distinctly from
 *  text documents (which keep the default lined-file glyph). */
function FileIcon(props: { name: string }) {
  const kind = () => fileKind(props.name);
  return (
    <Show when={kind() === "image"} fallback={
      <Show when={kind() === "pdf"} fallback={<IconFile width={14} height={14} />}>
        <IconFilePlain width={14} height={14} />
      </Show>
    }>
      <IconFileImage width={14} height={14} />
    </Show>
  );
}

export function FileTreeItem(props: FileTreeItemProps) {
  const app = useApp();
  let itemRef: HTMLDivElement | undefined;
  let nameRef: HTMLSpanElement | undefined;
  let lastExpandVersion = 0;
  // Whether a rename is currently in flight (to avoid double-commits via blur).
  let busyRename = false;

  const expanded = createMemo(() => props.isExpanded(props.entry.path));
  const setExpanded = (value: boolean) => props.onSetExpanded(props.entry.path, value);

  // Auto-expand handled centrally in FileTree when selectedPath changes.

  // React to expand/collapse all action
  createEffect(() => {
    const ea = props.expandAction;
    if (ea.version > lastExpandVersion && props.entry.kind === "directory") {
      setExpanded(ea.action === "expand");
    }
    lastExpandVersion = ea.version;
  });

  // Listen for custom expand/collapse/rename/copy-path events from keyboard handler
  onMount(() => {
    if (!itemRef) return;
    const onExpand = () => setExpanded(true);
    const onCollapse = () => setExpanded(false);
    const onRenameEvt = () => {
      if (props.onRename) startRename();
    };
    const onCopyEvt = () => copyPath();
    itemRef.addEventListener("tree-expand", onExpand);
    itemRef.addEventListener("tree-collapse", onCollapse);
    itemRef.addEventListener("tree-rename", onRenameEvt);
    itemRef.addEventListener("tree-copy-path", onCopyEvt);
    onCleanup(() => {
      itemRef!.removeEventListener("tree-expand", onExpand);
      itemRef!.removeEventListener("tree-collapse", onCollapse);
      itemRef!.removeEventListener("tree-rename", onRenameEvt);
      itemRef!.removeEventListener("tree-copy-path", onCopyEvt);
    });
  });

  const isFocused = () => props.focusedPath === props.entry.path;
  const isSelected = () => props.selectedPath === props.entry.path;
  const isDirectory = () => props.entry.kind === "directory";
  const isEditing = () => app.editingPath() === props.entry.path;
  const indent = () => props.depth * INDENT_PER_DEPTH + BASE_PADDING;

  // When entering edit mode, focus the .tree-name span and select the basename.
  createEffect(() => {
    if (!isEditing() || !nameRef) return;
    busyRename = false;
    // Defer to next microtask so the contentEditable attribute is in the DOM
    queueMicrotask(() => {
      if (!nameRef || !isEditing()) return;
      nameRef.focus();
      const text = props.entry.name;
      const dot = props.entry.kind === "file" ? text.lastIndexOf(".") : -1;
      const end = dot > 0 ? dot : text.length;
      const firstText = nameRef.firstChild;
      if (firstText && firstText.nodeType === Node.TEXT_NODE) {
        const range = document.createRange();
        range.setStart(firstText, 0);
        range.setEnd(firstText, Math.min(end, firstText.textContent?.length ?? 0));
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    });
  });

  // If the user navigates to another file/folder while editing, cancel the rename.
  createEffect(() => {
    const sel = app.selectedFile()?.path;
    if (isEditing() && sel && sel !== props.entry.path) {
      cancelRename();
    }
  });

  function handleClick() {
    if (isEditing()) return;
    if (isDirectory()) {
      setExpanded(!expanded());
    } else {
      props.onSelect(props.entry);
    }
  }

  function handleDoubleClick() {
    if (isEditing() || isDirectory()) return;
    props.onDoubleClickFile?.(props.entry);
  }

  function handleMouseDown(e: MouseEvent) {
    if (e.button === 1 && !isDirectory()) {
      e.preventDefault();
      props.onOpenInNewTab?.(props.entry);
    }
  }

  function copyPath() {
    if (props.onCopyPath) {
      void Promise.resolve(props.onCopyPath(props.entry, props.rootId)).catch(() => {
        // Platform implementation handles its own errors; ignore here.
      });
      return;
    }
    // Fallback for platforms without filesystem access (web/extension):
    // copy the workspace-relative path.
    void navigator.clipboard?.writeText(props.entry.path).catch(() => {
      // Clipboard access can fail in some contexts; nothing to do.
    });
  }

  function revealInFileManager() {
    void Promise.resolve(props.onRevealInFileManager?.(props.entry, props.rootId)).catch(() => {
      // Platform implementation handles its own errors; ignore here.
    });
  }

  // OS-appropriate label for the "reveal in file manager" entry. The menu
  // only renders this when `onRevealInFileManager` is provided (desktop),
  // where `navigator.userAgent` reliably identifies the host OS.
  function revealLabel(): string {
    useLocale();
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const kind = fileManagerKind(ua);
    if (kind === "finder") return m.tree_reveal_finder();
    if (kind === "explorer") return m.tree_reveal_explorer();
    return m.tree_reveal_file_manager();
  }

  function startRename() {
    app.setEditingPath(props.entry.path);
  }

  // Single source of truth for the per-item menu. Rendered into BOTH the
  // right-click ContextMenu and the ⋮ DropdownMenu — Kobalte binds each
  // Item primitive to its own menu context, so the primitives differ, but
  // the entries (icon / label / action / shortcut / order) live here once.
  const menuEntries = (): TreeMenuEntry[] => {
    const list: TreeMenuEntry[] = [];
    if (!isDirectory() && props.onOpenInNewTab) {
      list.push({
        id: "open-in-new-tab",
        icon: <IconExternalLink width={14} height={14} />,
        label: m.tree_open_in_new_tab,
        onSelect: () => props.onOpenInNewTab?.(props.entry),
        shortcut: <MiddleClickGlyph />,
        itemClass: "justify-between gap-3",
      });
    }
    list.push({
      id: "copy-path",
      icon: <IconClipboard width={14} height={14} />,
      label: m.tree_copy_path,
      onSelect: copyPath,
      shortcut: COPY_SHORTCUT_LABEL,
      itemClass: "justify-between gap-3",
    });
    if (props.onRename) {
      list.push({
        id: "rename",
        icon: <IconPencil width={14} height={14} />,
        label: m.tree_rename,
        onSelect: startRename,
        shortcut: RENAME_SHORTCUT_LABEL,
        itemClass: "justify-between gap-3",
      });
    }
    if (props.onRevealInFileManager) {
      list.push({
        id: "reveal",
        icon: <IconFolderOpen width={14} height={14} />,
        label: revealLabel,
        onSelect: revealInFileManager,
        itemClass: "gap-2",
      });
    }
    if (props.onDelete) {
      list.push({
        id: "trash",
        icon: <IconTrash width={14} height={14} />,
        label: m.tree_move_to_trash,
        onSelect: () => props.onDelete?.(props.entry, props.rootId),
        separatorBefore: true,
        itemClass: "gap-2",
      });
    }
    return list;
  };

  /**
   * Return focus to the file-tree `<nav>` so the user can keep navigating
   * with arrow keys after exiting edit mode. Without this the focus stays
   * on the (no-longer-editable) span and the nav's keydown handler stops
   * receiving events.
   */
  function focusNav() {
    const nav = nameRef?.closest<HTMLElement>("nav.file-tree");
    nav?.focus();
  }

  function commitRename() {
    if (busyRename || !nameRef) return;
    const next = (nameRef.textContent ?? "").trim();
    if (!next || next === props.entry.name) {
      cancelRename();
      return;
    }
    if (!isValidFilename(next) || !props.onRename) {
      cancelRename();
      return;
    }
    busyRename = true;
    props
      .onRename(props.entry, props.rootId, next)
      .then(() => {
        busyRename = false;
        app.setEditingPath(null);
        focusNav();
      })
      .catch((e: unknown) => {
        console.error("Rename failed:", e);
        // Revert text on error and exit edit mode
        if (nameRef) nameRef.textContent = props.entry.name;
        busyRename = false;
        app.setEditingPath(null);
        focusNav();
      });
  }

  function cancelRename() {
    if (busyRename) return;
    // Revert any in-progress edits before exiting edit mode
    if (nameRef) nameRef.textContent = props.entry.name;
    app.setEditingPath(null);
    focusNav();
  }

  function handleNameKeyDown(e: KeyboardEvent) {
    if (!isEditing()) return;
    // Block bubbling so the parent FileTree keyboard handler doesn't
    // consume Arrow/Home/End/etc. while editing.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  }

  function handleNamePaste(e: ClipboardEvent) {
    if (!isEditing()) return;
    // Force plain-text paste so users can't drop styled HTML or newlines.
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const cleaned = text.replace(/[\r\n]+/g, "");
    document.execCommand("insertText", false, cleaned);
  }

  const isVisible = () => props.visiblePaths().has(props.entry.path);
  const menuEnabled = () => props.showItemMenu !== false;

  return (
    <div class="tree-item-wrapper" style={isVisible() ? undefined : { display: "none" }}>
      <ContextMenu>
        <ContextMenuTrigger
          as="div"
          class={`tree-item ${isSelected() ? "selected" : ""} ${isDirectory() ? "directory" : "file"} ${isFocused() ? "focused" : ""}`}
          data-expanded={isDirectory() ? String(expanded()) : undefined}
          data-kind={props.entry.kind}
          data-path={props.entry.path}
          ref={itemRef}
          style={{ "padding-left": `${indent()}px` }}
          title={props.entry.path}
          onClick={handleClick}
          onDblClick={handleDoubleClick}
          onMouseDown={handleMouseDown}
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
              fallback={<FileIcon name={props.entry.name} />}
            >
              <IconFolder width={14} height={14} />
            </Show>
          </span>
          <span
            ref={(el) => (nameRef = el)}
            class="tree-name"
            classList={{ "tree-name-editing": isEditing() }}
            contentEditable={isEditing()}
            spellcheck={false}
            onKeyDown={handleNameKeyDown}
            onPaste={handleNamePaste}
            onBlur={() => {
              if (isEditing()) commitRename();
            }}
            onClick={(e) => {
              if (isEditing()) e.stopPropagation();
            }}
            onMouseDown={(e) => {
              if (isEditing()) e.stopPropagation();
            }}
          >
            {props.entry.name}
          </span>
          <Show when={!isEditing() && app.isDirty() && app.selectedFile()?.path === props.entry.path}>
            <span class="tree-dirty">*</span>
          </Show>
          <Show when={!isEditing() && menuEnabled()}>
            <DropdownMenu>
              <DropdownMenuTrigger
                as="button"
                class="tree-item-more"
                onClick={(e: MouseEvent) => e.stopPropagation()}
              >
                <IconEllipsisVertical width={14} height={14} />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="min-w-48">
                <For each={menuEntries()}>
                  {(entry) => (
                    <>
                      <Show when={entry.separatorBefore}><DropdownMenuSeparator /></Show>
                      <DropdownMenuItem class={entry.itemClass} onSelect={entry.onSelect}>
                        <span class="flex items-center gap-2">{entry.icon} {(useLocale(), entry.label())}</span>
                        <Show when={entry.shortcut !== undefined}>
                          <span class={typeof entry.shortcut === "string" ? "ml-auto text-xs tracking-widest opacity-40" : "ml-auto opacity-40"}>{entry.shortcut}</span>
                        </Show>
                      </DropdownMenuItem>
                    </>
                  )}
                </For>
              </DropdownMenuContent>
            </DropdownMenu>
          </Show>
        </ContextMenuTrigger>
        {/*
         * For `justify-between` to actually distribute space, the menu needs
         * extra width beyond the natural sum of label + shortcut. We use a
         * `min-w-44` (176px) to give that headroom — the menu can still grow
         * for longer items, but never shrinks past this minimum, so even the
         * widest item has visible separation.
         *
         * `Show` here keeps the right-click menu out of the DOM entirely
         * when the host platform disables item menus (e.g. extension), so
         * a contextmenu event on a tree row reverts to the browser default
         * instead of opening an empty Kobalte popover.
         */}
        <Show when={menuEnabled()}>
          <ContextMenuContent class="tree-context-menu min-w-48">
            <For each={menuEntries()}>
              {(entry) => (
                <>
                  <Show when={entry.separatorBefore}><ContextMenuSeparator /></Show>
                  <ContextMenuItem class={entry.itemClass} onSelect={entry.onSelect}>
                    <span class="flex items-center gap-2">{entry.icon} {(useLocale(), entry.label())}</span>
                    <Show when={entry.shortcut !== undefined}>
                      <ContextMenuShortcut class="ml-0 opacity-40">{entry.shortcut}</ContextMenuShortcut>
                    </Show>
                  </ContextMenuItem>
                </>
              )}
            </For>
          </ContextMenuContent>
        </Show>
      </ContextMenu>
      <Show when={isDirectory() && (expanded() || props.forceExpand) && props.entry.children}>
        <For each={props.entry.children}>
          {(child) => (
            <FileTreeItem
              depth={props.depth + 1}
              entry={child}
              visiblePaths={props.visiblePaths}
              expandAction={props.expandAction}
              isExpanded={props.isExpanded}
              onSetExpanded={props.onSetExpanded}
              focusedPath={props.focusedPath}
              forceExpand={props.forceExpand}
              rootId={props.rootId}
              selectedPath={props.selectedPath}
              onCopyPath={props.onCopyPath}
              onRevealInFileManager={props.onRevealInFileManager}
              onRename={props.onRename}
              onDelete={props.onDelete}
              onSelect={props.onSelect}
              onOpenInNewTab={props.onOpenInNewTab}
              onDoubleClickFile={props.onDoubleClickFile}
              showItemMenu={props.showItemMenu}
            />
          )}
        </For>
      </Show>
    </div>
  );
}
