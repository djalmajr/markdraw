import { For, Show, createMemo, createSignal, createEffect, onCleanup } from "solid-js";
import { DragDropProvider, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/solid";
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
import IconX from "~icons/lucide/x";
import IconPlus from "~icons/lucide/plus";
import IconChevronLeft from "~icons/lucide/chevron-left";
import IconChevronRight from "~icons/lucide/chevron-right";

interface TabBarProps {
  tabStore: TabStore;
  activeTabDirty?: boolean;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab?: () => void;
}

const TAB_DND_PREFIX = "tab::";
const SCROLL_STEP = 150;

function toTabDndId(tabId: string): string {
  return `${TAB_DND_PREFIX}${tabId}`;
}

function fromTabDndId(dndId: unknown): string | null {
  if (typeof dndId !== "string") return null;
  if (!dndId.startsWith(TAB_DND_PREFIX)) return null;
  return dndId.slice(TAB_DND_PREFIX.length);
}

function DraggableTab(props: {
  tab: TabState;
  isActive: boolean;
  isDirty: boolean;
  displayName: string;
  canReorder: boolean;
  onActivate: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  onCloseToRight: () => void;
}) {
  const dndId = () => toTabDndId(props.tab.id);
  const draggable = useDraggable({
    get id() { return dndId(); },
    get disabled() { return !props.canReorder; },
  });
  const droppable = useDroppable({
    get id() { return dndId(); },
    get disabled() { return !props.canReorder; },
  });

  return (
    <Tooltip openDelay={600}>
      <ContextMenu>
        <TooltipTrigger as="span" class="tab-bar-item-tooltip-trigger" data-tab-id={props.tab.id}>
          <ContextMenuTrigger
            as="div"
            class={`tab-bar-item ${props.isActive ? "tab-bar-item-active" : ""}`}
            classList={{ "tab-bar-item-dragging": draggable.isDragging() }}
            ref={(el: HTMLElement) => {
              draggable.ref(el);
              droppable.ref(el);
            }}
            onClick={() => props.onActivate()}
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
          <ContextMenuItem onSelect={props.onClose}>Close</ContextMenuItem>
          <ContextMenuItem onSelect={props.onCloseOthers}>Close Others</ContextMenuItem>
          <ContextMenuItem onSelect={props.onCloseToRight}>Close to the Right</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={props.onCloseAll}>Close All</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <TooltipContent>{props.tab.rootId}/{props.tab.filePath}</TooltipContent>
    </Tooltip>
  );
}

export function TabBar(props: TabBarProps) {
  const tabs = () => props.tabStore.tabs();
  const activeTabId = () => props.tabStore.activeTabId();
  const canReorder = () => tabs().length > 1;
  const [activeDragTabId, setActiveDragTabId] = createSignal<string | null>(null);
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

  let suppressClickUntil = 0;

  function handleDragStart(event: any) {
    if (!canReorder()) return;
    const sourceTabId = fromTabDndId(event?.operation?.source?.id);
    setActiveDragTabId(sourceTabId);
  }

  function handleDragEnd(event: any) {
    const sourceTabId =
      fromTabDndId(event?.operation?.source?.id) ??
      activeDragTabId();
    const targetTabId = fromTabDndId(event?.operation?.target?.id);
    setActiveDragTabId(null);

    if (sourceTabId) {
      suppressClickUntil = Date.now() + 150;
    }

    if (event?.canceled) return;
    if (!sourceTabId || !targetTabId || sourceTabId === targetTabId) return;

    const currentOrder = tabs().map((t) => t.id);
    const sourceIdx = currentOrder.indexOf(sourceTabId);
    const targetIdx = currentOrder.indexOf(targetTabId);
    if (sourceIdx === -1 || targetIdx === -1) return;

    const newOrder = [...currentOrder];
    newOrder[sourceIdx] = currentOrder[targetIdx]!;
    newOrder[targetIdx] = currentOrder[sourceIdx]!;
    props.tabStore.reorderTabs(newOrder);
  }

  function getTabNameByDndId(dndId: unknown): string {
    const tabId = fromTabDndId(dndId);
    if (!tabId) return "";
    return displayNames().get(tabId) ?? "";
  }

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
      <DragDropProvider
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div
          class="tab-bar-list"
          ref={listRef}
          onScroll={updateScrollState}
        >
          <For each={tabs()}>
            {(tab) => (
              <DraggableTab
                tab={tab}
                isActive={tab.id === activeTabId()}
                isDirty={tab.id === activeTabId() ? (props.activeTabDirty ?? false) : tab.editorContent !== tab.savedContent}
                displayName={displayNames().get(tab.id) ?? tab.fileName}
                canReorder={canReorder()}
                onActivate={() => {
                  if (Date.now() < suppressClickUntil) return;
                  props.onActivateTab(tab.id);
                }}
                onClose={() => props.onCloseTab(tab.id)}
                onCloseOthers={() => props.tabStore.closeOtherTabs(tab.id)}
                onCloseAll={() => props.tabStore.closeAllTabs()}
                onCloseToRight={() => props.tabStore.closeTabsToRight(tab.id)}
              />
            )}
          </For>
        </div>
        <DragOverlay>
          {(draggable) => (
            <div class="tab-bar-item tab-bar-item-active tab-bar-drag-overlay">
              <span class="tab-bar-item-name">
                {getTabNameByDndId(draggable?.id)}
              </span>
            </div>
          )}
        </DragOverlay>
      </DragDropProvider>
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
