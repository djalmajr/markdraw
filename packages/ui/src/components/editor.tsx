import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  MatchDecorator,
  type ViewUpdate,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages as fenceLanguages } from "@codemirror/language-data";
import { bracketMatching, defaultHighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { findTextMatches, SearchOverlay, type SearchOptions } from "./search-overlay.tsx";
import {
  aiDiffCount,
  aiDiffField,
  clearAiDiffs,
  keepAllAiDiffs,
  keepAiDiff,
  nearestAiDiffId,
  proposeAiDiff,
  undoAiDiff,
} from "./editor-diff.ts";

/**
 * Marks a CodeMirror dispatch as "content swapped from outside" —
 * i.e. the parent component replaced `props.content` (file load,
 * undo-after-load, programmatic refresh). The `updateListener`
 * checks this annotation before firing `onChange`, because the
 * downstream "first keystroke pins the preview tab" rule treats
 * any onChange as a user edit. Without the annotation, opening a
 * file would instantly promote its preview tab to pinned the same
 * tick its content lands.
 */
const externalContentSwap = Annotation.define<true>();

type IndentMode = "tabs" | "spaces";

interface SearchMatch {
  from: number;
  to: number;
}

interface EditorProps {
  content: string;
  darkMode: boolean;
  findTrigger: number;
  indentMode: IndentMode;
  indentSize: number;
  redoTrigger: number;
  searchOpen: boolean;
  showInvisibles: boolean;
  showLineNumbers: boolean;
  syncScrollActive: boolean;
  syncScrollTargetRatio: number | null;
  syncScrollTargetVersion: number;
  /** Set this and bump `scrollToLineVersion` to scroll the editor to a
   *  specific 0-indexed line. Used by the Go-to-Symbol palette. */
  scrollToLine?: number | null;
  scrollToLineVersion?: number;
  undoTrigger: number;
  wrapText: boolean;
  onChange: (value: string) => void;
  onHistoryStateChange: (historyState: { canRedo: boolean; canUndo: boolean }) => void;
  onScrollRatioChange: (ratio: number) => void;
  onSearchOpenChange: (open: boolean) => void;
  /** Hands the host an imperative handle once the view is created (DJA-13/14):
   *  read the selection/cursor, anchor the inline overlay, and apply AI edits.
   *  New pattern (not the prop-driven scrollToLine) — kept narrow on purpose. */
  onReady?: (api: EditorApi) => void;
  /** Fired when the selection changes: a non-empty selection (with screen
   *  coords for anchoring a popover) or `null` when it collapses. Only emitted
   *  when a consumer is wired, so the listener stays cheap otherwise. */
  onSelectionPopover?: (
    info: { from: number; to: number; text: string; left: number; bottom: number } | null,
  ) => void;
}

/** Imperative editor handle for the AI surfaces (DJA-13/14). `replaceRange`
 *  applies a USER edit (fires `onChange` → reconvert/preview), so it must NOT
 *  use the `externalContentSwap` annotation. */
export interface EditorApi {
  /** Current selection + its text, or null when the view is gone. */
  getSelection(): { from: number; to: number; text: string } | null;
  /** Replace [from,to) with `insert` and place the cursor after it. */
  replaceRange(from: number, to: number, insert: string): void;
  /** Viewport coords of a document offset, for anchoring the inline overlay. */
  coordsAtPos(pos: number): { left: number; top: number; bottom: number } | null;
  /** The current cursor offset (selection head). */
  getCursorOffset(): number;
  focus(): void;
  /** Apply an AI-proposed edit (`find → replace`, first match) optimistically and
   *  overlay a Cursor-style inline diff the user can Keep/Undo. Returns a
   *  model-visible status (e.g. "not found"). */
  proposeDiff(find: string, replace: string): { ok: boolean; message: string };
  /** Whether any inline AI diff is awaiting Keep/Undo. */
  hasPendingDiffs(): boolean;
  /** Keep the diff at/nearest the cursor (drop its decorations, keep the text). */
  keepNearestDiff(): void;
  /** Undo the diff at/nearest the cursor (restore the original text). */
  undoNearestDiff(): void;
  /** Keep every pending diff in one step. */
  keepAllDiffs(): void;
}

class VisibleWhitespaceWidget extends WidgetType {
  constructor(private readonly char: string) {
    super();
  }

  eq(other: VisibleWhitespaceWidget): boolean {
    return other.char === this.char;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.char === "\t" ? "cm-visible-tab" : "cm-visible-space";
    span.textContent = this.char === "\t" ? "→" : "·";
    return span;
  }
}

const visibleWhitespaceMatcher = new MatchDecorator({
  regexp: /[ \t]/g,
  decoration: (match) => Decoration.replace({ widget: new VisibleWhitespaceWidget(match[0]!) }),
});

const visibleWhitespace = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = visibleWhitespaceMatcher.createDeco(view);
    }

    update(update: ViewUpdate) {
      this.decorations = visibleWhitespaceMatcher.updateDeco(update, this.decorations);
    }
  },
  {
    decorations: (value) => value.decorations,
  },
);

