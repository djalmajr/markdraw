import { onMount, onCleanup, createEffect } from "solid-js";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";

interface EditorProps {
  content: string;
  darkMode: boolean;
  wrapText: boolean;
  onChange: (value: string) => void;
}

export function Editor(props: EditorProps) {
  let containerRef: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  const themeCompartment = new Compartment();
  const wrapCompartment = new Compartment();

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
  });

  onMount(() => {
    if (!containerRef) return;

    const state = EditorState.create({
      doc: props.content,
      extensions: [
        lineNumbers(),
        history(),
        bracketMatching(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle),
        markdown(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        themeCompartment.of(props.darkMode ? darkTheme : lightTheme),
        wrapCompartment.of(props.wrapText ? EditorView.lineWrapping : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            props.onChange(update.state.doc.toString());
          }
        }),
      ],
    });

    view = new EditorView({ state, parent: containerRef });
  });

  // Update content when it changes externally (e.g. file switch)
  createEffect(() => {
    const newContent = props.content;
    if (!view) return;
    if (view.state.doc.toString() !== newContent) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: newContent },
      });
    }
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

  onCleanup(() => {
    view?.destroy();
  });

  return (
    <div class="editor-container" ref={containerRef} />
  );
}
