import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import IconCaseSensitive from "~icons/lucide/case-sensitive";
import IconLanguages from "~icons/lucide/languages";

export interface SearchOptions {
  ignoreCase: boolean;
  ignoreDiacritics: boolean;
}

interface SearchOverlayProps {
  visible: boolean;
  class?: string;
  placeholder?: string;
  container?: HTMLElement;
  portalHost?: HTMLElement;
  matchCount?: number;
  currentIndex?: number;
  onClose: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  onSearchChange?: (query: string, options: SearchOptions) => void;
}

interface TextMatch {
  from: number;
  to: number;
}

function findScrollableAncestor(start: HTMLElement | null): HTMLElement | null {
  let node = start?.parentElement ?? null;
  while (node) {
    const style = window.getComputedStyle(node);
    const overflowY = style.overflowY;
    const canScroll = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
    if (canScroll && node.scrollHeight > node.clientHeight + 1) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function getOffsetTopWithin(node: HTMLElement, ancestor: HTMLElement): number {
  let top = 0;
  let current: HTMLElement | null = node;

  while (current && current !== ancestor) {
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }

  if (current === ancestor) return top;

  const nodeRect = node.getBoundingClientRect();
  const ancestorRect = ancestor.getBoundingClientRect();
  return nodeRect.top - ancestorRect.top + ancestor.scrollTop;
}

function normalizeWithMap(input: string, options: SearchOptions) {
  let normalized = "";
  const map: number[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    let chunk = char;

    if (options.ignoreDiacritics) {
      chunk = chunk.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }
    if (options.ignoreCase) {
      chunk = chunk.toLowerCase();
    }

    normalized += chunk;
    for (let i = 0; i < chunk.length; i += 1) {
      map.push(index);
    }
  }

  return { normalized, map };
}

export function findTextMatches(input: string, query: string, options: SearchOptions): TextMatch[] {
  if (!query) return [];

  const { normalized, map } = normalizeWithMap(input, options);
  const normalizedQuery = normalizeWithMap(query, options).normalized;
  if (!normalizedQuery) return [];

  const matches: TextMatch[] = [];
  let startAt = 0;
  while (startAt <= normalized.length) {
    const idx = normalized.indexOf(normalizedQuery, startAt);
    if (idx === -1) break;

    const from = map[idx] ?? 0;
    const afterIndex = idx + normalizedQuery.length;
    const to = afterIndex < map.length ? (map[afterIndex] ?? input.length) : input.length;
    matches.push({ from, to });

    startAt = idx + 1;
  }

  return matches;
}

export function SearchOverlay(props: SearchOverlayProps) {
  const [query, setQuery] = createSignal("");
  const [options, setOptions] = createSignal<SearchOptions>({
    ignoreCase: true,
    ignoreDiacritics: true,
  });

  const [internalMatchCount, setInternalMatchCount] = createSignal(0);
  const [internalCurrentIndex, setInternalCurrentIndex] = createSignal(0);
  const [externalMatchCount, setExternalMatchCount] = createSignal(0);
  const [externalCurrentIndex, setExternalCurrentIndex] = createSignal(0);

  let inputRef: HTMLInputElement | undefined;
  let marks: HTMLElement[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const useExternalEngine = () => !!props.onSearchChange;

  function clearHighlights() {
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
        parent.normalize();
      }
    }
    marks = [];
    setInternalMatchCount(0);
    setInternalCurrentIndex(0);
  }

  function activateMark(index: number) {
    for (const mark of marks) {
      mark.classList.remove("search-active");
    }
    if (marks[index]) {
      const target = marks[index]!;
      target.classList.add("search-active");

      const explicitHost = props.container?.closest(".content") as HTMLElement | null;
      const scrollHost = explicitHost ?? findScrollableAncestor(target);
      if (scrollHost) {
        const targetTop = getOffsetTopWithin(target, scrollHost);
        const desiredTop = targetTop - (scrollHost.clientHeight * 0.35);
        scrollHost.scrollTo({ top: Math.max(0, desiredTop), behavior: "smooth" });
      } else {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }

  function highlightMatches(currentQuery: string, currentOptions: SearchOptions) {
    if (!props.container) return;

    clearHighlights();
    if (!currentQuery) return;

    const walker = document.createTreeWalker(
      props.container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest(".search-overlay")) return NodeFilter.FILTER_REJECT;
          if (parent.tagName === "SCRIPT" || parent.tagName === "STYLE") return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );

    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      textNodes.push(node as Text);
    }

    const nextMarks: HTMLElement[] = [];
    for (const textNode of textNodes) {
      const content = textNode.textContent || "";
      const ranges = findTextMatches(content, currentQuery, currentOptions);
      if (ranges.length === 0) continue;

      const fragment = document.createDocumentFragment();
      let cursor = 0;

      for (const range of ranges) {
        if (range.from > cursor) {
          fragment.appendChild(document.createTextNode(content.slice(cursor, range.from)));
        }

        const mark = document.createElement("mark");
        mark.className = "search-highlight";
        mark.textContent = content.slice(range.from, range.to);
        fragment.appendChild(mark);
        nextMarks.push(mark);
        cursor = range.to;
      }

      if (cursor < content.length) {
        fragment.appendChild(document.createTextNode(content.slice(cursor)));
      }

      textNode.parentNode?.replaceChild(fragment, textNode);
    }

    marks = nextMarks;
    setInternalMatchCount(nextMarks.length);
    if (nextMarks.length > 0) {
      setInternalCurrentIndex(0);
      activateMark(0);
    }
  }

  function goNext() {
    if (props.onNext) {
      props.onNext();
      const count = externalMatchCount();
      if (count > 0) {
        setExternalCurrentIndex((prev) => (prev + 1) % count);
      }
      queueMicrotask(() => inputRef?.focus());
      return;
    }
    if (internalMatchCount() === 0) return;
    const next = (internalCurrentIndex() + 1) % internalMatchCount();
    setInternalCurrentIndex(next);
    activateMark(next);
    queueMicrotask(() => inputRef?.focus());
  }

  function goPrev() {
    if (props.onPrev) {
      props.onPrev();
      const count = externalMatchCount();
      if (count > 0) {
        setExternalCurrentIndex((prev) => (prev - 1 + count) % count);
      }
      queueMicrotask(() => inputRef?.focus());
      return;
    }
    if (internalMatchCount() === 0) return;
    const prev = (internalCurrentIndex() - 1 + internalMatchCount()) % internalMatchCount();
    setInternalCurrentIndex(prev);
    activateMark(prev);
    queueMicrotask(() => inputRef?.focus());
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        goPrev();
      } else {
        goNext();
      }
    }
  }

  function toggleIgnoreCase() {
    setOptions((prev) => ({ ...prev, ignoreCase: !prev.ignoreCase }));
  }

  function toggleIgnoreDiacritics() {
    setOptions((prev) => ({ ...prev, ignoreDiacritics: !prev.ignoreDiacritics }));
  }

  onMount(() => {
    if (props.visible) {
      inputRef?.focus();
    }
  });

  createEffect(() => {
    if (props.visible) {
      queueMicrotask(() => inputRef?.focus());
    }
  });

  createEffect(() => {
    setExternalMatchCount(props.matchCount ?? 0);
    setExternalCurrentIndex(props.currentIndex ?? 0);
  });

  createEffect(() => {
    const visible = props.visible;
    const currentQuery = query();
    const currentOptions = options();

    if (!visible) {
      clearTimeout(debounceTimer);
      clearHighlights();
      return;
    }

    if (useExternalEngine()) {
      props.onSearchChange?.(currentQuery, currentOptions);
      return;
    }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      highlightMatches(currentQuery, currentOptions);
    }, 120);
  });

  onCleanup(() => {
    clearTimeout(debounceTimer);
    clearHighlights();
  });

  const displayMatchCount = () => (useExternalEngine() ? externalMatchCount() : internalMatchCount());
  const displayCurrentIndex = () => (useExternalEngine() ? externalCurrentIndex() : internalCurrentIndex());

  const overlay = (
    <div class={`search-overlay search-overlay-inline ${props.class ?? ""} ${props.visible ? "" : "search-overlay-hidden"}`}>
      <input
        class="search-input"
        placeholder={props.placeholder ?? "Find in page..."}
        ref={inputRef}
        type="text"
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      <button
        class="search-option-btn"
        classList={{ "search-option-btn-active": options().ignoreCase }}
        aria-label="Ignore case"
        title="Ignore case"
        onClick={toggleIgnoreCase}
      >
        <IconCaseSensitive width={13} height={13} />
      </button>
      <button
        class="search-option-btn"
        classList={{ "search-option-btn-active": options().ignoreDiacritics }}
        aria-label="Ignore accents"
        title="Ignore accents"
        onClick={toggleIgnoreDiacritics}
      >
        <IconLanguages width={13} height={13} />
      </button>
      <span class="search-count">
        {displayMatchCount() > 0 ? `${displayCurrentIndex() + 1}/${displayMatchCount()}` : "0/0"}
      </span>
      <button class="search-nav-btn" aria-label="Previous" onClick={goPrev}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15" /></svg>
      </button>
      <button class="search-nav-btn" aria-label="Next" onClick={goNext}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      <button class="search-nav-btn" aria-label="Close" onClick={props.onClose}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
    </div>
  );

  if (props.portalHost) {
    return <Portal mount={props.portalHost}>{overlay}</Portal>;
  }

  return overlay;
}
