import { Show, type JSX } from "solid-js";
import IconCheck from "~icons/lucide/check";

export interface TierCardProps {
  title: string;
  description: string;
  badge?: string;
  selected: boolean;
  onSelect: () => void;
  /** Render unselectable (dimmed, no-op click) — e.g. Complete with no
   *  embedding provider connected. */
  disabled?: boolean;
  /** Extra line under the description (e.g. why the tier is unavailable). */
  note?: string;
}

/** A Workspace-indexing tier card (Off / Fast / Complete) — DJA-15. */
export function TierCard(props: TierCardProps): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      aria-disabled={props.disabled}
      disabled={props.disabled}
      class="settings-tier-card"
      classList={{
        "settings-tier-card-selected": props.selected,
        "settings-tier-card-disabled": props.disabled,
      }}
      onClick={() => {
        if (!props.disabled) props.onSelect();
      }}
    >
      <div class="settings-tier-head">
        <span class="settings-tier-title">{props.title}</span>
        <Show when={props.badge}>
          <span class="settings-tier-badge">{props.badge}</span>
        </Show>
        <Show when={props.selected}>
          <IconCheck width={14} height={14} class="settings-tier-check" />
        </Show>
      </div>
      <p class="settings-tier-desc">{props.description}</p>
      <Show when={props.note}>
        <p class="settings-tier-note">{props.note}</p>
      </Show>
    </button>
  );
}
