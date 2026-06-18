import { Show, type JSX } from "solid-js";
import IconSparkles from "~icons/lucide/sparkles";
import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";

// Platform-correct hint for the ⌘I/Ctrl+I binding (same detection style as
// editor-diff's MOD_LABEL — a hardcoded ⌘ read wrong on Windows).
const AI_HINT_KBD =
  typeof navigator !== "undefined" && navigator.platform.startsWith("Mac") ? "⌘I" : "Ctrl+I";

export interface SelectionPopoverProps {
  /** Screen coords of the selection end, or null when hidden. */
  info: { left: number; bottom: number } | null;
  onAddToChat: () => void;
}

/**
 * A small floating menu anchored under the editor selection — "Add to chat"
 * attaches the selection to the chat as a context chip (also bound to ⌘I).
 * `onMouseDown` is prevented so clicking the button doesn't blur the editor
 * before the action reads the stored selection.
 */
export function SelectionPopover(props: SelectionPopoverProps): JSX.Element {
  return (
    <Show when={props.info}>
      {(info) => (
        <div
          class="selection-popover no-print"
          style={{
            left: `${Math.max(8, Math.min(info().left, window.innerWidth - 200))}px`,
            top: `${info().bottom + 6}px`,
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button type="button" class="selection-popover-btn" onClick={() => props.onAddToChat()}>
            <IconSparkles width={13} height={13} />
            <span>{(useLocale(), m.ai_add_to_chat())}</span>
            <kbd class="selection-popover-kbd">{AI_HINT_KBD}</kbd>
          </button>
        </div>
      )}
    </Show>
  );
}