const EDITOR_HISTORY_MIN_DEPTH = 100;

export function Editor(props: EditorProps) {
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchOptions, setSearchOptions] = createSignal<SearchOptions>({
    ignoreCase: true,
    ignoreDiacritics: true,
  });
  const [matchCount, setMatchCount] = createSignal(0);
  const [currentMatchIndex, setCurrentMatchIndex] = createSignal(0);

  let containerRef: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  let lastFindTrigger = props.findTrigger;
  let lastRedoTrigger = props.redoTrigger;
  let lastSearchOpen = props.searchOpen;
  let lastSyncScrollTargetVersion = props.syncScrollTargetVersion;
  let lastScrollToLineVersion = props.scrollToLineVersion ?? 0;
  let lastUndoTrigger = props.undoTrigger;
  let matches: SearchMatch[] = [];
  let suppressScrollCallback = false;

  const themeCompartment = new Compartment();
  const lineNumbersCompartment = new Compartment();
  const invisiblesCompartment = new Compartment();
  const indentCompartment = new Compartment();
  const wrapCompartment = new Compartment();
  const searchHighlightCompartment = new Compartment();

  const darkTheme = EditorView.theme({
    "&": {
      backgroundColor: "hsl(235 21% 13%)",
      color: "hsl(226 64% 88%)",
    },
    ".cm-gutters": {
      backgroundColor: "hsl(234 20% 15%)",
      color: "hsl(229 21% 57%)",
      borderRight: "1px solid hsl(233 16% 22%)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "hsl(var(--primary) / 0.15)",
    },
    ".cm-activeLine": {
      backgroundColor: "hsl(var(--primary) / 0.1)",
    },
    ".cm-cursor": {
      borderLeftColor: "hsl(226 64% 88%)",
    },
    ".cm-content::selection, .cm-content *::selection": {
      backgroundColor: "hsl(var(--primary) / 0.45) !important",
    },
    ".cm-visible-space, .cm-visible-tab": {
      color: "hsl(229 21% 57% / 0.8)",
      pointerEvents: "none",
    },
    ".cm-search-match": {
      backgroundColor: "hsl(188 52% 24% / 0.45)",
      borderRadius: "2px",
    },
    ".cm-search-match-active": {
      backgroundColor: "hsl(188 52% 24% / 0.65)",
      outline: "1px solid hsl(188 72% 55% / 0.8)",
    },
  }, { dark: true });

  const lightTheme = EditorView.theme({
    "&": {
      backgroundColor: "hsl(0 0% 100%)",
      color: "hsl(240 10% 3.9%)",
    },
    ".cm-gutters": {
      backgroundColor: "hsl(220 14% 96%)",
      color: "hsl(220 9% 46%)",
      borderRight: "1px solid hsl(220 13% 91%)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "hsl(var(--primary) / 0.15)",
    },
    ".cm-activeLine": {
      backgroundColor: "hsl(var(--primary) / 0.1)",
    },
    ".cm-content::selection, .cm-content *::selection": {
      backgroundColor: "hsl(var(--primary) / 0.3) !important",
    },
    ".cm-visible-space, .cm-visible-tab": {
      color: "hsl(220 9% 46% / 0.75)",
      pointerEvents: "none",
    },
    ".cm-search-match": {
      backgroundColor: "hsl(188 65% 86% / 0.55)",
      borderRadius: "2px",
    },
    ".cm-search-match-active": {
      backgroundColor: "hsl(188 65% 76% / 0.8)",
      outline: "1px solid hsl(186 80% 40% / 0.7)",
    },
  });

  function buildSearchHighlightExtension(activeIndex = currentMatchIndex()) {
    if (matches.length === 0) return [];
    const ranges = matches.map((match, index) =>
      Decoration.mark({ class: index === activeIndex ? "cm-search-match cm-search-match-active" : "cm-search-match" })
        .range(match.from, match.to),
    );
    return EditorView.decorations.of(Decoration.set(ranges, true));
  }

  function updateSearchHighlights(activeIndex = currentMatchIndex()) {
    if (!view) return;
    view.dispatch({
      effects: searchHighlightCompartment.reconfigure(buildSearchHighlightExtension(activeIndex)),
    });
  }

  function setActiveMatch(index: number, scroll: boolean) {
    if (matches.length === 0) return;
    setCurrentMatchIndex(index);
    updateSearchHighlights(index);
    if (scroll) applyMatch(index);
  }

  function applyMatch(index: number) {
    if (!view || matches.length === 0) return;
    const target = matches[index];
    if (!target) return;
    view.dispatch({
      selection: { anchor: target.from, head: target.to },
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
  }

  function recomputeMatches(query: string, options: SearchOptions) {
    if (!view || !query) {
      matches = [];
      setMatchCount(0);
      setCurrentMatchIndex(0);
      updateSearchHighlights();
      return;
    }

    const doc = view.state.doc.toString();
    matches = findTextMatches(doc, query, options);
    setMatchCount(matches.length);

    if (matches.length === 0) {
      setCurrentMatchIndex(0);
      updateSearchHighlights(0);
      return;
    }

    setActiveMatch(0, false);
  }

  function openFind() {
    props.onSearchOpenChange(true);
  }

  function closeFind() {
    props.onSearchOpenChange(false);
    matches = [];
    setMatchCount(0);
    setCurrentMatchIndex(0);
    updateSearchHighlights();
    view?.focus();
  }

  function goNextMatch() {
    if (matches.length === 0) return;
    const next = (currentMatchIndex() + 1) % matches.length;
    setActiveMatch(next, true);
  }

  function goPrevMatch() {
    if (matches.length === 0) return;
    const prev = (currentMatchIndex() - 1 + matches.length) % matches.length;
    setActiveMatch(prev, true);
  }

  function handleSearchChange(query: string, options: SearchOptions) {
    setSearchQuery(query);
    setSearchOptions(options);
    recomputeMatches(query, options);
  }

  function emitHistoryState(state: EditorState) {
    props.onHistoryStateChange({
      canRedo: redoDepth(state) > 0,
      canUndo: undoDepth(state) > 0,
    });
  }

  function computeScrollRatio(scrollTop: number, scrollHeight: number, clientHeight: number): number {
    const maxScrollTop = scrollHeight - clientHeight;
    if (maxScrollTop <= 0) return 0;
    const ratio = scrollTop / maxScrollTop;
    return Math.max(0, Math.min(1, ratio));
  }

  onMount(() => {
    if (!containerRef) return;

    const state = EditorState.create({
      doc: props.content,
      extensions: [
        lineNumbersCompartment.of(props.showLineNumbers ? lineNumbers() : []),
        history({ minDepth: EDITOR_HISTORY_MIN_DEPTH }),
        bracketMatching(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle),
        // codeLanguages: ~150 fence languages resolved by name/alias from the
        // community registry — each parser lazy-loads on first use, so the
        // editor bundle only pays for the metadata table.
        markdown({ codeLanguages: fenceLanguages }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        invisiblesCompartment.of(props.showInvisibles ? visibleWhitespace : []),
        indentCompartment.of([
          EditorState.tabSize.of(props.indentSize),
          indentUnit.of(props.indentMode === "tabs" ? "\t" : " ".repeat(props.indentSize)),
        ]),
        themeCompartment.of(props.darkMode ? darkTheme : lightTheme),
        wrapCompartment.of(props.wrapText ? EditorView.lineWrapping : []),
        searchHighlightCompartment.of([]),
        aiDiffField,
        EditorView.updateListener.of((update) => {
          emitHistoryState(update.state);
          // Selection popover (Add to chat / Quick Edit). Lazy: only when wired,
          // and only on a real selection change.
          if (props.onSelectionPopover && update.selectionSet) {
            const sel = update.state.selection.main;
            const text = sel.empty ? "" : update.state.doc.sliceString(sel.from, sel.to);
            const coords = sel.empty ? null : update.view.coordsAtPos(sel.to);
            props.onSelectionPopover(
              !sel.empty && text.trim() && coords
                ? { from: sel.from, to: sel.to, text, left: coords.left, bottom: coords.bottom }
                : null,
            );
          }
          if (update.docChanged) {
            // Skip onChange when the doc swap came from the parent
            // setting `props.content` (file load, etc.). Otherwise
            // the pin-on-edit rule in pane-view treats every file
            // open as the user's first keystroke.
            const isExternalSwap = update.transactions.some((t) =>
              t.annotation(externalContentSwap),
            );
            if (!isExternalSwap) {
              props.onChange(update.state.doc.toString());
            }
            if (props.searchOpen && searchQuery()) {
              recomputeMatches(searchQuery(), searchOptions());
            }
          }
        }),
      ],
    });

    view = new EditorView({ state, parent: containerRef });
    emitHistoryState(state);

    props.onReady?.({
      getSelection: () => {
        if (!view) return null;
        const sel = view.state.selection.main;
        return {
          from: sel.from,
          to: sel.to,
          text: view.state.doc.sliceString(sel.from, sel.to),
        };
      },
      replaceRange: (from, to, insert) => {
        // User edit (not externalContentSwap) so onChange fires and the
        // preview reconverts.
        view?.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
        });
      },
      coordsAtPos: (pos) => {
        const c = view?.coordsAtPos(pos);
        return c ? { left: c.left, top: c.top, bottom: c.bottom } : null;
      },
      getCursorOffset: () => view?.state.selection.main.head ?? 0,
      focus: () => view?.focus(),
      proposeDiff: (find, replace) =>
        view
          ? proposeAiDiff(view, find, replace)
          : { ok: false, message: "No active editor is available to apply the edit." },
      hasPendingDiffs: () => (view ? aiDiffCount(view.state) > 0 : false),
      keepNearestDiff: () => {
        if (!view) return;
        const id = nearestAiDiffId(view.state);
        if (id) keepAiDiff(view, id);
      },
      undoNearestDiff: () => {
        if (!view) return;
        const id = nearestAiDiffId(view.state);
        if (id) undoAiDiff(view, id);
      },
      keepAllDiffs: () => {
        if (view) keepAllAiDiffs(view);
      },
    });

    const scrollEl = view.scrollDOM;
    let scrollRaf = 0;
    const onScroll = () => {
      if (suppressScrollCallback || !props.syncScrollActive) return;
      cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(() => {
        props.onScrollRatioChange(computeScrollRatio(scrollEl.scrollTop, scrollEl.scrollHeight, scrollEl.clientHeight));
      });
    };

    scrollEl.addEventListener("scroll", onScroll, { passive: true });

    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      const active = document.activeElement as HTMLElement | null;
      const inEditorPanel = !!active?.closest(".editor-panel");

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && (view?.hasFocus || inEditorPanel)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        props.onSearchOpenChange(!props.searchOpen);
        return;
      }

      if (!props.searchOpen) return;
      if (!inEditorPanel) return;

      if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.shiftKey) {
          goPrevMatch();
        } else {
          goNextMatch();
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeFind();
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    onCleanup(() => {
      cancelAnimationFrame(scrollRaf);
      scrollEl.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onWindowKeyDown);
    });
  });

  createEffect(() => {
    const newContent = props.content;
    if (!view) return;
    if (view.state.doc.toString() !== newContent) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: newContent },
        // Tag the dispatch so updateListener can skip onChange —
        // this is a content swap from the parent, not a user edit.
        annotations: externalContentSwap.of(true),
        // A pending AI diff belongs to the old document — drop it on swap.
        effects: clearAiDiffs.of(null),
      });
      if (props.searchOpen && searchQuery()) {
        recomputeMatches(searchQuery(), searchOptions());
      }
    }
  });

  createEffect(() => {
    if (!props.searchOpen) {
      matches = [];
      setMatchCount(0);
      setCurrentMatchIndex(0);
      updateSearchHighlights();
    }

    if (lastSearchOpen && !props.searchOpen) {
      queueMicrotask(() => view?.focus());
    }
    lastSearchOpen = props.searchOpen;
  });

  createEffect(() => {
    const wrapText = props.wrapText;
    if (!view) return;
    view.dispatch({
      effects: wrapCompartment.reconfigure(wrapText ? EditorView.lineWrapping : []),
    });
  });

  createEffect(() => {
    const darkMode = props.darkMode;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.reconfigure(darkMode ? darkTheme : lightTheme),
    });
  });

  createEffect(() => {
    const showLineNumbers = props.showLineNumbers;
    if (!view) return;
    view.dispatch({
      effects: lineNumbersCompartment.reconfigure(showLineNumbers ? lineNumbers() : []),
    });
  });

  createEffect(() => {
    const showInvisibles = props.showInvisibles;
    if (!view) return;
    view.dispatch({
      effects: invisiblesCompartment.reconfigure(showInvisibles ? visibleWhitespace : []),
    });
  });

  createEffect(() => {
    const indentMode = props.indentMode;
    const indentSize = props.indentSize;
    if (!view) return;
    view.dispatch({
      effects: indentCompartment.reconfigure([
        EditorState.tabSize.of(indentSize),
        indentUnit.of(indentMode === "tabs" ? "\t" : " ".repeat(indentSize)),
      ]),
    });
  });

  createEffect(() => {
    const trigger = props.findTrigger;
    if (trigger === lastFindTrigger) return;
    lastFindTrigger = trigger;
    openFind();
  });

  createEffect(() => {
    const targetVersion = props.syncScrollTargetVersion;
    if (targetVersion === lastSyncScrollTargetVersion) return;
    lastSyncScrollTargetVersion = targetVersion;

    if (!view || !props.syncScrollActive) return;

    const targetRatio = props.syncScrollTargetRatio;
    if (targetRatio === null) return;

    const scrollEl = view.scrollDOM;
    const maxScrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
    const targetTop = maxScrollTop <= 0 ? 0 : Math.max(0, Math.min(1, targetRatio)) * maxScrollTop;

    suppressScrollCallback = true;
    scrollEl.scrollTop = targetTop;
    requestAnimationFrame(() => {
      suppressScrollCallback = false;
    });
  });

  createEffect(() => {
    const trigger = props.undoTrigger;
    if (trigger === lastUndoTrigger) return;
    lastUndoTrigger = trigger;
    if (!view) return;
    undo(view);
    emitHistoryState(view.state);
    view.focus();
  });

  // Go-to-Symbol scroll: caller bumps `scrollToLineVersion` with the
  // 0-indexed line set in `scrollToLine`. We dispatch a CodeMirror
  // selection + scrollIntoView so the line is centered AND focused.
  createEffect(() => {
    const targetVersion = props.scrollToLineVersion ?? 0;
    if (targetVersion === lastScrollToLineVersion) return;
    lastScrollToLineVersion = targetVersion;
    if (!view) return;

    const lineIndex = props.scrollToLine ?? null;
    if (lineIndex === null || lineIndex < 0) return;

    const total = view.state.doc.lines;
    // Lines are 1-indexed in CodeMirror's `doc.line(n)` API, but our
    // descriptor uses 0-indexed lines (matches everything else in the
    // codebase). Clamp to the valid range to survive a stale palette
    // pointing past EOF.
    const cmLine = Math.min(Math.max(1, lineIndex + 1), total);
    const lineInfo = view.state.doc.line(cmLine);

    view.dispatch({
      selection: { anchor: lineInfo.from, head: lineInfo.from },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }),
    });
    view.focus();
  });

  createEffect(() => {
    const trigger = props.redoTrigger;
    if (trigger === lastRedoTrigger) return;
    lastRedoTrigger = trigger;
    if (!view) return;
    redo(view);
    emitHistoryState(view.state);
    view.focus();
  });

  onCleanup(() => {
    view?.destroy();
  });

  return (
    <div class="editor-search-scope">
      <SearchOverlay
        class="search-overlay-editor"
        currentIndex={currentMatchIndex()}
        matchCount={matchCount()}
        placeholder="Find in editor..."
        visible={props.searchOpen}
        onClose={closeFind}
        onNext={goNextMatch}
        onPrev={goPrevMatch}
        onSearchChange={handleSearchChange}
      />
      <div class="editor-container" ref={containerRef} />
    </div>
  );
}
