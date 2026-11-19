import { describe, expect, it } from "bun:test";
import { attachFromSelectionSources, selectionShortcutOrigin } from "./selection-shortcut.ts";

/** Minimal stand-in for a DOM element: `closest` answers only the classes it
 *  belongs to. Bun has no DOM globals, and the decision uses nothing else. */
function fakeElement(...classes: string[]): EventTarget {
  const element = {
    closest(selector: string) {
      const wanted = selector.replace(/^\./, "");
      return classes.includes(wanted) ? element : null;
    },
  };
  return element as unknown as EventTarget;
}

describe("selectionShortcutOrigin — origem do keydown", () => {
  it("tecla dentro de .cm-editor usa a seleção do editor", () => {
    expect(selectionShortcutOrigin(fakeElement("cm-editor"))).toEqual({
      chatOnly: false,
      editor: true,
    });
  });

  it("tecla dentro de .ai-panel só foca o chat", () => {
    expect(selectionShortcutOrigin(fakeElement("ai-panel"))).toEqual({
      chatOnly: true,
      editor: false,
    });
  });

  it("tecla dentro de .doc-body não usa a seleção dormente do editor", () => {
    expect(selectionShortcutOrigin(fakeElement("doc-body"))).toEqual({
      chatOnly: false,
      editor: false,
    });
  });

  it("clone do Excalidraw no window (sem closest) anexa só o diagrama", () => {
    // `window` é um EventTarget sem `closest`; um EventTarget comum tem a
    // mesma forma observável para esta decisão sob bun (sem globals de DOM).
    const clonedKeydownTarget = new EventTarget();
    expect(selectionShortcutOrigin(clonedKeydownTarget)).toEqual({
      chatOnly: false,
      editor: false,
    });
  });

  it("target null (sem alvo) não usa o editor", () => {
    expect(selectionShortcutOrigin(null)).toEqual({ chatOnly: false, editor: false });
  });

  it("elemento fora de todas as zonas não usa o editor", () => {
    expect(selectionShortcutOrigin(fakeElement("sidebar"))).toEqual({
      chatOnly: false,
      editor: false,
    });
  });

  it("chat vence quando o target está dentro do chat e do editor", () => {
    expect(selectionShortcutOrigin(fakeElement("cm-editor", "ai-panel"))).toEqual({
      chatOnly: true,
      editor: false,
    });
  });
});

describe("attachFromSelectionSources — cadeia de anexação", () => {
  function sources(results: {
    diagram?: boolean;
    editor?: boolean;
    preview?: boolean;
  }) {
    const calls: string[] = [];
    return {
      calls,
      sources: {
        diagram: () => {
          calls.push("diagram");
          return results.diagram ?? false;
        },
        editor: () => {
          calls.push("editor");
          return results.editor ?? false;
        },
        preview: () => {
          calls.push("preview");
          return results.preview ?? false;
        },
      },
    };
  }

  it("curto-circuito: seleção do diagrama impede editor e prévia", async () => {
    const { calls, sources: deps } = sources({ diagram: true, editor: true, preview: true });
    expect(await attachFromSelectionSources(deps)).toBe(true);
    expect(calls).toEqual(["diagram"]);
  });

  it("editor:true usa o editor e nunca consulta a prévia", async () => {
    const { calls, sources: deps } = sources({ editor: true, preview: true });
    expect(await attachFromSelectionSources(deps)).toBe(true);
    expect(calls).toEqual(["diagram", "editor"]);
  });

  it("editor:false não consulta o editor e anexa a seleção da prévia", async () => {
    const { calls, sources: deps } = sources({ editor: true, preview: true });
    expect(await attachFromSelectionSources(deps, { editor: false })).toBe(true);
    expect(calls).toEqual(["diagram", "preview"]);
  });

  it("editor:false sem prévia não anexa a seleção dormente do editor", async () => {
    const { calls, sources: deps } = sources({ editor: true });
    expect(await attachFromSelectionSources(deps, { editor: false })).toBe(false);
    expect(calls).toEqual(["diagram", "preview"]);
  });

  it("escolhe a prévia quando não há diagrama nem seleção no editor", async () => {
    const { calls, sources: deps } = sources({ preview: true });
    expect(await attachFromSelectionSources(deps)).toBe(true);
    expect(calls).toEqual(["diagram", "editor", "preview"]);
  });

  it("sem nenhuma seleção retorna false", async () => {
    const { calls, sources: deps } = sources({});
    expect(await attachFromSelectionSources(deps)).toBe(false);
    expect(calls).toEqual(["diagram", "editor", "preview"]);
  });

  it("aceita fontes assíncronas (diagrama) na mesma ordem", async () => {
    const calls: string[] = [];
    const deps = {
      diagram: async () => {
        calls.push("diagram");
        return false;
      },
      editor: () => {
        calls.push("editor");
        return true;
      },
      preview: () => {
        calls.push("preview");
        return true;
      },
    };
    expect(await attachFromSelectionSources(deps)).toBe(true);
    expect(calls).toEqual(["diagram", "editor"]);
  });
});
