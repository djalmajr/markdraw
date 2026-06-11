import { createEffect, createMemo, Show, For, onMount, onCleanup, type JSX } from "solid-js";
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
import IconClipboardPaste from "~icons/lucide/clipboard-paste";
import IconCopy from "~icons/lucide/copy";
import IconScissors from "~icons/lucide/scissors";
import IconPencil from "~icons/lucide/pencil";
import IconTrash from "~icons/lucide/trash-2";
import IconFolderOpen from "~icons/lucide/folder-open";
import IconExternalLink from "~icons/lucide/external-link";
import IconSparkles from "~icons/lucide/sparkles";
import IconFilePlus from "~icons/lucide/file-plus";
import IconFolderPlus from "~icons/lucide/folder-plus";
import { useDraggable, useDroppable } from "@dnd-kit/solid";
import { CreateRow } from "./create-row.tsx";
import { type ItemDndData, siblingDropParent, toItemDndId } from "./tree-dnd.ts";
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

/** Whether `src` can be moved into the directory `dstDir` (workspace-
 *  relative, "" = root): not a no-op (already its parent), not onto
 *  itself, and not a folder into its own subtree. */
function canMoveInto(src: FSEntry, dstDir: string): boolean {
  if (src.path === dstDir) return false;
  const srcParent = src.path.includes("/") ? src.path.slice(0, src.path.lastIndexOf("/")) : "";
  if (srcParent === dstDir) return false;
  if (src.kind === "directory" && (dstDir === src.path || dstDir.startsWith(src.path + "/"))) return false;
  return true;
}

