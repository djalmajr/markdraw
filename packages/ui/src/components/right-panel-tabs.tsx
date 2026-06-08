import { For, Show, createEffect, createSignal, type JSX } from "solid-js";
import IconListTree from "~icons/lucide/list-tree";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

const SCROLL_STEP = 150;

export interface RightPanelTab {
  /** "toc" for the pinned tab, or the chat session id for chat tabs. */
  id: string;
  kind: "toc" | "chat";
  title: string;
  /** Chat only — drives the activity dot on inactive tabs. */
  streaming?: boolean;
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
  tabs: RightPanelTab[];
  /** Encoded active id: "toc" | "backlinks" | "chat:<id>". When "backlinks" the
   *  References content is fronted from the overflow menu and no strip tab is
   *  highlighted. */
  activeId: string;
  /** Emits "toc" | "chat:<id>" when a strip tab is clicked. */
  onSelect: (encodedId: string) => void;
  onCloseChat: (sessionId: string) => void;
  onNewChat?: () => void;
  /** "…" overflow contents (host-built so they reflect the active tab). */
  overflowItems: RightPanelOverflowItem[];
  /** The history dropdown trigger+content, rendered in the actions cluster. */
  historySlot?: JSX.Element;
}

/**
 * The unified right-panel tab strip: a pinned TOC tab + N chat tabs, with the
 * `+` (new chat), history, "…" overflow (References + TOC options) and a
 * panel-collapse control on the right. Mirrors the document `.tab-bar`
 * (overflow scroll, active underline, close button). Purely presentational —
 * all state arrives via props.
 */
export function RightPanelTabs(props: RightPanelTabsProps): JSX.Element {
  const [hasOverflow, setHasOverflow] = createSignal(false);
  const [canScrollLeft, setCanScrollLeft] = createSignal(false);
  const [canScrollRight, setCanScrollRight] = createSignal(false);
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

  const isActive = (tab: RightPanelTab): boolean =>
    tab.kind === "toc" ? props.activeId === "toc" : props.activeId === `chat:${tab.id}`;

  const encode = (tab: RightPanelTab): string => (tab.kind === "toc" ? "toc" : `chat:${tab.id}`);

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
            <Show
              when={tab.kind === "chat"}
              fallback={
                <button
                  type="button"
                  class="rp-tab rp-tab-pinned"
                  classList={{ "rp-tab-active": isActive(tab) }}
                  data-rp-tab={encode(tab)}
                  role="tab"
                  aria-selected={isActive(tab)}
                  onClick={() => props.onSelect(encode(tab))}
                >
                  <IconListTree width={13} height={13} class="rp-tab-icon" />
                  <span class="rp-tab-name">{tab.title}</span>
                </button>
              }
            >
              <Tooltip openDelay={600}>
                <TooltipTrigger
                  as="div"
                  class="rp-tab"
                  classList={{ "rp-tab-active": isActive(tab) }}
                  data-rp-tab={encode(tab)}
                  role="tab"
                  aria-selected={isActive(tab)}
                  onClick={() => props.onSelect(encode(tab))}
                  onMouseDown={(e: MouseEvent) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      props.onCloseChat(tab.id);
                    }
                  }}
                >
                  <Show when={tab.streaming && !isActive(tab)}>
                    <span class="rp-tab-dot" aria-hidden="true" />
                  </Show>
                  <span class="rp-tab-name">{tab.title}</span>
                  <button
                    type="button"
                    class="rp-tab-close"
                    aria-label={(useLocale(), m.ai_close_chat())}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onCloseChat(tab.id);
                    }}
                  >
                    <IconX width={12} height={12} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{tab.title}</TooltipContent>
              </Tooltip>
            </Show>
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
