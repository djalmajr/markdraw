import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Compartment, EditorState } from "@codemirror/state";
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
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, defaultHighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { findTextMatches, SearchOverlay, type SearchOptions } from "./search-overlay.tsx";

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
  searchOpen: boolean;
  showInvisibles: boolean;
  showLineNumbers: boolean;
  wrapText: boolean;
  onChange: (value: string) => void;
  onSearchOpenChange: (open: boolean) => void;
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
  let lastSearchOpen = props.searchOpen;
  let matches: SearchMatch[] = [];

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
      backgroundColor: "hsl(234 18% 20%)",
    },
    ".cm-activeLine": {
      backgroundColor: "hsl(234 18% 18%)",
    },
    ".cm-cursor": {
      borderLeftColor: "hsl(226 64% 88%)",
    },
    ".cm-content::selection, .cm-content *::selection": {
      backgroundColor: "hsl(211 52% 24%) !important",
    },
    ".cm-visible-space, .cm-visible-tab": {
      color: "hsl(229 21% 57% / 0.8)",
      pointerEvents: "none",
    },
    ".cm-search-match": {
      backgroundColor: "hsl(211 52% 24% / 0.45)",
      borderRadius: "2px",
    },
    ".cm-search-match-active": {
      backgroundColor: "hsl(211 52% 24% / 0.65)",
      outline: "1px solid hsl(211 72% 55% / 0.8)",
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
      backgroundColor: "hsl(220 13% 93%)",
    },
    ".cm-activeLine": {
      backgroundColor: "hsl(220 14% 97%)",
    },
    ".cm-content::selection, .cm-content *::selection": {
      backgroundColor: "hsl(188 65% 86%) !important",
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

  onMount(() => {
    if (!containerRef) return;

    const state = EditorState.create({
      doc: props.content,
      extensions: [
        lineNumbersCompartment.of(props.showLineNumbers ? lineNumbers() : []),
        history(),
        bracketMatching(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle),
        markdown(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        invisiblesCompartment.of(props.showInvisibles ? visibleWhitespace : []),
        indentCompartment.of([
          EditorState.tabSize.of(props.indentSize),
          indentUnit.of(props.indentMode === "tabs" ? "\t" : " ".repeat(props.indentSize)),
        ]),
        themeCompartment.of(props.darkMode ? darkTheme : lightTheme),
        wrapCompartment.of(props.wrapText ? EditorView.lineWrapping : []),
        searchHighlightCompartment.of([]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            props.onChange(update.state.doc.toString());
            if (props.searchOpen && searchQuery()) {
              recomputeMatches(searchQuery(), searchOptions());
            }
          }
        }),
      ],
    });

    view = new EditorView({ state, parent: containerRef });

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
    onCleanup(() => window.removeEventListener("keydown", onWindowKeyDown));
  });

  createEffect(() => {
    const newContent = props.content;
    if (!view) return;
    if (view.state.doc.toString() !== newContent) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: newContent },
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
