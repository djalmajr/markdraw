import { createSignal, createEffect, createMemo, Show, For, onMount, onCleanup } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import type { ExpandAction } from "./file-tree.tsx";
import IconChevronRight from "~icons/lucide/chevron-right";
import IconFolder from "~icons/lucide/folder";
import IconFile from "~icons/lucide/file-text";
import IconEllipsisVertical from "~icons/lucide/ellipsis-vertical";
import IconClipboard from "~icons/lucide/clipboard-copy";
import IconPencil from "~icons/lucide/pencil";
import IconTrash from "~icons/lucide/trash-2";
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

const INDENT_PER_DEPTH = 20;
const BASE_PADDING = 8;

const IS_MAC = typeof navigator !== "undefined"
  && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

/** Platform-conventional rename shortcut, formatted for display in menus. */
const RENAME_SHORTCUT_LABEL = IS_MAC ? "⌘↵" : "F2";
/** Copy-path shortcut: ⇧⌘C on macOS, Alt+Shift+C elsewhere. */
const COPY_SHORTCUT_LABEL = IS_MAC ? "⇧⌘C" : "Alt+Shift+C";

interface FileTreeItemProps {
  depth: number;
  entry: FSEntry;
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
  onRename?: (entry: FSEntry, rootId: string, newName: string) => Promise<void>;
  onDelete?: (entry: FSEntry, rootId: string) => Promise<void>;
  onSelect: (entry: FSEntry) => void;
  /** Open file in a new pinned tab (right-click / middle-click). */
  onOpenInNewTab?: (entry: FSEntry) => void;
  /** Double-click on file — pin the tab. */
  onDoubleClickFile?: (entry: FSEntry) => void;
}

/** Reject empty, traversal segments, and characters disallowed on common filesystems. */
function isValidFilename(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return false;
  // Disallow path separators and common reserved/control characters
  // eslint-disable-next-line no-control-regex
  return !/[<>:"/\\|?*\x00-\x1f]/.test(trimmed);
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

  function startRename() {
    app.setEditingPath(props.entry.path);
  }

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

  return (
    <div class="tree-item-wrapper">
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
              fallback={<IconFile width={14} height={14} />}
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
          <Show when={!isEditing()}>
            <DropdownMenu>
              <DropdownMenuTrigger
                as="button"
                class="tree-item-more"
                onClick={(e: MouseEvent) => e.stopPropagation()}
              >
                <IconEllipsisVertical width={14} height={14} />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="min-w-48">
                <Show when={!isDirectory() && props.onOpenInNewTab}>
                  <DropdownMenuItem class="justify-between gap-3" onSelect={() => props.onOpenInNewTab?.(props.entry)}>
                    <span class="flex items-center gap-2"><IconExternalLink width={14} height={14} /> Open in New Tab</span>
                    <span class="ml-auto opacity-40"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="18" rx="6" /><line x1="12" y1="7" x2="12" y2="11" /></svg></span>
                  </DropdownMenuItem>
                </Show>
                <DropdownMenuItem class="justify-between gap-3" onSelect={copyPath}>
                  <span class="flex items-center gap-2"><IconClipboard width={14} height={14} /> Copy path</span>
                  <span class="ml-auto text-xs tracking-widest opacity-40">{COPY_SHORTCUT_LABEL}</span>
                </DropdownMenuItem>
                <Show when={props.onRename}>
                  <DropdownMenuItem class="justify-between gap-3" onSelect={startRename}>
                    <span class="flex items-center gap-2"><IconPencil width={14} height={14} /> Rename</span>
                    <span class="ml-auto text-xs tracking-widest opacity-40">{RENAME_SHORTCUT_LABEL}</span>
                  </DropdownMenuItem>
                </Show>
                <Show when={props.onDelete}>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem class="gap-2" onSelect={() => props.onDelete?.(props.entry, props.rootId)}>
                    <IconTrash width={14} height={14} /> Move to Trash
                  </DropdownMenuItem>
                </Show>
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
         */}
        <ContextMenuContent class="tree-context-menu min-w-48">
          <Show when={!isDirectory() && props.onOpenInNewTab}>
            <ContextMenuItem class="justify-between gap-3" onSelect={() => props.onOpenInNewTab?.(props.entry)}>
              <span class="flex items-center gap-2"><IconExternalLink width={14} height={14} /> Open in New Tab</span>
              <ContextMenuShortcut class="ml-0 opacity-40"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="18" rx="6" /><line x1="12" y1="7" x2="12" y2="11" /></svg></ContextMenuShortcut>
            </ContextMenuItem>
          </Show>
          <ContextMenuItem class="justify-between gap-3" onSelect={copyPath}>
            <span class="flex items-center gap-2"><IconClipboard width={14} height={14} /> Copy path</span>
            <ContextMenuShortcut class="ml-0 opacity-40">{COPY_SHORTCUT_LABEL}</ContextMenuShortcut>
          </ContextMenuItem>
          <Show when={props.onRename}>
            <ContextMenuItem class="justify-between gap-3" onSelect={startRename}>
              <span class="flex items-center gap-2"><IconPencil width={14} height={14} /> Rename</span>
              <ContextMenuShortcut class="ml-0 opacity-40">{RENAME_SHORTCUT_LABEL}</ContextMenuShortcut>
            </ContextMenuItem>
          </Show>
          <Show when={props.onDelete}>
            <ContextMenuSeparator />
            <ContextMenuItem class="gap-2" onSelect={() => props.onDelete?.(props.entry, props.rootId)}>
              <IconTrash width={14} height={14} /> Move to Trash
            </ContextMenuItem>
          </Show>
        </ContextMenuContent>
      </ContextMenu>
      <Show when={isDirectory() && (expanded() || props.forceExpand) && props.entry.children}>
        <For each={props.entry.children}>
          {(child) => (
            <FileTreeItem
              depth={props.depth + 1}
              entry={child}
              expandAction={props.expandAction}
              isExpanded={props.isExpanded}
              onSetExpanded={props.onSetExpanded}
              focusedPath={props.focusedPath}
              forceExpand={props.forceExpand}
              rootId={props.rootId}
              selectedPath={props.selectedPath}
              onCopyPath={props.onCopyPath}
              onRename={props.onRename}
              onDelete={props.onDelete}
              onSelect={props.onSelect}
              onOpenInNewTab={props.onOpenInNewTab}
              onDoubleClickFile={props.onDoubleClickFile}
            />
          )}
        </For>
      </Show>
    </div>
  );
}
