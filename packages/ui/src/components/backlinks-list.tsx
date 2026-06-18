import { For, Show } from "solid-js";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";

export interface BacklinkEntry {
  /** Workspace path of the linking source file. */
  path: string;
  /** Display label — typically the basename. */
  label: string;
  /** Optional rootId so the click handler knows which workspace it
   *  belongs to (a single Markdraw window can have multiple roots). */
  rootId?: string;
}

export interface BacklinksListProps {
  /** Sources that reference the current document. Empty array → the
   *  empty-state message. */
  entries: BacklinkEntry[];
  /** Callback when the user clicks a row. The host resolves the
   *  click into a `loadFileContent` / `loadInActiveTab` call. */
  onSelect: (entry: BacklinkEntry) => void;
}

/**
 * Pure list of inbound references for the active document. Lives
 * inside the right gutter, beneath the TOC. Visibility is owned by
 * the panel host (`<Show>` around this component) — the list itself
 * always renders, falling back to the empty-state copy when there
 * are no entries to show.
 */
export function BacklinksList(props: BacklinksListProps) {
  return (
    <section class="backlinks-section">
      <Show
        when={props.entries.length > 0}
        fallback={
          <p class="backlinks-empty">{(useLocale(), m.backlinks_empty())}</p>
        }
      >
        <ul class="backlinks-tree">
          <For each={props.entries}>
            {(entry) => (
              <li class="backlinks-item">
                <button
                  class="backlinks-link"
                  type="button"
                  title={entry.path}
                  onClick={() => props.onSelect(entry)}
                >
                  {entry.label}
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
