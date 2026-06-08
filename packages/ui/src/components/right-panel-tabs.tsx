import { For, Show, createEffect, createSignal, type JSX } from "solid-js";
import IconListTree from "~icons/lucide/list-tree";
import IconLink from "~icons/lucide/link";
import IconPin from "~icons/lucide/pin";
import IconPlus from "~icons/lucide/plus";
import IconEllipsis from "~icons/lucide/ellipsis";
import IconX from "~icons/lucide/x";
import IconCheck from "~icons/lucide/check";
import IconChevronLeft from "~icons/lucide/chevron-left";
import IconChevronRight from "~icons/lucide/chevron-right";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu.tsx";

const SCROLL_STEP = 150;

export interface RightPanelTab {
  /** "toc" | "backlinks" (special panes) or a chat session id. */
  id: string;
  kind: "toc" | "backlinks" | "chat";
  /** Chat title (specials derive their label from `kind`). */
  title: string;
  /** Chat only — drives the activity dot on inactive tabs. */
  streaming?: boolean;
  /** Pinned tabs sort left, show a pin glyph, and resist bulk close. */
  pinned?: boolean;
}

export interface RightPanelOverflowItem {
  id: string;
  label: string;
  checked?: boolean;
  separatorBefore?: boolean;
  /** Optional trailing count (e.g. the backlinks count on References). */
  count?: number;
  onSelect: () => void;
}

export interface RightPanelTabsProps {
  /** Ordered (pinned-first) strip tabs. */
  tabs: RightPanelTab[];
  /** Encoded active id: "toc" | "backlinks" | "chat:<id>" | "". */
  activeId: string;
  /** Emits the encoded id when a strip tab is clicked. */
  onSelect: (encodedId: string) => void;
  /** Close one tab (encoded id). */
  onClose: (encodedId: string) => void;
  onCloseOthers: (encodedId: string) => void;
  onCloseToRight: (encodedId: string) => void;
  onCloseAll: () => void;
  onTogglePin: (encodedId: string) => void;
  // Chat-only actions (by session id).
  onRenameChat?: (id: string, title: string) => void;
  onExportChat?: (id: string) => void;
  onArchiveChat?: (id: string) => void;
  onDeleteChat?: (id: string) => void;
  onNewChat?: () => void;
  /** "…" overflow contents (host-built so they reflect the active tab). */
  overflowItems: RightPanelOverflowItem[];
  /** The history dropdown trigger+content, rendered in the actions cluster. */
  historySlot?: JSX.Element;
}

const encode = (tab: RightPanelTab): string => (tab.kind === "chat" ? `chat:${tab.id}` : tab.id);

/**
 * The unified right-panel tab strip. All tabs (the openable Outline / References
 * specials and N chat tabs) render uniformly: pinned-first, each with a
 * right-click context menu (Pin/Unpin, Close, Close others/to the right/all, and
 * for chats Export / Rename / Archive / Delete) and inline rename. The `+` (new
 * chat), history and "…" overflow controls live on the right. Purely
 * presentational — all state arrives via props.
 */
