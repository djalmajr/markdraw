import { Show, type JSX } from "solid-js";
import IconSparkles from "~icons/lucide/sparkles";
import IconPencil from "~icons/lucide/pencil";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";

export interface SelectionPopoverProps {
  /** Screen coords of the selection end, or null when hidden. */
  info: { left: number; bottom: number } | null;
  onAddToChat: () => void;
  onQuickEdit: () => void;
}

/**
 * A small floating menu anchored under the editor selection — "Add to chat"
 * (attach the selection as chat context) and "Quick Edit" (the inline ⌘I
 * overlay). Mirror of Cursor's selection bubble. `onMouseDown` is prevented so
 * clicking a button doesn't blur the editor before the action reads the stored
 * selection.
 */
export function SelectionPopover(props: SelectionPopoverProps): JSX.Element {
  return (
    <Show when={props.info}>
      {(info) => (
        <div
          class="selection-popover no-print"
          style={{
            left: `${Math.max(8, Math.min(info().left, window.innerWidth - 230))}px`,
            top: `${info().bottom + 6}px`,
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button type="button" class="selection-popover-btn" onClick={() => props.onAddToChat()}>
            <IconSparkles width={13} height={13} />
            <span>{(useLocale(), m.ai_add_to_chat())}</span>
            <kbd class="selection-popover-kbd">⌘L</kbd>
          </button>
          <button type="button" class="selection-popover-btn" onClick={() => props.onQuickEdit()}>
            <IconPencil width={13} height={13} />
            <span>{(useLocale(), m.ai_quick_edit())}</span>
            <kbd class="selection-popover-kbd">⌘I</kbd>
          </button>
        </div>
      )}
    </Show>
  );
}
