import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import IconSearch from "~icons/lucide/search";
import IconSlidersHorizontal from "~icons/lucide/sliders-horizontal";
import IconCheck from "~icons/lucide/check";
import IconChevronDown from "~icons/lucide/chevron-down";
import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";

export interface ModelOption {
  /** "provider/model" ref. */
  value: string;
  label: string;
}

export interface ModelGroup {
  /** Provider id. */
  id: string;
  /** Provider display name (group header). */
  name: string;
  /** Whether this group's models come from a CLI subscription or an API key —
   *  appended to the header so the user can tell the source apart. */
  origin?: "subscription" | "api";
  models: ModelOption[];
}

export interface ModelPickerProps {
  groups: ModelGroup[];
  /** Current "provider/model" ref. */
  current?: string;
  /** Label shown on the trigger pill. */
  currentLabel: string;
  onSelect: (value: string) => void;
  variant?: "pill" | "form";
  /** "⚙" — open the model manager (Settings → AI), where providers are
   *  connected/added and model visibility is toggled. */
  onManage?: () => void;
}

/**
 * The chat model picker (OpenCode-style): a compact pill that opens a popover
 * with a search box, a `+` (connect provider) and `⚙` (manage models) in the
 * header, and the available models grouped by provider with the current one
 * checked. Uses a kobalte `Popover` (not a menu) so it can host the search
 * input. Management lives in Settings — the header buttons just open it.
 */
export function ModelPicker(props: ModelPickerProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");

  const filtered = createMemo<ModelGroup[]>(() => {
    const q = query().trim().toLowerCase();
    const groups = q
      ? props.groups.map((g) => ({
          ...g,
          models: g.models.filter(
            (mdl) => mdl.label.toLowerCase().includes(q) || g.name.toLowerCase().includes(q),
          ),
        }))
      : props.groups;
    return groups.filter((g) => g.models.length > 0);
  });

  const isEmpty = createMemo(() => filtered().length === 0);

  function pick(value: string): void {
    props.onSelect(value);
    setOpen(false);
  }

  // On open, bring the selected model into view (catalogs run long — the active
  // row is often below the fold). Runs once when the list mounts (the search
  // input re-filters the rows but keeps the same list element, so re-typing
  // doesn't re-scroll). Scrolls only the list (a relative delta, not
  // scrollIntoView) so the surrounding page never moves.
  function scrollActiveIntoView(list: HTMLDivElement): void {
    requestAnimationFrame(() => {
      const active = list.querySelector<HTMLElement>(".ai-mp-row-active");
      if (!active || list.clientHeight === 0) return;
      const delta =
        active.getBoundingClientRect().top -
        list.getBoundingClientRect().top -
        (list.clientHeight - active.clientHeight) / 2;
      list.scrollTop += delta;
    });
  }

  return (
    <Popover open={open()} onOpenChange={setOpen} placement="bottom-start" gutter={4}>
      <PopoverTrigger
        as="button"
        class="ai-mp-trigger"
        classList={{
          "ai-mp-trigger-grow": props.variant !== "form",
          "ai-mp-trigger-form": props.variant === "form",
        }}
        title={props.currentLabel}
        aria-label={props.currentLabel}
      >
        <span class="ai-mp-trigger-label">{props.currentLabel}</span>
        <IconChevronDown width={13} height={13} class="ai-mp-trigger-chevron" />
      </PopoverTrigger>
      <PopoverContent class="ai-mp-popover">
        <div class="ai-mp-header">
          <div class="ai-mp-search">
            <IconSearch width={14} height={14} />
            <input
              type="text"
              placeholder={(useLocale(), m.ai_model_search())}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
          <Show when={props.onManage}>
            <button
              type="button"
              class="ai-mp-icon-btn"
              title={(useLocale(), m.ai_manage_models())}
              aria-label={(useLocale(), m.ai_manage_models())}
              onClick={() => {
                setOpen(false);
                props.onManage?.();
              }}
            >
              <IconSlidersHorizontal width={15} height={15} />
            </button>
          </Show>
        </div>
        <div class="ai-mp-list" ref={scrollActiveIntoView}>
          <For each={filtered()}>
            {(group) => (
              <>
                <div class="ai-mp-group-label">
                  {(useLocale(),
                  group.origin
                    ? `${group.name} · ${group.origin === "subscription" ? m.ai_origin_subscription() : m.ai_origin_api()}`
                    : group.name)}
                </div>
                <For each={group.models}>
                  {(mdl) => (
                    <button
                      type="button"
                      class="ai-mp-row"
                      classList={{ "ai-mp-row-active": mdl.value === props.current }}
                      onClick={() => pick(mdl.value)}
                    >
                      <span class="ai-mp-row-label">{mdl.label}</span>
                      <Show when={mdl.value === props.current}>
                        <IconCheck width={14} height={14} class="ai-mp-row-check" />
                      </Show>
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
          <Show when={isEmpty()}>
            <p class="ai-mp-empty">{(useLocale(), m.ai_model_none())}</p>
          </Show>
        </div>
      </PopoverContent>
    </Popover>
  );
}