export function RightPanelTabs(props: RightPanelTabsProps): JSX.Element {
  const [hasOverflow, setHasOverflow] = createSignal(false);
  const [canScrollLeft, setCanScrollLeft] = createSignal(false);
  const [canScrollRight, setCanScrollRight] = createSignal(false);
  // The chat session id currently being renamed inline, or null.
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");
  let listRef: HTMLDivElement | undefined;

  function updateScrollState(): void {
    if (!listRef) return;
    const { scrollLeft, scrollWidth, clientWidth } = listRef;
    setHasOverflow(scrollWidth > clientWidth + 1);
    setCanScrollLeft(scrollLeft > 0);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }

  // Re-measure when the tab set changes and scroll the active tab into view.
  createEffect(() => {
    props.tabs;
    props.activeId;
    queueMicrotask(() => {
      if (listRef && props.activeId) {
        const el = listRef.querySelector(`[data-rp-tab="${CSS.escape(props.activeId)}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      }
      updateScrollState();
    });
  });

  const isActive = (tab: RightPanelTab): boolean => props.activeId === encode(tab);

  const labelOf = (tab: RightPanelTab): string => {
    useLocale();
    if (tab.kind === "toc") return m.toc_tab_outline();
    if (tab.kind === "backlinks") return m.toc_tab_references();
    return tab.title || m.ai_chat_default_title();
  };

  function startRename(tab: RightPanelTab): void {
    if (tab.kind !== "chat") return;
    setDraft(tab.title || "");
    setEditingId(tab.id);
  }
  function commitRename(): void {
    const id = editingId();
    if (id) props.onRenameChat?.(id, draft());
    setEditingId(null);
  }

  return (
    <div class="rp-strip">
      <Show when={hasOverflow()}>
        <button
          class="rp-strip-scroll"
          classList={{ "rp-strip-scroll-disabled": !canScrollLeft() }}
          onClick={() => listRef?.scrollBy({ left: -SCROLL_STEP, behavior: "smooth" })}
          aria-label="Scroll tabs left"
        >
          <IconChevronLeft width={14} height={14} />
        </button>
      </Show>

      <div class="rp-strip-tabs" ref={listRef} onScroll={updateScrollState} role="tablist">
        <For each={props.tabs}>
          {(tab) => (
            <ContextMenu>
              <ContextMenuTrigger
                as="div"
                class="rp-tab"
                classList={{ "rp-tab-active": isActive(tab), "rp-tab-pinned": !!tab.pinned }}
                data-rp-tab={encode(tab)}
                title={labelOf(tab)}
                role="tab"
                aria-selected={isActive(tab)}
                onClick={() => {
                  if (editingId() !== tab.id) props.onSelect(encode(tab));
                }}
                onDblClick={() => startRename(tab)}
                onMouseDown={(e: MouseEvent) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    props.onClose(encode(tab));
                  }
                }}
              >
                <Show when={tab.pinned}>
                  <IconPin width={11} height={11} class="rp-tab-pin" />
                </Show>
                <Show when={tab.kind === "toc"}>
                  <IconListTree width={13} height={13} class="rp-tab-icon" />
                </Show>
                <Show when={tab.kind === "backlinks"}>
                  <IconLink width={12} height={12} class="rp-tab-icon" />
                </Show>
                <Show when={tab.kind === "chat" && tab.streaming && !isActive(tab)}>
                  <span class="rp-tab-dot" aria-hidden="true" />
                </Show>
                <Show
                  when={editingId() === tab.id}
                  fallback={<span class="rp-tab-name">{labelOf(tab)}</span>}
                >
                  <input
                    class="rp-tab-rename"
                    value={draft()}
                    autofocus
                    aria-label={(useLocale(), `${m.ai_tab_rename()}: ${labelOf(tab)}`)}
                    onClick={(e) => e.stopPropagation()}
                    onInput={(e) => setDraft(e.currentTarget.value)}
                    onBlur={(e) => {
                      // Don't commit if focus is moving into a menu/popover (e.g.
                      // right-clicking the tab while editing) — that isn't "done".
                      const next = e.relatedTarget;
                      if (next instanceof HTMLElement && next.closest('[role="menu"]')) return;
                      commitRename();
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") setEditingId(null);
                    }}
                  />
                </Show>
                {/* Hide close while renaming so a stray Tab/click can't drop the
                    tab mid-edit. */}
                <Show when={editingId() !== tab.id}>
                  <button
                    type="button"
                    class="rp-tab-close"
                    aria-label={(useLocale(), m.tab_close())}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onClose(encode(tab));
                    }}
                  >
                    <IconX width={12} height={12} />
                  </button>
                </Show>
              </ContextMenuTrigger>

              <ContextMenuContent class="rp-tab-menu">
                <ContextMenuItem onSelect={() => props.onTogglePin(encode(tab))}>
                  {tab.pinned ? (useLocale(), m.ai_tab_unpin()) : (useLocale(), m.ai_tab_pin())}
                </ContextMenuItem>
                <Show when={tab.kind === "chat"}>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => startRename(tab)}>
                    {(useLocale(), m.ai_tab_rename())}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => props.onExportChat?.(tab.id)}>
                    {(useLocale(), m.ai_tab_export())}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => props.onArchiveChat?.(tab.id)}>
                    {(useLocale(), m.ai_chat_archive())}
                  </ContextMenuItem>
                </Show>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => props.onClose(encode(tab))}>
                  {(useLocale(), m.tab_close())}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => props.onCloseOthers(encode(tab))}>
                  {(useLocale(), m.tab_close_others())}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => props.onCloseToRight(encode(tab))}>
                  {(useLocale(), m.tab_close_to_right())}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => props.onCloseAll()}>
                  {(useLocale(), m.tab_close_all())}
                </ContextMenuItem>
                <Show when={tab.kind === "chat"}>
                  <ContextMenuSeparator />
                  <ContextMenuItem class="rp-tab-menu-danger" onSelect={() => props.onDeleteChat?.(tab.id)}>
                    {(useLocale(), m.ai_chat_delete())}
                  </ContextMenuItem>
                </Show>
              </ContextMenuContent>
            </ContextMenu>
          )}
        </For>
      </div>

      <Show when={hasOverflow()}>
        <button
          class="rp-strip-scroll"
          classList={{ "rp-strip-scroll-disabled": !canScrollRight() }}
          onClick={() => listRef?.scrollBy({ left: SCROLL_STEP, behavior: "smooth" })}
          aria-label="Scroll tabs right"
        >
          <IconChevronRight width={14} height={14} />
        </button>
      </Show>

      <div class="rp-strip-actions">
        <Show when={props.onNewChat}>
          <button
            type="button"
            class="rp-icon-btn"
            title={(useLocale(), m.ai_new_chat())}
            aria-label={(useLocale(), m.ai_new_chat())}
            onClick={() => {
              props.onNewChat!();
              queueMicrotask(() => {
                listRef?.scrollTo({ left: listRef.scrollWidth, behavior: "smooth" });
                updateScrollState();
              });
            }}
          >
            <IconPlus width={15} height={15} />
          </button>
        </Show>

        {props.historySlot}

        <DropdownMenu>
          <DropdownMenuTrigger
            as="button"
            class="rp-icon-btn"
            title={(useLocale(), m.ai_more_options())}
            aria-label={(useLocale(), m.ai_more_options())}
          >
            <IconEllipsis width={15} height={15} />
          </DropdownMenuTrigger>
          <DropdownMenuContent class="rp-overflow-menu">
            <For each={props.overflowItems}>
              {(item) => (
                <>
                  <Show when={item.separatorBefore}>
                    <DropdownMenuSeparator />
                  </Show>
                  <DropdownMenuItem onSelect={item.onSelect}>
                    <span class="flex-1">{item.label}</span>
                    <Show when={item.count != null && item.count > 0}>
                      <span class="rp-overflow-count">{item.count}</span>
                    </Show>
                    <Show when={item.checked}>
                      <IconCheck width={14} height={14} />
                    </Show>
                  </DropdownMenuItem>
                </>
              )}
            </For>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
