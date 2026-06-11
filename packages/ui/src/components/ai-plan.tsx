import { For, Show, createSignal, type JSX } from "solid-js";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconX from "~icons/lucide/x";

/** One checklist entry of the live AI plan. Structurally matches the
 *  AppState's AiPlanItem so the host can thread `s.aiPlan().items` straight
 *  through without conversion. */
export interface AiPlanItemModel {
  done: boolean;
  text: string;
}

export interface AiPlanProps {
  items: AiPlanItemModel[];
  onClear: () => void;
  onToggleItem: (index: number) => void;
}

/**
 * The live plan card: a collapsible checklist the model maintains
 * (app__update_plan replaces the whole list each call) and the user steers by
 * checking items off. Pure view — the host owns the plan state
 * (AppState.aiPlan) and threads items + handlers down; collapse is the only
 * local concern.
 */
export function AiPlan(props: AiPlanProps): JSX.Element {
  const [collapsed, setCollapsed] = createSignal(false);
  const doneCount = () => props.items.filter((item) => item.done).length;

  return (
    <div class="ai-plan">
      <div class="ai-plan-header">
        <button
          aria-expanded={!collapsed()}
          class="ai-plan-toggle"
          type="button"
          onClick={() => setCollapsed((value) => !value)}
        >
          <IconChevronDown
            class={collapsed() ? "ai-plan-chevron ai-plan-chevron-collapsed" : "ai-plan-chevron"}
            height={14}
            width={14}
          />
          <span class="ai-plan-title">{(useLocale(), m.ai_mode_plan())}</span>
          <span class="ai-plan-counter">{`${doneCount()}/${props.items.length}`}</span>
        </button>
        <button
          aria-label={(useLocale(), m.ai_context_remove())}
          class="ai-plan-clear"
          title={(useLocale(), m.ai_context_remove())}
          type="button"
          onClick={() => props.onClear()}
        >
          <IconX height={12} width={12} />
        </button>
      </div>
      <Show when={!collapsed()}>
        <ul class="ai-plan-items">
          <For each={props.items}>
            {(item, index) => (
              <li class="ai-plan-item" classList={{ "ai-plan-item-done": item.done }}>
                <label class="ai-plan-item-label">
                  <input
                    checked={item.done}
                    class="ai-plan-checkbox"
                    type="checkbox"
                    onChange={() => props.onToggleItem(index())}
                  />
                  <span class="ai-plan-item-text">{item.text}</span>
                </label>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
