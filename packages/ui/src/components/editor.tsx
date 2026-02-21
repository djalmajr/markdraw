import { onMount, onCleanup, createEffect } from "solid-js";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";

interface EditorProps {
  content: string;
  darkMode: boolean;
  onChange: (value: string) => void;
}

export function Editor(props: EditorProps) {
  let containerRef: HTMLDivElement | undefined;
  let view: EditorView | undefined;

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
    ".cm-selectionBackground": {
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
  });

  onMount(() => {
    if (!containerRef) return;

    const state = EditorState.create({
      doc: props.content,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        bracketMatching(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle),
        markdown(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        props.darkMode ? darkTheme : lightTheme,
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

  onCleanup(() => {
    view?.destroy();
  });

  return (
    <div class="editor-container" ref={containerRef} />
  );
}
