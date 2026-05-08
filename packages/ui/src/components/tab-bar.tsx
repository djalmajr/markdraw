import { For, Show, createMemo, createSignal, createEffect } from "solid-js";
import { useDraggable, useDroppable } from "@dnd-kit/solid";
import type { TabStore } from "../composables/create-tab-store.ts";
import type { TabState } from "@asciimark/core/tabs.ts";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import IconX from "~icons/lucide/x";
import IconPlus from "~icons/lucide/plus";
import IconChevronLeft from "~icons/lucide/chevron-left";
import IconChevronRight from "~icons/lucide/chevron-right";

interface TabBarProps {
  tabStore: TabStore;
  /** Pane index this bar belongs to. Encoded into the dnd id so the
   *  cross-pane DragDropProvider in AppShell can route reorders
   *  (same pane) vs moves (different pane). */
  paneIndex: number;
  activeTabDirty?: boolean;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab?: () => void;
  /** When provided, the tab context menu shows a "Move to Other Pane"
   *  item. The label flips to "Open in Split Pane" when only one pane
   *  exists (the host then auto-splits). When omitted (single-pane
   *  hosts like the extension), the entry is hidden. */
  onMoveToOtherPane?: (tabId: string) => void;
  /** Label for the move-to-other-pane menu item. Caller supplies it
   *  so the wording reflects the current number of panes. */
  moveToOtherPaneLabel?: string;
}

const TAB_DND_PREFIX = "tab::";
const SCROLL_STEP = 150;

/** Build the dnd id for a tab, encoding both pane index + tab id. */
export function toTabDndId(paneIndex: number, tabId: string): string {
  return `${TAB_DND_PREFIX}${paneIndex}::${tabId}`;
}

/** Parse a tab dnd id back into its pane index + tab id. Returns null
 *  for non-tab ids. Exported so the AppShell-level DragDropProvider
 *  can route cross-pane drops correctly. */
export function fromTabDndId(dndId: unknown): { paneIndex: number; tabId: string } | null {
  if (typeof dndId !== "string") return null;
  if (!dndId.startsWith(TAB_DND_PREFIX)) return null;
  const rest = dndId.slice(TAB_DND_PREFIX.length);
  const sep = rest.indexOf("::");
  if (sep < 0) return null;
  const paneIndex = Number(rest.slice(0, sep));
  if (!Number.isInteger(paneIndex)) return null;
  return { paneIndex, tabId: rest.slice(sep + 2) };
}

function DraggableTab(props: {
  tab: TabState;
  paneIndex: number;
  isActive: boolean;
  isDirty: boolean;
  displayName: string;
  canDrag: boolean;
  onActivate: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  onCloseToRight: () => void;
  onMove?: () => void;
  onPin?: () => void;
  moveLabel?: string;
}) {
  const dndId = () => toTabDndId(props.paneIndex, props.tab.id);
  const draggable = useDraggable({
    get id() { return dndId(); },
    get disabled() { return !props.canDrag; },
  });
  const droppable = useDroppable({
    get id() { return dndId(); },
    get disabled() { return !props.canDrag; },
  });

  // Drag pins the preview tab (VSCode parity). Watch the dnd-kit
  // dragging flag rather than wiring an `onDragStart` — the kit
  // doesn't expose a direct callback at this layer, but the boolean
  // flips synchronously when the gesture commits, which is the
  // exact moment we want to pin.
  createEffect(() => {
    if (draggable.isDragging() && !props.tab.isPinned) {
      props.onPin?.();
    }
  });

  return (
    <Tooltip openDelay={600}>
      <ContextMenu>
        <TooltipTrigger as="span" class="tab-bar-item-tooltip-trigger" data-tab-id={props.tab.id}>
          <ContextMenuTrigger
            as="div"
            class={`tab-bar-item ${props.isActive ? "tab-bar-item-active" : ""}`}
            classList={{ "tab-bar-item-dragging": draggable.isDragging() }}
            data-preview={!props.tab.isPinned ? "true" : undefined}
            ref={(el: HTMLElement) => {
              draggable.ref(el);
              droppable.ref(el);
            }}
            onClick={() => props.onActivate()}
            onDblClick={() => props.onPin?.()}
            onMouseDown={(e: MouseEvent) => {
              if (e.button === 1) {
                e.preventDefault();
                props.onClose();
              }
            }}
          >
            <span class="tab-bar-item-name">
              {props.displayName}
            </span>
            <Show when={props.isDirty}>
              <span class="tab-bar-item-dirty" />
            </Show>
            <button
              class="tab-bar-item-close"
              classList={{ "tab-bar-item-close-dirty": props.isDirty }}
              onClick={(e) => {
                e.stopPropagation();
                props.onClose();
              }}
            >
              <IconX width={12} height={12} />
            </button>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <ContextMenuContent class="min-w-40">
          <Show when={props.onMove}>
            <ContextMenuItem onSelect={() => props.onMove?.()}>
              {props.moveLabel ?? "Move to Other Pane"}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </Show>
          <ContextMenuItem onSelect={props.onClose}>{(useLocale(), m.tab_close())}</ContextMenuItem>
          <ContextMenuItem onSelect={props.onCloseOthers}>{(useLocale(), m.tab_close_others())}</ContextMenuItem>
          <ContextMenuItem onSelect={props.onCloseToRight}>{(useLocale(), m.tab_close_to_right())}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={props.onCloseAll}>{(useLocale(), m.tab_close_all())}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <TooltipContent>{props.tab.rootId}/{props.tab.filePath}</TooltipContent>
    </Tooltip>
  );
}