/** Platform-conventional rename shortcut, formatted for display in menus. */
const RENAME_SHORTCUT_LABEL = IS_MAC ? "⌘↵" : "F2";
/** Copy-path shortcut: ⇧⌘C on macOS, Alt+Shift+C elsewhere. */
const COPY_SHORTCUT_LABEL = IS_MAC ? "⇧⌘C" : "Alt+Shift+C";
/** Cut / Copy / Paste (move clipboard) and create / trash shortcut labels. */
const CUT_SHORTCUT_LABEL = IS_MAC ? "⌘X" : "Ctrl+X";
const COPY_ENTRY_SHORTCUT_LABEL = IS_MAC ? "⌘C" : "Ctrl+C";
const PASTE_SHORTCUT_LABEL = IS_MAC ? "⌘V" : "Ctrl+V";
const NEW_FILE_SHORTCUT_LABEL = IS_MAC ? "⌘N" : "Ctrl+N";
const NEW_FOLDER_SHORTCUT_LABEL = IS_MAC ? "⇧⌘N" : "Ctrl+Shift+N";
const TRASH_SHORTCUT_LABEL = IS_MAC ? "⌘⌫" : "Del";

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
  /** Focus/select a folder row (without expanding it) so keyboard actions
   *  like ⌘V have a target. Files focus implicitly via `onSelect`. */
  onFocusEntry?: (entry: FSEntry) => void;
  /** Open file in a new pinned tab (right-click / middle-click). */
  onOpenInNewTab?: (entry: FSEntry) => void;
  /** Attach this file to the AI chat as context (desktop-only). rootId is
   *  injected by the parent, matching the onOpenInNewTab pattern. */
  onAddToChat?: (entry: FSEntry) => void;
  /** Double-click on file — pin the tab. */
  onDoubleClickFile?: (entry: FSEntry) => void;
  /** Desktop-only: commit a new file/folder created inline under
   *  `parentPath` (workspace-relative, "" = root). When omitted (web/
   *  extension), the New File / New Folder entries are hidden. */
  onCreate?: (parentPath: string, name: string, kind: "file" | "folder", rootId: string) => void;
  /** Desktop-only: move `entry` into `targetDirRel` ("" = workspace root).
   *  Powers drag & drop and the Cut/Paste menu entries. When omitted
   *  (web/extension), dragging and Cut/Paste are disabled. */
  onMove?: (entry: FSEntry, targetDirRel: string, rootId: string, targetRootId?: string) => void | Promise<void>;
  /** Desktop-only: copy `entry` into `targetDirRel` ("" = workspace root),
   *  auto-numbering on collision. Powers the Copy/Paste menu + ⌘C/⌘V. */
  onCopy?: (entry: FSEntry, targetDirRel: string, rootId: string, targetRootId?: string) => void | Promise<void>;
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
    const onCutEvt = () => {
      if (props.onMove) app.setMoveClipboard({ entry: props.entry, rootId: props.rootId, mode: "cut" });
    };
    const onCopyEntryEvt = () => {
      if (props.onCopy) app.setMoveClipboard({ entry: props.entry, rootId: props.rootId, mode: "copy" });
    };
    const onPasteEvt = () => doPaste();
    const onTrashEvt = () => props.onDelete?.(props.entry, props.rootId);
    itemRef.addEventListener("tree-expand", onExpand);
    itemRef.addEventListener("tree-collapse", onCollapse);
    itemRef.addEventListener("tree-rename", onRenameEvt);
    itemRef.addEventListener("tree-copy-path", onCopyEvt);
    itemRef.addEventListener("tree-cut", onCutEvt);
    itemRef.addEventListener("tree-copy", onCopyEntryEvt);
    itemRef.addEventListener("tree-paste", onPasteEvt);
    itemRef.addEventListener("tree-trash", onTrashEvt);
    onCleanup(() => {
      itemRef!.removeEventListener("tree-expand", onExpand);
      itemRef!.removeEventListener("tree-collapse", onCollapse);
      itemRef!.removeEventListener("tree-rename", onRenameEvt);
      itemRef!.removeEventListener("tree-copy-path", onCopyEvt);
      itemRef!.removeEventListener("tree-cut", onCutEvt);
      itemRef!.removeEventListener("tree-copy", onCopyEntryEvt);
      itemRef!.removeEventListener("tree-paste", onPasteEvt);
      itemRef!.removeEventListener("tree-trash", onTrashEvt);
    });
  });

  const isFocused = () => props.focusedPath === props.entry.path;
  const isSelected = () => props.selectedPath === props.entry.path;
  const isDirectory = () => props.entry.kind === "directory";
  /** This entry is on the clipboard. Cut → italic/dimmed (it will move away);
   *  Copy → a subtle marked outline (the original stays put). */
  const onClipboard = (mode: "cut" | "copy") => {
    const c = app.moveClipboard();
    return !!c && c.mode === mode && c.rootId === props.rootId && c.entry.path === props.entry.path;
  };
  const isCut = () => onClipboard("cut");
  const isCopy = () => onClipboard("copy");

  /** Directory a paste lands in: this dir if it is one, else its parent. */
  function pasteTargetDir(): string {
    if (isDirectory()) return props.entry.path;
    return props.entry.path.includes("/")
      ? props.entry.path.slice(0, props.entry.path.lastIndexOf("/"))
      : "";
  }

  /** Whether the current clipboard can paste into `dir` of this row's root. */
  function pasteAllowed(clip: NonNullable<ReturnType<typeof app.moveClipboard>>, dir: string): boolean {
    // Cross-workspace paste is always allowed — the backend (handleMove /
    // handleCopy) is the source of truth and guards within-root edge cases.
    if (clip.rootId !== props.rootId) return true;
    if (clip.mode === "cut") return canMoveInto(clip.entry, dir);
    // Copy auto-numbers on collision, so same-parent is fine; only block
    // copying a folder into its own subtree (would recurse).
    return !(clip.entry.kind === "directory" && (dir === clip.entry.path || dir.startsWith(clip.entry.path + "/")));
  }

  /** Execute the pending Cut (move) or Copy into `pasteTargetDir()` — into
   *  this row's root, which may differ from the clipboard's (cross-workspace). */
  function doPaste() {
    const clip = app.moveClipboard();
    if (!clip) return;
    const dir = pasteTargetDir();
    if (!pasteAllowed(clip, dir)) return;
    app.setMoveClipboard(null);
    if (isDirectory()) setExpanded(true);
    const handler = clip.mode === "cut" ? props.onMove : props.onCopy;
    void Promise.resolve(handler?.(clip.entry, dir, clip.rootId, props.rootId)).catch(() => {});
  }
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

  // Auto-expand a directory when an inline create targets it, so the CreateRow
  // placeholder is visible even if the folder was collapsed.
  createEffect(() => {
    const c = app.creatingAt();
    if (c && c.parentPath === props.entry.path && c.rootId === props.rootId && isDirectory() && !expanded()) {
      setExpanded(true);
    }
  });

  function handleClick() {
    if (isEditing()) return;
    if (isDirectory()) {
      // A folder row click selects/focuses the folder (so keyboard actions
      // like ⌘V target it) — it does NOT expand. Expansion is the chevron's
      // job (or a double-click), keeping select and expand separate. Focus the
      // nav so its keydown handler (⌘V/⌘X/…) receives keys.
      props.onFocusEntry?.(props.entry);
      focusNav();
    } else {
      props.onSelect(props.entry);
    }
  }

  function handleChevronClick(e: MouseEvent) {
    e.stopPropagation();
    if (isEditing()) return;
    setExpanded(!expanded());
  }

  function handleDoubleClick() {
    if (isEditing()) return;
    if (isDirectory()) {
      setExpanded(!expanded());
      return;
    }
    props.onDoubleClickFile?.(props.entry);
  }

  function handleMouseDown(e: MouseEvent) {
    if (e.button === 1 && !isDirectory()) {
      e.preventDefault();
      props.onOpenInNewTab?.(props.entry);
    }
  }

  // ── Drag & drop (move) ────────────────────────────────────────────
  // Reuse the same @dnd-kit provider that powers workspace-root reordering —
  // native HTML5 drag never initiates reliably for these rows under WKWebView
  // (the Kobalte trigger swallows the gesture). Every row is draggable; only
  // folders are drop targets. The actual move is dispatched from FileTree's
  // onDragEnd, which carries the source/target `data` we set here.
  const dndId = toItemDndId(props.rootId, props.entry.path);
  const dndData = (): ItemDndData => ({
    rootId: props.rootId,
    path: props.entry.path,
    name: props.entry.name,
    kind: props.entry.kind,
  });
  const draggable = useDraggable({
    id: dndId,
    get data() {
      return dndData();
    },
    get disabled() {
      return !props.onMove || isEditing();
    },
  });
  // Both folders and files are drop targets: dropping onto a folder moves the
  // entry inside it; dropping onto a file moves it next to that file (into the
  // file's parent). FileTree.onDragEnd resolves the destination directory.
  const droppable = useDroppable({
    id: dndId,
    get data() {
      return dndData();
    },
    get disabled() {
      return !props.onMove;
    },
  });
  // This folder is the resolved drop destination (hovered directly, or the
  // parent of a hovered sibling). The dashed affordance goes on the whole
  // subtree (the wrapper), matching the workspace-root drop zone.
  const isDropFolder = () => {
    if (!isDirectory()) return false;
    const s = siblingDropParent();
    return !!s && s.path === props.entry.path && s.rootId === props.rootId;
  };
  const setItemRef = (el: HTMLDivElement) => {
    itemRef = el;
    draggable.ref(el);
    droppable.ref(el);
  };

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
    if (props.onCreate) {
      const dir = isDirectory()
        ? props.entry.path
        : props.entry.path.includes("/")
          ? props.entry.path.slice(0, props.entry.path.lastIndexOf("/"))
          : "";
      const startCreate = (kind: "file" | "folder") => {
        if (isDirectory()) setExpanded(true);
        app.setCreatingAt({ parentPath: dir, rootId: props.rootId, kind });
      };
      list.push(
        {
          id: "new-file",
          icon: <IconFilePlus width={14} height={14} />,
          label: m.tree_new_file,
          onSelect: () => startCreate("file"),
          shortcut: NEW_FILE_SHORTCUT_LABEL,
          itemClass: "justify-between gap-3",
        },
        {
          id: "new-folder",
          icon: <IconFolderPlus width={14} height={14} />,
          label: m.tree_new_folder,
          onSelect: () => startCreate("folder"),
          shortcut: NEW_FOLDER_SHORTCUT_LABEL,
          itemClass: "justify-between gap-3",
        },
      );
    }
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
    // Files AND folders: a folder mention attaches its subtree listing.
    if (props.onAddToChat) {
      list.push({
        id: "add-to-chat",
        icon: <IconSparkles width={14} height={14} />,
        label: m.ai_add_to_chat,
        onSelect: () => props.onAddToChat?.(props.entry),
        itemClass: "gap-2",
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
    if (props.onMove) {
      list.push({
        id: "cut",
        icon: <IconScissors width={14} height={14} />,
        label: m.tree_cut,
        onSelect: () => app.setMoveClipboard({ entry: props.entry, rootId: props.rootId, mode: "cut" }),
        shortcut: CUT_SHORTCUT_LABEL,
        separatorBefore: true,
        itemClass: "justify-between gap-3",
      });
    }
    if (props.onCopy) {
      list.push({
        id: "copy",
        icon: <IconCopy width={14} height={14} />,
        label: m.tree_copy,
        onSelect: () => app.setMoveClipboard({ entry: props.entry, rootId: props.rootId, mode: "copy" }),
        shortcut: COPY_ENTRY_SHORTCUT_LABEL,
        separatorBefore: !props.onMove,
        itemClass: "justify-between gap-3",
      });
    }
    if (props.onMove || props.onCopy) {
      const clip = app.moveClipboard();
      if (isDirectory() && clip && pasteAllowed(clip, props.entry.path)) {
        list.push({
          id: "paste",
          icon: <IconClipboardPaste width={14} height={14} />,
          label: m.tree_paste,
          onSelect: doPaste,
          shortcut: PASTE_SHORTCUT_LABEL,
          itemClass: "justify-between gap-3",
        });
      }
    }
    if (props.onDelete) {
      list.push({
        id: "trash",
        icon: <IconTrash width={14} height={14} />,
        label: m.tree_move_to_trash,
        onSelect: () => props.onDelete?.(props.entry, props.rootId),
        shortcut: TRASH_SHORTCUT_LABEL,
        separatorBefore: true,
        itemClass: "justify-between gap-3",
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
    <div
      class="tree-item-wrapper"
      classList={{ "drop-into": isDropFolder() }}
      style={isVisible() ? undefined : { display: "none" }}
    >
      <ContextMenu>
        <ContextMenuTrigger
          as="div"
          class={`tree-item ${isSelected() ? "selected" : ""} ${isDirectory() ? "directory" : "file"} ${isFocused() ? "focused" : ""} ${isCut() ? "cut-pending" : ""} ${isCopy() ? "copy-pending" : ""}`}
          data-expanded={isDirectory() ? String(expanded()) : undefined}
          data-kind={props.entry.kind}
          data-path={props.entry.path}
          data-root-id={props.rootId}
          ref={setItemRef}
          style={{ "padding-left": `${indent()}px` }}
          title={props.entry.path}
          onClick={handleClick}
          onDblClick={handleDoubleClick}
          onMouseDown={handleMouseDown}
        >
          <span
            class={`tree-icon ${isDirectory() ? "tree-chevron" : ""}`}
            onClick={isDirectory() ? handleChevronClick : undefined}
          >
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
      <Show when={isDirectory() && (expanded() || props.forceExpand)}>
        <Show when={app.creatingAt()?.parentPath === props.entry.path && app.creatingAt()?.rootId === props.rootId}>
          <CreateRow
            kind={app.creatingAt()!.kind}
            indent={(props.depth + 1) * INDENT_PER_DEPTH + BASE_PADDING}
            icon={
              app.creatingAt()!.kind === "folder"
                ? <IconFolder width={14} height={14} />
                : <IconFilePlain width={14} height={14} />
            }
            onCommit={(name) => {
              const c = app.creatingAt()!;
              app.setCreatingAt(null);
              props.onCreate?.(c.parentPath, name, c.kind, props.rootId);
            }}
            onCancel={() => app.setCreatingAt(null)}
          />
        </Show>
        <For each={props.entry.children ?? []}>
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
              onFocusEntry={props.onFocusEntry}
              onOpenInNewTab={props.onOpenInNewTab}
              onDoubleClickFile={props.onDoubleClickFile}
              onCreate={props.onCreate}
              onMove={props.onMove}
              onCopy={props.onCopy}
              showItemMenu={props.showItemMenu}
            />
          )}
        </For>
      </Show>
    </div>
  );
}
