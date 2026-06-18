import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";

export interface FileMatch {
  path: string;
  line_number: number;
  line_text: string;
  column_start: number;
  column_end: number;
}

export interface MatchSelection {
  rootId: string;
  path: string;
  line: number;
}

export interface FindInFilesProps {
  open: boolean;
  /** Active workspace root id. Used to scope the search and to forward
   *  to `onSelect` so the host can resolve the target file. */
  rootId: string | null;
  /** Async search function — the host wraps the IPC call (or any other
   *  backend) and returns matches. Errors should be caught by the host. */
  search: (rootId: string, query: string, opts: { caseSensitive: boolean }) => Promise<FileMatch[]>;
  onSelect: (selection: MatchSelection) => void;
  onClose: () => void;
}

interface FileGroup {
  path: string;
  matches: FileMatch[];
}

const SEARCH_DEBOUNCE_MS = 250;

export function FindInFiles(props: FindInFilesProps) {
  const [query, setQuery] = createSignal("");
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [results, setResults] = createSignal<FileMatch[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  let inputRef: HTMLInputElement | undefined;
  let searchToken = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  // Group results by file path while preserving the order matches arrived
  // in. The Rust walker is depth-first, so the natural ordering is stable.
  const grouped = createMemo<FileGroup[]>(() => {
    const groups: FileGroup[] = [];
    const lookup = new Map<string, FileGroup>();
    for (const match of results()) {
      let group = lookup.get(match.path);
      if (!group) {
        group = { path: match.path, matches: [] };
        lookup.set(match.path, group);
        groups.push(group);
      }
      group.matches.push(match);
    }
    return groups;
  });

  // Track the last rootId we ran a search against. Switching workspaces
  // invalidates persisted state — results are scoped to the root they
  // came from. Toggling the modal within the SAME root preserves the
  // query and result list so the user can dismiss and come back to
  // their work.
  let lastRootId: string | null = null;
  createEffect(() => {
    if (props.open) {
      const currentRoot = props.rootId;
      if (currentRoot !== lastRootId) {
        // Workspace changed — clear stale results from the previous root.
        setQuery("");
        setResults([]);
        setActiveIndex(0);
        setError(null);
        lastRootId = currentRoot;
      }
      // On every open, focus + select-all so the user can either type a
      // fresh query (just type — replaces selection) or refine the
      // previous one (press End / arrow keys to deselect first).
      queueMicrotask(() => {
        inputRef?.focus();
        inputRef?.select();
      });
    } else {
      // Cancel any in-flight debounce so a stale result doesn't land
      // after the modal closes.
      clearTimeout(debounceTimer);
      searchToken += 1;
    }
  });

  // Keep activeIndex in range when results shrink.
  createEffect(() => {
    const length = results().length;
    if (activeIndex() >= length) setActiveIndex(Math.max(0, length - 1));
  });

  // Trigger a (debounced) search whenever the query, options, or root change
  // while the modal is open.
  createEffect(() => {
    const current = query();
    const opts = { caseSensitive: caseSensitive() };
    const root = props.rootId;
    if (!props.open) return;

    clearTimeout(debounceTimer);
    if (current.length === 0) {
      setResults([]);
      setSearching(false);
      setError(null);
      return;
    }
    if (!root) {
      setResults([]);
      setSearching(false);
      setError("No workspace open");
      return;
    }

    const token = ++searchToken;
    setSearching(true);
    debounceTimer = setTimeout(async () => {
      try {
        const matches = await props.search(root, current, opts);
        // Discard stale results (the user kept typing).
        if (token !== searchToken) return;
        setResults(matches);
        setError(null);
      } catch (err) {
        if (token !== searchToken) return;
        setResults([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (token === searchToken) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
  });

  function handleKeyDown(event: KeyboardEvent) {
    const length = results().length;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
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
      case "Enter": {
        event.preventDefault();
        const picked = results()[activeIndex()];
        const root = props.rootId;
        if (picked && root) {
          props.onSelect({ rootId: root, path: picked.path, line: picked.line_number });
        }
        break;
      }
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) props.onClose();
  }

  // Document-level Esc capture (mirror of the palette pattern).
  onMount(() => {
    function global(event: KeyboardEvent) {
      if (props.open && event.key === "Escape" && event.target !== inputRef) {
        event.preventDefault();
        props.onClose();
      }
    }
    document.addEventListener("keydown", global, true);
    onCleanup(() => document.removeEventListener("keydown", global, true));
  });

  return (
    <Show when={props.open}>
      <Portal>
        <div class="quick-open-backdrop" onMouseDown={handleBackdropClick}>
          <div class="find-in-files-panel" role="dialog" aria-label={(useLocale(), m.find_in_files_placeholder())}>
            <div class="find-in-files-header">
              <div class="find-in-files-input-wrap">
                <input
                  ref={inputRef}
                  class="quick-open-input"
                  type="text"
                  placeholder={(useLocale(), m.find_in_files_placeholder())}
                  value={query()}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={handleKeyDown}
                />
                <Show when={query().length > 0}>
                  <button
                    type="button"
                    class="find-in-files-clear"
                    aria-label="Clear search"
                    title="Clear search"
                    onMouseDown={(event) => {
                      // Mousedown so the input doesn't lose focus before
                      // the click handler runs.
                      event.preventDefault();
                      setQuery("");
                      setResults([]);
                      setActiveIndex(0);
                      setError(null);
                      inputRef?.focus();
                    }}
                  >
                    {/* Plain SVG so we don't pull a new icon dep. */}
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                      <line x1="6" y1="6" x2="18" y2="18" />
                      <line x1="6" y1="18" x2="18" y2="6" />
                    </svg>
                  </button>
                </Show>
              </div>
              <label class="find-in-files-option">
                <input
                  type="checkbox"
                  checked={caseSensitive()}
                  onChange={(event) => setCaseSensitive(event.currentTarget.checked)}
                />
                {(useLocale(), m.find_in_files_case_sensitive())}
              </label>
            </div>
            <Show when={query().length > 0 || error()}>
              <div class="find-in-files-status">
                <Show when={searching()}>Searching…</Show>
                <Show when={!searching() && error()}>
                  <span class="find-in-files-error">{error()}</span>
                </Show>
                <Show when={!searching() && !error() && query().length > 0}>
                  {results().length === 0
                    ? (useLocale(), m.find_in_files_no_results())
                    : (useLocale(), m.find_in_files_results_summary({ count: String(results().length), fileCount: String(grouped().length) }))}
                </Show>
              </div>
              <ul class="find-in-files-results" role="listbox">
                <For each={grouped()}>
                  {(group) => (
                    <li class="find-in-files-group">
                      <div class="find-in-files-file">{group.path}</div>
                      <ul class="find-in-files-lines">
                        <For each={group.matches}>
                          {(match) => {
                            const idx = () => results().indexOf(match);
                            const isActive = () => idx() === activeIndex();
                            return (
                              <li
                                role="option"
                                aria-selected={isActive()}
                                class="find-in-files-line"
                                classList={{ "find-in-files-line-active": isActive() }}
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  const root = props.rootId;
                                  if (!root) return;
                                  props.onSelect({
                                    rootId: root,
                                    path: match.path,
                                    line: match.line_number,
                                  });
                                }}
                                onMouseEnter={() => setActiveIndex(idx())}
                              >
                                <span class="find-in-files-line-number">{match.line_number + 1}</span>
                                <span class="find-in-files-snippet">
                                  {renderSnippet(match)}
                                </span>
                              </li>
                            );
                          }}
                        </For>
                      </ul>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

function renderSnippet(match: FileMatch) {
  const before = match.line_text.slice(0, match.column_start);
  const hit = match.line_text.slice(match.column_start, match.column_end);
  const after = match.line_text.slice(match.column_end);
  return (
    <>
      <span class="find-in-files-context">{before}</span>
      <mark class="quick-open-hit">{hit}</mark>
      <span class="find-in-files-context">{after}</span>
    </>
  );
}
