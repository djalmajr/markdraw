import { Show, createMemo, createSignal, For, onSettled, createEffect } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Portal } from "@solidjs/web";

export interface PaletteProps<T> {
  open: boolean;
  items: readonly T[];
  /**
   * Returns the visible, ordered subset of `items` for the current query.
   * Caller owns the ranking strategy — `QuickOpen` plugs in fuzzy file
   * matching, `CommandPalette` plugs in a substring filter, etc. The
   * returned array preserves the order the rows should render in.
   */
  filter: (query: string, items: readonly T[]) => readonly T[];
  /** Stable key per item — reactive identity for the active-row highlight. */
  getKey: (item: T) => string;
  /** Renders one row. `isActive` lets the caller add the focus class. */
  renderRow: (item: T, query: string, isActive: boolean) => JSX.Element;
  placeholder?: string;
  /** Shown when `items` is empty (workspace empty / no commands at all). */
  emptyItemsMessage?: string;
  /** Shown when `filter` returns nothing for a non-empty query. */
  emptyResultsMessage?: string;
  ariaLabel?: string;
  onSelect: (item: T) => void;
  onClose: () => void;
}

/**
 * Generic command-palette shell. Owns the modal lifecycle, the input,
 * the keyboard navigation, and the active-row highlight. Knows nothing
 * about file ranking, command shapes, or symbol navigation — each
 * caller supplies an item list, a filter, and a row renderer.
 *
 * The fuzzy file picker (`QuickOpen`), the action palette
 * (`CommandPalette`), and the heading palette (`SymbolPalette`) all
 * compose this primitive instead of duplicating the keyboard handler.
 */
export function Palette<T>(props: PaletteProps<T>) {
  const [query, setQuery] = createSignal("");
  const [activeIndex, setActiveIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;
  let listRef: HTMLUListElement | undefined;

  const filtered = createMemo<readonly T[]>(() => {
    if (!props.open) return [];
    return props.filter(query(), props.items);
  });

  // Persist query + selection across open/close cycles. The user can
  // dismiss the palette (Esc, click outside, pick) and come back to
  // their previous filter — matches VS Code's Cmd+P behavior. The
  // initial focus is paired with `select()` so the first keystroke
  // either replaces the previous query (just type) or refines it
  // (press End / arrow keys to deselect first).
  createEffect(() => props.open, (open) => {
    if (!open) return;
    queueMicrotask(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  });

  // Clamp the active index when the result set shrinks (the user types
  // more characters and the matching set narrows).
  createEffect(
    () => {
      const length = filtered().length;
      const active = activeIndex();
      return active >= length ? Math.max(0, length - 1) : null;
    },
    (clamped) => {
      if (clamped !== null) setActiveIndex(clamped);
    },
  );

  // Auto-scroll the active row into view inside the list container.
  createEffect(
    () => ({ open: props.open, index: activeIndex() }),
    ({ open, index }) => {
      if (!open || !listRef) return;
      const target = listRef.querySelector<HTMLElement>(`[data-palette-index="${index}"]`);
      target?.scrollIntoView({ block: "nearest" });
    },
  );

  function handleKeyDown(event: KeyboardEvent) {
    const length = filtered().length;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
        break;
      case "ArrowDown":
        event.preventDefault();
        if (length > 0) setActiveIndex((i) => (i + 1) % length);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (length > 0) setActiveIndex((i) => (i - 1 + length) % length);
        break;
      case "PageDown":
        event.preventDefault();
        if (length > 0) setActiveIndex((i) => Math.min(length - 1, i + 10));
        break;
      case "PageUp":
        event.preventDefault();
        if (length > 0) setActiveIndex((i) => Math.max(0, i - 10));
        break;
      case "Home":
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case "End":
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          if (length > 0) setActiveIndex(length - 1);
        }
        break;
      case "Enter": {
        event.preventDefault();
        const picked = filtered()[activeIndex()];
        if (picked !== undefined) props.onSelect(picked);
        break;
      }
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) props.onClose();
  }

  // A document-level Esc capture covers the case where focus has drifted
  // from the input (e.g. the user clicked the backdrop area outside the
  // panel after picking once and didn't re-focus the input).
  onSettled(() => {
    function global(event: KeyboardEvent) {
      if (props.open && event.key === "Escape" && event.target !== inputRef) {
        event.preventDefault();
        props.onClose();
      }
    }
    document.addEventListener("keydown", global, true);
    return () => document.removeEventListener("keydown", global, true);
  });

  return (
    <Show when={props.open}>
      <Portal>
        <div class="quick-open-backdrop" onMouseDown={handleBackdropClick}>
          <div class="quick-open-panel" role="dialog" aria-label={props.ariaLabel ?? "Palette"}>
            <div class="quick-open-input-wrap">
              <input
                ref={inputRef}
                class="quick-open-input"
                type="text"
                placeholder={props.placeholder ?? "Type to filter…"}
                value={query()}
                role="combobox"
                aria-expanded="true"
                aria-controls="palette-list"
                aria-activedescendant={`palette-row-${activeIndex()}`}
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={handleKeyDown}
              />
              <Show when={query().length > 0}>
                <button
                  type="button"
                  class="quick-open-clear"
                  aria-label="Clear search"
                  title="Clear search"
                  onMouseDown={(event) => {
                    // Mousedown so the input doesn't lose focus before
                    // the click handler runs.
                    event.preventDefault();
                    setQuery("");
                    setActiveIndex(0);
                    inputRef?.focus();
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                    <line x1="6" y1="6" x2="18" y2="18" />
                    <line x1="6" y1="18" x2="18" y2="6" />
                  </svg>
                </button>
              </Show>
            </div>
            <ul
              ref={listRef}
              id="palette-list"
              class="quick-open-list"
              role="listbox"
            >
              <Show
                when={filtered().length > 0}
                fallback={
                  <li class="quick-open-empty">
                    {props.items.length === 0
                      ? (props.emptyItemsMessage ?? "Nothing to show")
                      : (props.emptyResultsMessage ?? "No matches")}
                  </li>
                }
              >
                <For each={filtered() as T[]}>
                  {(item, index) => (
                    <li
                      id={`palette-row-${index()}`}
                      data-palette-index={index()}
                      data-palette-key={props.getKey(item)}
                      role="option"
                      aria-selected={index() === activeIndex() ? "true" : "false"}
                      class={["quick-open-row", { "quick-open-row-active": index() === activeIndex() }]}
                      
                      onMouseDown={(event) => {
                        // Mousedown so we pick before the input loses focus
                        // and any blur handlers fire.
                        event.preventDefault();
                        props.onSelect(item);
                      }}
                      onMouseEnter={() => setActiveIndex(index())}
                    >
                      {props.renderRow(item, query(), index() === activeIndex())}
                    </li>
                  )}
                </For>
              </Show>
            </ul>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
