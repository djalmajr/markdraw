import { createSignal, createEffect, onCleanup, onMount } from "solid-js";

interface SearchOverlayProps {
  container: HTMLElement;
  onClose: () => void;
}

export function SearchOverlay(props: SearchOverlayProps) {
  const [query, setQuery] = createSignal("");
  const [matchCount, setMatchCount] = createSignal(0);
  const [currentIndex, setCurrentIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;
  let marks: HTMLElement[] = [];

  onMount(() => {
    inputRef?.focus();
  });

  function clearHighlights() {
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
        parent.normalize();
      }
    }
    marks = [];
    setMatchCount(0);
    setCurrentIndex(0);
  }

  function highlightMatches(text: string) {
    clearHighlights();
    if (!text) return;

    const lower = text.toLowerCase();
    const walker = document.createTreeWalker(
      props.container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          // Skip script/style elements and our own search overlay
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest(".search-overlay")) return NodeFilter.FILTER_REJECT;
          if (parent.tagName === "SCRIPT" || parent.tagName === "STYLE") return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      textNodes.push(node as Text);
    }

    const newMarks: HTMLElement[] = [];

    for (const textNode of textNodes) {
      const content = textNode.textContent || "";
      const contentLower = content.toLowerCase();
      const idx = contentLower.indexOf(lower);
      if (idx === -1) continue;

      // Split text node and wrap match
      const before = content.substring(0, idx);
      const match = content.substring(idx, idx + text.length);
      const after = content.substring(idx + text.length);

      const mark = document.createElement("mark");
      mark.className = "search-highlight";
      mark.textContent = match;

      const parent = textNode.parentNode!;
      if (before) parent.insertBefore(document.createTextNode(before), textNode);
      parent.insertBefore(mark, textNode);
      if (after) parent.insertBefore(document.createTextNode(after), textNode);
      parent.removeChild(textNode);

      newMarks.push(mark);
    }

    marks = newMarks;
    setMatchCount(newMarks.length);
    if (newMarks.length > 0) {
      setCurrentIndex(0);
      activateMark(0);
    }
  }

  function activateMark(index: number) {
    for (const m of marks) {
      m.classList.remove("search-active");
    }
    if (marks[index]) {
      marks[index].classList.add("search-active");
      marks[index].scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function goNext() {
    if (matchCount() === 0) return;
    const next = (currentIndex() + 1) % matchCount();
    setCurrentIndex(next);
    activateMark(next);
  }

  function goPrev() {
    if (matchCount() === 0) return;
    const prev = (currentIndex() - 1 + matchCount()) % matchCount();
    setCurrentIndex(prev);
    activateMark(prev);
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  createEffect(() => {
    const q = query();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => highlightMatches(q), 150);
  });

  onCleanup(() => {
    clearTimeout(debounceTimer);
    clearHighlights();
  });

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        goPrev();
      } else {
        goNext();
      }
    }
  }

  return (
    <div class="search-overlay">
      <input
        class="search-input"
        placeholder="Find in page..."
        ref={inputRef}
        type="text"
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      <span class="search-count">
        {matchCount() > 0 ? `${currentIndex() + 1}/${matchCount()}` : "0/0"}
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
}
