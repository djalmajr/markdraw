import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import IconCopy from "~icons/lucide/copy";
import IconHistory from "~icons/lucide/history";
import IconSearch from "~icons/lucide/search";
import IconArchive from "~icons/lucide/archive";
import IconArchiveRestore from "~icons/lucide/archive-restore";
import IconTrash from "~icons/lucide/trash-2";
import IconEllipsis from "~icons/lucide/ellipsis";
import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";
import { groupChatSessions, searchChatSessions } from "@markdraw/core/ai-chat-sessions.ts";
import type { AiChatSessionMeta } from "../composables/create-ai-chat-sessions.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";

export interface ChatHistoryMenuProps {
  /** Every session (open + closed + archived). */
  items: AiChatSessionMeta[];
  activeId: string | null;
  /** Localized label for untitled chats. */
  defaultTitle: string;
  /** Injected for tests; defaults to the wall clock. */
  now?: () => number;
  onActivate: (id: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  /** Duplicate the session into a new chat. The row action renders only when
   *  this is provided. */
  onForkSession?: (id: string) => void;
  onRestore: (id: string) => void;
}

/**
 * The chat-history dropdown: a searchable list grouped into Today / Earlier /
 * Archived, with per-row archive·restore·delete. Uses a kobalte `Popover` (not
 * a menu) so it can host a focusable search input. Pure presentational — the
 * grouping/search logic comes from `@markdraw/core`.
 */
export function ChatHistoryMenu(props: ChatHistoryMenuProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");

  const grouped = createMemo(() => {
    const now = props.now?.() ?? Date.now();
    return groupChatSessions(searchChatSessions(props.items, query()), now);
  });
  const earlier = createMemo(() => {
    const g = grouped();
    return [...g.yesterday, ...g.previous7Days, ...g.older];
  });
  const isEmpty = createMemo(() => {
    const g = grouped();
    return g.today.length === 0 && earlier().length === 0 && g.archived.length === 0;
  });

  const label = (s: AiChatSessionMeta): string => s.title || props.defaultTitle;

  function activate(id: string): void {
    props.onActivate(id);
    setOpen(false);
  }

  const Row = (p: { s: AiChatSessionMeta }): JSX.Element => (
    <div
      class="rp-history-row"
      classList={{ "rp-history-row-active": p.s.id === props.activeId }}
      onClick={() => activate(p.s.id)}
    >
      <span class="rp-history-row-title">{label(p.s)}</span>
      <DropdownMenu>
        <DropdownMenuTrigger
          as="button"
          class="rp-history-row-menu"
          aria-label={(useLocale(), m.ai_more_options())}
          onClick={(e: MouseEvent) => e.stopPropagation()}
        >
          <IconEllipsis width={14} height={14} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <Show when={props.onForkSession}>
            <DropdownMenuItem onSelect={() => props.onForkSession?.(p.s.id)}>
              <IconCopy width={14} height={14} />
              <span class="flex-1">{(useLocale(), m.chat_fork())}</span>
            </DropdownMenuItem>
          </Show>
          <Show
            when={p.s.isArchived}
            fallback={
              <DropdownMenuItem onSelect={() => props.onArchive(p.s.id)}>
                <IconArchive width={14} height={14} />
                <span class="flex-1">{(useLocale(), m.ai_chat_archive())}</span>
              </DropdownMenuItem>
            }
          >
            <DropdownMenuItem onSelect={() => props.onRestore(p.s.id)}>
              <IconArchiveRestore width={14} height={14} />
              <span class="flex-1">{(useLocale(), m.ai_chat_restore())}</span>
            </DropdownMenuItem>
          </Show>
          <DropdownMenuSeparator />
          <DropdownMenuItem class="rp-history-delete" onSelect={() => props.onDelete(p.s.id)}>
            <IconTrash width={14} height={14} />
            <span class="flex-1">{(useLocale(), m.ai_chat_delete())}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <Popover open={open()} onOpenChange={setOpen} placement="bottom-end">
      <PopoverTrigger
        as="button"
        class="rp-icon-btn"
        title={(useLocale(), m.ai_history())}
        aria-label={(useLocale(), m.ai_history())}
      >
        <IconHistory width={15} height={15} />
      </PopoverTrigger>
      <PopoverContent class="rp-history">
        <div class="rp-history-search">
          <IconSearch width={14} height={14} />
          <input
            type="text"
            placeholder={(useLocale(), m.ai_history_search())}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <div class="rp-history-list">
          <Show when={grouped().today.length > 0}>
            <div class="rp-history-group-label">{(useLocale(), m.ai_history_today())}</div>
            <For each={grouped().today}>{(s) => <Row s={s} />}</For>
          </Show>
          <Show when={earlier().length > 0}>
            <div class="rp-history-group-label">{(useLocale(), m.ai_history_earlier())}</div>
            <For each={earlier()}>{(s) => <Row s={s} />}</For>
          </Show>
          <Show when={grouped().archived.length > 0}>
            <div class="rp-history-group-label">{(useLocale(), m.ai_history_archived())}</div>
            <For each={grouped().archived}>{(s) => <Row s={s} />}</For>
          </Show>
          <Show when={isEmpty()}>
            <p class="rp-history-empty">{(useLocale(), m.ai_history_empty())}</p>
          </Show>
        </div>
      </PopoverContent>
    </Popover>
  );
}
