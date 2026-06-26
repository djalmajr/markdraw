import { For, Show, createSignal, type JSX } from "solid-js";
import IconCheck from "~icons/lucide/check";
import IconChevronDown from "~icons/lucide/chevron-down";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";

export interface PillOption {
  value: string;
  label: string;
}

export interface PillPickerProps {
  options: PillOption[];
  /** Currently selected value. */
  current?: string;
  /** Label shown on the trigger pill. */
  currentLabel: string;
  onSelect: (value: string) => void;
  ariaLabel?: string;
  title?: string;
  /** Capitalize the trigger + row labels (e.g. reasoning effort: off/low/…). */
  capitalize?: boolean;
}

/**
 * A compact popover picker that shares the {@link ModelPicker}'s look — the same
 * `.ai-mp-trigger` pill and `.ai-mp-popover` rows with a right-aligned check —
 * but without the search header or provider groups. Used for the composer bar's
 * short-list selects (mode, reasoning effort) so all three pills are consistent.
 */
export function PillPicker(props: PillPickerProps): JSX.Element {
  const [open, setOpen] = createSignal(false);

  function pick(value: string): void {
    props.onSelect(value);
    setOpen(false);
  }

  return (
    <Popover open={open()} onOpenChange={setOpen} placement="bottom-start" gutter={4}>
      <PopoverTrigger
        as="button"
        class="ai-mp-trigger"
        title={props.title ?? props.currentLabel}
        aria-label={props.ariaLabel ?? props.currentLabel}
      >
        <span class="ai-mp-trigger-label" classList={{ "ai-mp-capitalize": props.capitalize }}>
          {props.currentLabel}
        </span>
        <IconChevronDown width={13} height={13} class="ai-mp-trigger-chevron" />
      </PopoverTrigger>
      <PopoverContent class="ai-mp-popover ai-mp-popover-compact">
        <div class="ai-mp-list">
          <For each={props.options}>
            {(opt) => (
              <button
                type="button"
                class="ai-mp-row"
                classList={{
                  "ai-mp-row-active": opt.value === props.current,
                  "ai-mp-capitalize": props.capitalize,
                }}
                onClick={() => pick(opt.value)}
              >
                <span class="ai-mp-row-label">{opt.label}</span>
                <Show when={opt.value === props.current}>
                  <IconCheck width={14} height={14} class="ai-mp-row-check" />
                </Show>
              </button>
            )}
          </For>
        </div>
      </PopoverContent>
    </Popover>
  );
}