export function TabBar(props: TabBarProps) {
  const tabs = () => props.tabStore.tabs();
  const activeTabId = () => props.tabStore.activeTabId();
  // Drag is enabled even when there's a single tab, because cross-pane
  // moves are useful with one tab too. Reorder (in-pane) is the only
  // case that legitimately requires `tabs.length > 1`, and the
  // AppShell-level handler short-circuits a tab-onto-itself drop.
  const canDrag = () => true;
  const [hasOverflow, setHasOverflow] = createSignal(false);
  const [canScrollLeft, setCanScrollLeft] = createSignal(false);
  const [canScrollRight, setCanScrollRight] = createSignal(false);

  let listRef: HTMLDivElement | undefined;

  function updateScrollState() {
    if (!listRef) return;
    const { scrollLeft, scrollWidth, clientWidth } = listRef;
    const overflow = scrollWidth > clientWidth + 1;
    setHasOverflow(overflow);
    setCanScrollLeft(scrollLeft > 0);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }

  // Watch for overflow changes
  createEffect(() => {
    tabs();
    queueMicrotask(updateScrollState);
  });

  // Scroll active tab into view when it changes
  createEffect(() => {
    const id = activeTabId();
    if (!id || !listRef) return;
    queueMicrotask(() => {
      const el = listRef?.querySelector(`[data-tab-id="${CSS.escape(id)}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
        queueMicrotask(updateScrollState);
      }
    });
  });

  function scrollLeft() {
    listRef?.scrollBy({ left: -SCROLL_STEP, behavior: "smooth" });
  }

  function scrollRight() {
    listRef?.scrollBy({ left: SCROLL_STEP, behavior: "smooth" });
  }

  const displayNames = createMemo(() => {
    const list = tabs();
    const nameCount = new Map<string, number>();
    for (const t of list) {
      nameCount.set(t.fileName, (nameCount.get(t.fileName) ?? 0) + 1);
    }
    const result = new Map<string, string>();
    for (const t of list) {
      if (!t.filePath || (nameCount.get(t.fileName) ?? 0) <= 1) {
        result.set(t.id, t.fileName);
      } else {
        const parts = t.filePath.split("/");
        const parent = parts.length > 1 ? parts[parts.length - 2] : t.rootId.split("/").pop();
        result.set(t.id, `${t.fileName} — ${parent}`);
      }
    }
    return result;
  });

  return (
    <div class="tab-bar">
      <Show when={hasOverflow()}>
        <button
          class="tab-bar-scroll tab-bar-scroll-left"
          classList={{ "tab-bar-scroll-disabled": !canScrollLeft() }}
          onClick={scrollLeft}
        >
          <IconChevronLeft width={14} height={14} />
        </button>
      </Show>
      <div
        class="tab-bar-list"
        ref={listRef}
        onScroll={updateScrollState}
      >
        <For each={tabs()}>
          {(tab) => (
            <DraggableTab
              tab={tab}
              paneIndex={props.paneIndex}
              isActive={tab.id === activeTabId()}
              isDirty={tab.id === activeTabId() ? (props.activeTabDirty ?? false) : tab.editorContent !== tab.savedContent}
              displayName={displayNames().get(tab.id) ?? tab.fileName}
              canDrag={canDrag()}
              onActivate={() => props.onActivateTab(tab.id)}
              onClose={() => props.onCloseTab(tab.id)}
              onCloseOthers={() => props.tabStore.closeOtherTabs(tab.id)}
              onCloseAll={() => props.tabStore.closeAllTabs()}
              onCloseToRight={() => props.tabStore.closeTabsToRight(tab.id)}
              onMove={props.onMoveToOtherPane ? () => props.onMoveToOtherPane!(tab.id) : undefined}
              onPin={() => props.tabStore.pinTab(tab.id)}
              moveLabel={props.moveToOtherPaneLabel}
            />
          )}
        </For>
      </div>
      <Show when={hasOverflow()}>
        <button
          class="tab-bar-scroll tab-bar-scroll-right"
          classList={{ "tab-bar-scroll-disabled": !canScrollRight() }}
          onClick={scrollRight}
        >
          <IconChevronRight width={14} height={14} />
        </button>
      </Show>
      <Show when={props.onNewTab}>
        <button
          class="tab-bar-new"
          onClick={() => {
            props.onNewTab!();
            queueMicrotask(() => {
              listRef?.scrollTo({ left: listRef.scrollWidth, behavior: "smooth" });
              updateScrollState();
            });
          }}
          title="New Tab"
        >
          <IconPlus width={14} height={14} />
        </button>
      </Show>
    </div>
  );
}
