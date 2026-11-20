import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal, flush, runWithOwner } from "solid-js";
import type { FSEntry } from "@markdraw/core/types.ts";
import { setChatSessionsIndex } from "@markdraw/core/ai-chat-sessions.ts";
import { UNSUPPORTED_CONTENT } from "@markdraw/core/utils.ts";
import type { AITool, ToolApprovalRequest } from "@markdraw/ai/types.ts";
import { createAppState, type ThemeMode } from "./create-app-state.ts";
import { registerMermaidFlush } from "../lib/mermaid-flush.ts";
import { createPaneManager } from "./create-pane-manager.ts";
import { createPaneStore } from "./create-pane-store.ts";
import type { AiInlineReference } from "./ai-context.ts";
import { collectIncludes } from "@markdraw/core/asciidoc.ts";
import { createFileAutosave } from "../../../../apps/desktop/src/lib/file-autosave.ts";
import { createFileLoader } from "../../../../apps/desktop/src/lib/file-loader.ts";
import { createFolder } from "../../../../apps/desktop/src/lib/folder.ts";
import { createTabActions } from "../../../../apps/desktop/src/lib/tab-actions.ts";
import { createOwnWrites } from "../../../../apps/desktop/src/lib/external-reload.ts";
import { FileWatcher } from "../../../../apps/desktop/src/lib/watcher.ts";

// Storage helpers — happy-dom ships localStorage, but we still clear
// it between suites so module-level singletons (recent-files cache,
// font-prefs default, etc.) start from a clean slate.
beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  localStorage.clear();
});

function makeConfig(over: Partial<Parameters<typeof createAppState>[0]> = {}) {
  return {
    applyTheme: vi.fn(),
    convertAdoc: vi.fn(async () => ({ html: "", frontmatter: null })),
    convertMarkdown: vi.fn(async () => ({ html: "", frontmatter: null })),
    getStoredTheme: vi.fn<() => ThemeMode>(() => "system" as ThemeMode),
    ...over,
  };
}

type State = ReturnType<typeof createAppState>;

function withState<T>(
  fn: (s: State, deps: ReturnType<typeof makeConfig>) => T,
  overrides: Partial<Parameters<typeof createAppState>[0]> = {},
): T {
  const deps = makeConfig(overrides);
  const state = createRoot(() => createAppState(deps));
  flush();
  // Handlers run from DOM events in the app, outside any owner. Drive them
  // the same way here, and settle each call before the assertions read back.
  const live = new Proxy(state, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = runWithOwner(null, () => (value as (...a: unknown[]) => unknown).apply(target, args));
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).then((settled) => {
            flush();
            return settled;
          });
        }
        flush();
        return result;
      };
    },
  });
  return runWithOwner(null, () => fn(live, deps));
}

describe("AppState — theme slice (DJA-42)", () => {
  it("themeMode is hydrated from config.getStoredTheme on mount", () => {
    // Mutation captured: replacing the initial seed with a hardcoded
    // "system" would surface here when the host passes "dark".
    withState(
      (state) => {
        expect(state.themeMode()).toBe("dark");
      },
      { getStoredTheme: () => "dark" },
    );
  });

  it("handleThemeChange updates themeMode AND calls applyTheme exactly once with the new mode", () => {
    // Mutation captured: skipping the applyTheme call (e.g. only
    // setting themeMode) would leave the document class in the
    // previous theme — the spy count would drop to zero.
    withState((state, deps) => {
      state.handleThemeChange("dark");
      expect(state.themeMode()).toBe("dark");
      expect(deps.applyTheme).toHaveBeenCalledTimes(1);
      expect(deps.applyTheme).toHaveBeenCalledWith("dark");
    });
  });

  it("the system theme listener is removed when the state owner is disposed", () => {
    const add = vi.fn();
    const remove = vi.fn();
    const matchMedia = vi.spyOn(window, "matchMedia").mockReturnValue({
      addEventListener: add,
      removeEventListener: remove,
    } as unknown as MediaQueryList);
    try {
      let dispose!: () => void;
      createRoot((stop) => {
        dispose = stop;
        createAppState(makeConfig());
      });
      flush();
      expect(add).toHaveBeenCalledTimes(1);
      dispose();
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]![0]).toBe("change");
    } finally {
      matchMedia.mockRestore();
    }
  });

  it("darkMode mirrors the document class state on each theme change", () => {
    // Domain rule: dark mode UI cues (icons, code theme) read from
    // `darkMode()` instead of inspecting the document directly. The
    // signal MUST follow the applyTheme side-effect.
    withState((state, deps) => {
      deps.applyTheme.mockImplementation(() =>
        document.documentElement.classList.add("dark"),
      );
      state.handleThemeChange("dark");
      expect(state.darkMode()).toBe(true);

      deps.applyTheme.mockImplementation(() =>
        document.documentElement.classList.remove("dark"),
      );
      state.handleThemeChange("light");
      expect(state.darkMode()).toBe(false);
    });
  });
});

describe("effective editor mode", () => {
  it("restores Markdown split mode after opening a PDF in another tab", () => {
    withState((s) => {
      const md: FSEntry = { name: "doc.md", path: "doc.md", kind: "file" };
      const pdf: FSEntry = { name: "doc.pdf", path: "doc.pdf", kind: "file" };
      const pane = s.paneManager.activePane();
      const mdId = pane.tabs.openTab(md, "root");
      flush();
      s.setSelectedFile(md);
      s.setEditorMode("split");
      const pdfId = pane.tabs.openTab(pdf, "root");
      flush();
      s.setSelectedFile(pdf);
      expect(s.editorMode()).toBe("preview");
      pane.tabs.activateTab(mdId);
      s.setSelectedFile(md);
      expect(s.editorMode()).toBe("split");
      pane.tabs.activateTab(pdfId);
      s.setSelectedFile(pdf);
      expect(s.editorMode()).toBe("preview");
    });
  });
  it("keeps each pane's chosen mode through media and unsupported files", () => {
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    try {
      withState((s) => {
        const file = (name: string): FSEntry => ({ name, path: name, kind: "file" });
        s.setEditorMode("split");
        s.setSelectedFile(file("doc.md"));
        expect(s.editorMode()).toBe("split");
        s.setSelectedFile(file("doc.pdf"));
        expect(s.editorMode()).toBe("preview");
        expect(s.paneManager.activePane().editorMode()).toBe("split");
        s.setSelectedFile(file("photo.png"));
        expect(s.editorMode()).toBe("preview");
        s.setSelectedFile(file("plain.txt"));
        expect(s.editorMode()).toBe("edit");
        s.setHtml(UNSUPPORTED_CONTENT);
        expect(s.editorMode()).toBe("split");
        s.setHtml("");
        s.setSelectedFile(file("doc.md"));
        expect(s.editorMode()).toBe("split");
        const first = s.paneManager.activePane();
        first.tabs.openTab(file("doc.md"), "root");
        flush();
        s.setSelectedFile(file("doc.pdf"));
        expect(s.editorMode()).toBe("preview");
        first.tabs.snapshotActiveTab();
        flush();
        expect(first.tabs.getActiveTab()?.editorMode).toBe("split");
        s.setSelectedFile(file("doc.md"));
        s.paneManager.splitFromActive();
        flush();
        s.setSelectedFile(file("other.md"));
        s.setEditorMode("edit");
        expect(s.editorMode()).toBe("edit");
        s.paneManager.setActivePane(0);
        flush();
        expect(s.editorMode()).toBe("split");
        first.setEditorMode("preview");
        flush();
        first.tabs.restoreActiveTab();
        flush();
        expect(s.editorMode()).toBe("split");
      });
      expect(warn.mock.calls.flat().join(" ")).not.toContain("EFFECT_WRITES_OWN_SOURCE");
      expect(error.mock.calls.flat().join(" ")).not.toMatch(/PRIMITIVE_|REACTIVE_WRITE/);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

it("restores the pane mode and content when closing and reopening a PDF tab", () => {
  const { pane, dispose } = createRoot((dispose) => ({
    pane: createPaneStore("close-reopen"),
    dispose,
  }));
  try {
    const markdownId = pane.tabs.openTab({ kind: "file", name: "doc.md", path: "doc.md" }, "root");
    flush();
    pane.setEditorMode("split");
    flush();
    pane.setEditorContent("From Markdown");
    flush();

    const pdfId = pane.tabs.openTab({ kind: "file", name: "doc.pdf", path: "doc.pdf" }, "root");
    flush();
    pane.setEditorMode("preview");
    flush();
    pane.setEditorContent("From PDF");
    flush();
    pane.tabs.snapshotActiveTab();
    flush();

    pane.tabs.closeTab(pdfId);
    flush();
    expect(pane.tabs.activeTabId()).toBe(markdownId);
    expect(pane.editorMode()).toBe("split");
    expect(pane.editorContent()).toBe("From Markdown");

    pane.tabs.reopenClosedTab();
    flush();
    expect(pane.tabs.activeTabId()).toBe(pdfId);
    expect(pane.editorMode()).toBe("preview");
    expect(pane.editorContent()).toBe("From PDF");
  } finally {
    dispose();
  }
});

describe("AppState — sidebar / TOC slices (DJA-42)", () => {
  it("sidebar starts visible by default", () => {
    withState((state) => {
      expect(state.sidebarVisible()).toBe(true);
    });
  });

  it("setSidebarVisible flips the slot and the new value sticks", () => {
    // Mutation captured: replacing the setter body with `() => {}` or
    // swapping the boolean would fail one of the two assertions.
    withState((state) => {
      state.setSidebarVisible(false);
      expect(state.sidebarVisible()).toBe(false);
      state.setSidebarVisible(true);
      expect(state.sidebarVisible()).toBe(true);
    });
  });

  it("TOC defaults to visible with 3 levels and updates each slot independently", () => {
    // Mutation captured: aliasing tocLevels and tocVisible (e.g. both
    // calling the same setter) would couple two independent toggles.
    withState((state) => {
      expect(state.tocVisible()).toBe(true);
      expect(state.tocLevels()).toBe(3);
      state.setTocVisible(false);
      state.setTocLevels(2);
      expect(state.tocVisible()).toBe(false);
      expect(state.tocLevels()).toBe(2);
    });
  });
});

describe("AppState — editor preferences slice (DJA-42)", () => {
  it("wrap, line numbers, invisibles, sync-scroll defaults come from localStorage", () => {
    // Mutation captured: hardcoding the seed (e.g. `false`) would
    // ignore the persisted preference and surface "false" here.
    localStorage.setItem("markdraw-editor-wrap-text", "true");
    localStorage.setItem("markdraw-editor-show-line-numbers", "true");
    localStorage.setItem("markdraw-editor-show-invisibles", "true");
    localStorage.setItem("markdraw-editor-sync-scroll", "true");
    withState((state) => {
      expect(state.wrapText()).toBe(true);
      expect(state.showLineNumbers()).toBe(true);
      expect(state.showInvisibles()).toBe(true);
      expect(state.syncScroll()).toBe(true);
    });
  });

  it("handleWrapTextChange / handleLineNumbersChange / handleShowInvisiblesChange / handleSyncScrollChange persist", () => {
    // Mutation captured: dropping the setStored* call from any handler
    // would let the UI flip the value live but lose it on reload —
    // the read-back assertions below would fail for that field.
    withState((state) => {
      state.handleWrapTextChange(true);
      state.handleLineNumbersChange(true);
      state.handleShowInvisiblesChange(true);
      state.handleSyncScrollChange(true);
      expect(localStorage.getItem("markdraw-editor-wrap-text")).toBe("true");
      expect(localStorage.getItem("markdraw-editor-show-line-numbers")).toBe("true");
      expect(localStorage.getItem("markdraw-editor-show-invisibles")).toBe("true");
      expect(localStorage.getItem("markdraw-editor-sync-scroll")).toBe("true");
    });
  });

  it("handleIndentModeChange + handleIndentSizeChange persist and update the live signal", () => {
    withState((state) => {
      state.handleIndentModeChange("tabs");
      state.handleIndentSizeChange(4);
      expect(state.indentMode()).toBe("tabs");
      expect(state.indentSize()).toBe(4);
      // Different mode + size persists distinctly.
      state.handleIndentModeChange("spaces");
      state.handleIndentSizeChange(2);
      expect(state.indentMode()).toBe("spaces");
      expect(state.indentSize()).toBe(2);
    });
  });
});

describe("AppState — fonts slice (DJA-42)", () => {
  it("handleFontPrefsChange merges the partial and persists the merged shape", () => {
    // Mutation captured: replacing instead of merging the partial would
    // drop the family field below — the read-back asserts both fields
    // survived together.
    withState((state) => {
      const initial = state.fontPrefs();
      state.handleFontPrefsChange({ family: "Inter" });
      expect(state.fontPrefs()).toEqual({ ...initial, family: "Inter" });
      state.handleFontPrefsChange({ size: "lg" });
      expect(state.fontPrefs().family).toBe("Inter");
      expect(state.fontPrefs().size).toBe("lg");
    });
  });

  it("applies the real font preference keys to the document CSS", () => {
    localStorage.setItem(
      "markdraw-font-prefs",
      JSON.stringify({ fontFamily: "serif", fontSize: 24 }),
    );
    const css = document.documentElement.style;
    try {
      withState((state) => {
        expect(state.fontPrefs()).toEqual({ fontFamily: "serif", fontSize: 24 });
        expect(css.getPropertyValue("--doc-font-family")).toContain("Georgia");
        expect(css.getPropertyValue("--doc-font-size")).toBe("24px");
        state.handleFontPrefsChange({ fontFamily: "monospace", fontSize: 32 });
        expect(state.fontPrefs()).toEqual({ fontFamily: "monospace", fontSize: 32 });
        expect(css.getPropertyValue("--doc-font-family")).toBe("var(--font-mono)");
        expect(css.getPropertyValue("--doc-font-size")).toBe("32px");
      });
    } finally {
      css.removeProperty("--doc-font-family");
      css.removeProperty("--doc-font-size");
    }
  });
});

describe("AppState — auto-refresh slice (DJA-42)", () => {
  it("autoRefresh defaults to true (watcher kicks in unless the user opts out)", () => {
    // Domain rule documented in wiki/architecture/preview-pipeline.md:
    // first-time users get live reload by default — flipping the seed
    // to false would break the "edit a file, see preview update"
    // golden path without any user opt-in.
    withState((state) => {
      expect(state.autoRefresh()).toBe(true);
    });
  });

  it("setAutoRefresh toggles between true and false", () => {
    withState((state) => {
      state.setAutoRefresh(false);
      expect(state.autoRefresh()).toBe(false);
      state.setAutoRefresh(true);
      expect(state.autoRefresh()).toBe(true);
    });
  });
});

describe("AppState — navigation slice (DJA-42)", () => {
  function fsentry(name: string, path = name): FSEntry {
    return { name, path, kind: "file" };
  }

  it("starts with an empty stack and canGoBack/canGoForward = false", () => {
    withState((state) => {
      expect(state.navStack()).toEqual([]);
      expect(state.navIndex()).toBe(-1);
      expect(state.canGoBack()).toBe(false);
      expect(state.canGoForward()).toBe(false);
    });
  });

  it("pushNavHistory grows the stack and points navIndex at the new entry", () => {
    // Mutation captured: replacing `setNavIndex(stack.length - 1)` with
    // a literal `0` would freeze the index at the first item and the
    // "two pushes → index=1" assertion fails.
    withState((state) => {
      state.pushNavHistory({ entry: fsentry("a.md"), rootId: "r1" });
      expect(state.navStack()).toHaveLength(1);
      expect(state.navIndex()).toBe(0);
      state.pushNavHistory({ entry: fsentry("b.md"), rootId: "r1" });
      expect(state.navStack()).toHaveLength(2);
      expect(state.navIndex()).toBe(1);
    });
  });

  it("pushNavHistory after a back-step truncates the forward history (browser-like)", () => {
    // Domain rule: when the user goes back two steps and opens a new
    // file, the "forward" history must be discarded — otherwise the
    // forward button would jump to a stale future the user no longer
    // expects.
    withState((state) => {
      state.pushNavHistory({ entry: fsentry("a.md"), rootId: "r" });
      state.pushNavHistory({ entry: fsentry("b.md"), rootId: "r" });
      state.pushNavHistory({ entry: fsentry("c.md"), rootId: "r" });
      // Simulate two "back" steps by directly resetting navIndex.
      state.setNavIndex(0);
      state.pushNavHistory({ entry: fsentry("d.md"), rootId: "r" });
      const stack = state.navStack();
      expect(stack.map((e) => e.path)).toEqual(["a.md", "d.md"]);
      expect(state.navIndex()).toBe(1);
    });
  });

  it("canGoBack / canGoForward reflect the position inside the stack", () => {
    // Mutation captured: swapping `>` for `>=` in canGoBack would
    // allow back-stepping past index 0; the empty-stack branch above
    // already locks the lower bound and this test locks the
    // mid-stack guard.
    withState((state) => {
      state.pushNavHistory({ entry: fsentry("a.md"), rootId: "r" });
      state.pushNavHistory({ entry: fsentry("b.md"), rootId: "r" });
      expect(state.canGoBack()).toBe(true);
      expect(state.canGoForward()).toBe(false);
      state.setNavIndex(0);
      expect(state.canGoBack()).toBe(false);
      expect(state.canGoForward()).toBe(true);
    });
  });
});

describe("AppState — viewer capabilities (edit/preview por tipo)", () => {
  const f = (name: string): FSEntry => ({ name, path: name, kind: "file" });

  it("document (md/adoc) habilita edit E preview", () => {
    withState((state) => {
      state.setSelectedFile(f("doc.md"));
      expect(state.canEdit()).toBe(true);
      expect(state.canPreview()).toBe(true);
    });
  });

  it("imagem/pdf/svg são preview-only (sem edit)", () => {
    // Mutation: canEdit retornando true para mídia acenderia as tabs
    // edit/split de um binário que o usuário não pode editar.
    withState((state) => {
      for (const name of ["pic.png", "photo.jpeg", "anim.gif", "scan.pdf", "logo.svg"]) {
        state.setSelectedFile(f(name));
        expect(state.canEdit()).toBe(false);
        expect(state.canPreview()).toBe(true);
      }
    });
  });

  it("texto puro (json/txt/yaml) é edit-only (sem preview renderizado)", () => {
    withState((state) => {
      for (const name of ["data.json", "notes.txt", "conf.yaml"]) {
        state.setSelectedFile(f(name));
        expect(state.canEdit()).toBe(true);
        expect(state.canPreview()).toBe(false);
      }
    });
  });

  it("binário não suportado (UNSUPPORTED_CONTENT no html) desabilita ambos", () => {
    // Mutation: remover o short-circuit isUnsupported() deixaria canEdit
    // true (como um .json) e abriria editor para lixo binário.
    withState((state) => {
      state.setSelectedFile(f("archive.zip"));
      state.setHtml(UNSUPPORTED_CONTENT);
      expect(state.canEdit()).toBe(false);
      expect(state.canPreview()).toBe(false);
    });
  });

  it("sem arquivo selecionado ambos são false (toggle desabilitado)", () => {
    withState((state) => {
      expect(state.canEdit()).toBe(false);
      expect(state.canPreview()).toBe(false);
    });
  });
});

describe("AppState — active-file context chip (gate by file kind)", () => {
  const f = (name: string): FSEntry => ({ name, path: name, kind: "file" });

  it("admits a document (md/adoc) as the active-file chip", () => {
    withState((state) => {
      state.setSelectedFile(f("notes.md"));
      expect(state.activeFileContext()).toEqual({ label: "notes.md", path: "notes.md" });
    });
  });

  it("admits an .excalidraw diagram (label-only chip; the read tool serves a scene outline)", () => {
    // Mutation: reverting the gate to `kind === "document"` would hide the chip
    // for an open diagram even though app__read_active_doc can now describe it.
    withState((state) => {
      state.setSelectedFile(f("flow.excalidraw"));
      expect(state.activeFileContext()).toEqual({ label: "flow.excalidraw", path: "flow.excalidraw" });
    });
  });

  it("stays hidden for media and plain-text kinds (nothing useful to read)", () => {
    withState((state) => {
      for (const name of ["pic.png", "scan.pdf", "data.json"]) {
        state.setSelectedFile(f(name));
        expect(state.activeFileContext()).toBeNull();
      }
    });
  });

  it("dismiss hides the chip; switching files re-shows it", () => {
    // Assert OUTSIDE the root body so the re-show effect (selectedFile → reset
    // dismissed) has flushed before we read the memo back.
    const state = withState((s) => s);
    state.setSelectedFile(f("a.md"));
    state.dismissActiveFileContext();
    expect(state.activeFileContext()).toBeNull();
    state.setSelectedFile(f("b.excalidraw"));
    expect(state.activeFileContext()).toEqual({ label: "b.excalidraw", path: "b.excalidraw" });
  });
});

describe("AppState — reader mode slice (DJA-42)", () => {
  it("setReaderMode persists to localStorage so the state survives reload", () => {
    // Domain rule: the user reaches reader mode mid-focus session.
    // Closing/reopening the window should keep them in reader mode
    // (no chrome flicker between sessions).
    withState((state) => {
      state.setReaderMode(true);
      expect(state.readerMode()).toBe(true);
      // The exact storage key is owned by reader-mode.ts; we assert
      // SOMETHING was persisted so a future drop of the persist call
      // surfaces here.
      const persisted = Object.keys(localStorage).some((k) =>
        k.toLowerCase().includes("reader"),
      );
      expect(persisted).toBe(true);
    });
  });

  it("setReaderMode accepts a function updater", () => {
    // Mutation captured: replacing the updater branch with a constant
    // would break toggle-style consumers (Cmd+. handler in app.tsx).
    withState((state) => {
      state.setReaderMode(true);
      state.setReaderMode((prev) => !prev);
      expect(state.readerMode()).toBe(false);
    });
  });
});

describe("AppState — AI multi-chat tab routing", () => {
  const stubProvider = {
    async *chat() {
      yield { type: "done" as const };
    },
    async complete() {
      return "";
    },
    async embed() {
      return [];
    },
  };
  const aiConfig = { createAIProvider: () => stubProvider };

  it("boots onto an AI chat by default (AI-first)", () => {
    withState((state) => {
      expect(state.aiActiveTab().startsWith("chat:")).toBe(true);
      expect(state.aiSessions.sessions()).toHaveLength(1);
    }, aiConfig);
  });

  it("restores a persisted open chat on two consecutive boots without creating an empty chat", () => {
    for (let boot = 0; boot < 2; boot++) {
      setChatSessionsIndex({
        sessions: [
          { id: "existing", title: "Saved", createdAt: 1, lastActiveAt: 1, isArchived: false, isOpen: true },
        ],
        activeId: "existing",
      });
      let dispose!: () => void;
      const state = createRoot((stop) => {
        dispose = stop;
        return createAppState(makeConfig(aiConfig));
      });
      flush();
      try {
        expect(state.aiSessions.sessions().map((s) => s.id)).toEqual(["existing"]);
        expect(state.aiActiveTab()).toBe("chat:existing");
      } finally {
        dispose();
      }
    }
  });

  it("focusAiComposer creates a chat when none exist and fronts it", () => {
    // ⌘L must always land in a usable composer — if no chat is open it
    // creates one rather than fronting an empty surface.
    withState((state) => {
      state.focusAiComposer();
      expect(state.aiActiveTab().startsWith("chat:")).toBe(true);
      expect(state.aiSessions.sessions()).toHaveLength(1);
    }, aiConfig);
  });

  it("setAiActiveTab routes a chat tab through activateSession", () => {
    withState((state) => {
      const id = state.newChat();
      state.setAiActiveTab("toc");
      expect(state.aiActiveTab()).toBe("toc");
      state.setAiActiveTab(`chat:${id}`);
      expect(state.aiActiveTab()).toBe(`chat:${id}`);
      expect(state.aiSessions.activeId()).toBe(id);
    }, aiConfig);
  });

  it("addSelectionToContext adds a labelled selection chip", () => {
    withState((state) => {
      state.addSelectionToContext({ from: 0, to: 5, text: "hello" });
      const items = state.aiContextItems();
      expect(items).toHaveLength(1);
      expect(items[0]!.kind).toBe("selection");
      expect(items[0]!.content).toBe("hello");
      // No active file in this stub → label falls back to "selection:lines".
      expect(items[0]!.label).toMatch(/:\d+-\d+$/);
    }, aiConfig);
  });

  it("addSelectionToContext hands the mounted composer a reference with the chip label, bumping seq", () => {
    withState((state) => {
      const requests: AiInlineReference[] = [];
      const unregister = state.aiInlineReferenceHost.register((reference) => {
        requests.push(reference);
        return true;
      });
      state.addSelectionToContext({ from: 0, to: 5, text: "hello" });
      const first = state.aiContextItems()[0]!;
      expect(requests).toEqual([{ itemId: first.id, seq: 1, token: first.label }]);
      // A second selection arrives as its own request with a HIGHER seq.
      state.addSelectionToContext({ from: 6, to: 8, text: "wo" });
      const second = state.aiContextItems()[1]!;
      expect(requests[1]).toEqual({ itemId: second.id, seq: 2, token: second.label });
      unregister();
      // With no composer registered the request waits instead of vanishing.
      state.addSelectionToContext({ from: 9, to: 10, text: "x" });
      expect(requests).toHaveLength(2);
      expect(state.aiInlineReferenceHost.takePending()?.itemId).toBe(state.aiContextItems()[2]!.id);
    }, aiConfig);
  });

  it("keeps a reference pending while no composer takes it, and drains it once", () => {
    withState((state) => {
      state.requestAiInlineReference("selection:a", "a:sel");
      expect(state.aiInlineReferenceHost.takePending()).toEqual({
        itemId: "selection:a",
        seq: 1,
        token: "a:sel",
      });
      // Drained: a composer mounting later has no stale request to replay.
      expect(state.aiInlineReferenceHost.takePending()).toBeNull();

      // A detached composer (answers false) must not swallow the request —
      // it stays pending until one in the document answers true.
      const unregisterDetached = state.aiInlineReferenceHost.register(() => false);
      state.requestAiInlineReference("selection:b", "b:sel");
      expect(state.aiInlineReferenceHost.takePending()?.token).toBe("b:sel");

      const taken: string[] = [];
      const unregisterLive = state.aiInlineReferenceHost.register((reference) => {
        taken.push(reference.token);
        return true;
      });
      state.requestAiInlineReference("selection:c", "c:sel");
      expect(taken).toEqual(["c:sel"]);
      expect(state.aiInlineReferenceHost.takePending()).toBeNull();
      unregisterLive();
      unregisterDetached();
    }, aiConfig);
  });

  it("ignores a blank/whitespace selection", () => {
    withState((state) => {
      state.addSelectionToContext({ from: 0, to: 3, text: "   " });
      expect(state.aiContextItems()).toHaveLength(0);
      expect(state.aiInlineReferenceHost.takePending()).toBeNull();
    }, aiConfig);
  });

  it("addPreviewSelectionToContext labels the chip '<file>:sel' with -2/-3 dedupe", () => {
    withState((state) => {
      const requests: AiInlineReference[] = [];
      const unregister = state.aiInlineReferenceHost.register((reference) => {
        requests.push(reference);
        return true;
      });
      const text = "This is a long preview selection that needs truncating";
      state.addPreviewSelectionToContext(text);
      const items = state.aiContextItems();
      expect(items).toHaveLength(1);
      expect(items[0]!.kind).toBe("selection");
      // The selected text rides `content` untouched; the label is the short
      // token-friendly form ("preview" — no active file in this stub).
      expect(items[0]!.content).toBe(text);
      expect(items[0]!.label).toBe("preview:sel");
      expect(requests).toEqual([{ itemId: items[0]!.id, seq: 1, token: "preview:sel" }]);
      // A second, different selection dedupes against the existing label.
      state.addPreviewSelectionToContext("another bit");
      expect(state.aiContextItems()[1]!.label).toBe("preview:sel-2");
      expect(requests[1]?.token).toBe("preview:sel-2");
      unregister();
      // Whitespace-only selections are ignored.
      state.addPreviewSelectionToContext("   \n ");
      expect(state.aiContextItems()).toHaveLength(2);
    }, aiConfig);
  });

  it("addSelectionContextFromPopover routes a preview-sourced popover to the preview path", () => {
    withState((state) => {
      state.setSelectionPopover({ bottom: 0, left: 0, source: "preview", text: "short text" });
      state.addSelectionContextFromPopover();
      const items = state.aiContextItems();
      expect(items).toHaveLength(1);
      expect(items[0]!.kind).toBe("selection");
      expect(items[0]!.label).toBe("preview:sel");
      expect(items[0]!.content).toBe("short text");
      // Same post-add behavior as the editor path: popover closes.
      expect(state.selectionPopover()).toBeNull();
    }, aiConfig);
  });

  it("addFileMention adds a file context CHIP, deduped by id", () => {
    withState((state) => {
      state.addFileMention({ content: "x", label: "a.md", path: "a.md", rootId: "r" });
      state.addFileMention({ content: "x", label: "a.md", path: "a.md", rootId: "r" });
      const items = state.aiContextItems();
      expect(items).toHaveLength(1);
      expect(items[0]!.id).toBe("mention:r:a.md");
      expect(items[0]!.kind).toBe("file");
      // The chip's × removes the reference.
      state.removeAiContext("mention:r:a.md");
      expect(state.aiContextItems()).toHaveLength(0);
    }, aiConfig);
  });

  it("reorderAiContext moves the tokened item IDS to the END in textual order; others keep position first", () => {
    withState((state) => {
      // An untokened item (a selection) plus two mentions added in one order...
      state.addSelectionToContext({ from: 0, to: 5, text: "hello" });
      state.addFileMention({ content: "A", label: "a.md", path: "a.md", rootId: "r" });
      state.addFileMention({ content: "B", label: "b.md", path: "b.md", rootId: "r" });
      // ...reordered by ID to the composer tokens' textual order (b before
      // a). The context preamble is built in array order, so this IS the
      // order the model receives the references in.
      state.reorderAiContext(["mention:r:b.md", "mention:r:a.md"]);
      const labels = state.aiContextItems().map((i) => i.label);
      expect(labels).toHaveLength(3);
      // The untokened selection keeps its position, FIRST, before the
      // tokened block.
      expect(state.aiContextItems()[0]!.kind).toBe("selection");
      expect(labels.slice(1)).toEqual(["b.md", "a.md"]);
    }, aiConfig);
  });

  it("reorderAiContext can move a tokened selection by its id too", () => {
    withState((state) => {
      state.addSelectionToContext({ from: 0, to: 5, text: "hello" });
      const selectionId = state.aiContextItems()[0]!.id;
      state.addFileMention({ content: "A", label: "a.md", path: "a.md", rootId: "r" });
      state.reorderAiContext(["mention:r:a.md", selectionId]);
      expect(state.aiContextItems().map((i) => i.id)).toEqual(["mention:r:a.md", selectionId]);
    }, aiConfig);
  });

  it("injects mention chips into the sent message; removing a chip drops its content", async () => {
    let sent: { role: string; content: string }[] | undefined;
    const provider = {
      async *chat(messages: { role: string; content: string }[]) {
        sent = messages;
        yield { type: "done" as const };
      },
      async complete() {
        return "";
      },
      async embed() {
        return [];
      },
    };
    await withState(async (state) => {
      state.addFileMention({ content: "ALPHA", label: "a.md", path: "a.md", rootId: "r" });
      state.addFileMention({ content: "BETA", label: "b.md", path: "b.md", rootId: "r" });
      // Removing b.md's chip (its ×) drops it from the next send.
      state.removeAiContext("mention:r:b.md");
      const id = state.newChat();
      await state.aiSessions.storeFor(id)!.sendMessage("hi");
      expect(sent?.at(-1)?.content).toContain("ALPHA");
      expect(sent?.at(-1)?.content).not.toContain("BETA");
      expect(sent?.at(-1)?.content).toContain("hi");
    }, { createAIProvider: () => provider });
  });

  it("injects a folder mention chip as a kind=\"folder\" context block until its chip is removed", async () => {
    let sent: { role: string; content: string }[] | undefined;
    const provider = {
      async *chat(messages: { role: string; content: string }[]) {
        sent = messages;
        yield { type: "done" as const };
      },
      async complete() {
        return "";
      },
      async embed() {
        return [];
      },
    };
    await withState(async (state) => {
      // Folder mentions ride the exact same registration path as files — only
      // the kind/id mapping differs.
      state.addFileMention({ content: "- src/a.md", kind: "folder", label: "src/", path: "src", rootId: "r" });
      expect(state.aiContextItems()[0]!.id).toBe("folder:r:src");
      const id = state.newChat();
      await state.aiSessions.storeFor(id)!.sendMessage("hi");
      expect(sent?.at(-1)?.content).toContain('<context kind="folder" source="src/" path="src">');
      expect(sent?.at(-1)?.content).toContain("- src/a.md");
      // Removing the chip drops the listing from the next send.
      state.removeAiContext("folder:r:src");
      await state.aiSessions.storeFor(id)!.sendMessage("again");
      expect(sent?.at(-1)?.content).not.toContain("- src/a.md");
    }, { createAIProvider: () => provider });
  });

  it("closing the active chat falls back to a neighbor, then to empty", () => {
    // closeChat reconciles synchronously: it falls back to a remaining chat,
    // and only when nothing is left does the active tab become "".
    withState((state) => {
      const boot = state.aiSessions.sessions()[0]!.id;
      const b = state.newChat();
      expect(state.aiActiveTab()).toBe(`chat:${b}`);
      state.closeChat(b);
      expect(state.aiActiveTab()).toBe(`chat:${boot}`);
      state.closeChat(boot);
      expect(state.aiActiveTab()).toBe("");
    }, aiConfig);
  });
});

describe("AppState — right-panel tab model (specials + pin)", () => {
  const stubProvider = {
    async *chat() {
      yield { type: "done" as const };
    },
    async complete() {
      return "";
    },
    async embed() {
      return [];
    },
  };
  const aiConfig = { createAIProvider: () => stubProvider };

  it("opens a special (Outline) as a strip tab and activates it", () => {
    withState((state) => {
      expect(state.rightPanelTabs().some((t) => t.kind === "toc")).toBe(false);
      state.openSpecial("toc");
      expect(state.aiActiveTab()).toBe("toc");
      expect(state.rightPanelTabs().some((t) => t.kind === "toc")).toBe(true);
    }, aiConfig);
  });

  it("closing a special hides its chip but keeps a fallback active tab", () => {
    withState((state) => {
      const boot = state.aiSessions.sessions()[0]!.id;
      state.openSpecial("toc");
      expect(state.aiActiveTab()).toBe("toc");
      state.closeRightPanelTab("toc");
      expect(state.rightPanelTabs().some((t) => t.kind === "toc")).toBe(false);
      // Falls back to the open chat.
      expect(state.aiActiveTab()).toBe(`chat:${boot}`);
    }, aiConfig);
  });

  it("pinning a chat sorts it to the front of the strip", () => {
    withState((state) => {
      const boot = state.aiSessions.sessions()[0]!.id;
      const b = state.newChat();
      // Default order: boot (older) before b (newer).
      expect(state.rightPanelTabs().map((t) => t.id)).toEqual([boot, b]);
      state.togglePinRightPanelTab(`chat:${b}`);
      // Pinned floats left.
      expect(state.rightPanelTabs()[0]!.id).toBe(b);
      expect(state.rightPanelTabs()[0]!.pinned).toBe(true);
    }, aiConfig);
  });

  it("Close all spares pinned tabs", () => {
    withState((state) => {
      const boot = state.aiSessions.sessions()[0]!.id;
      const b = state.newChat();
      state.togglePinRightPanelTab(`chat:${boot}`);
      state.closeAllRightPanelTabs();
      const remaining = state.rightPanelTabs().map((t) => t.id);
      expect(remaining).toEqual([boot]);
      expect(remaining).not.toContain(b);
    }, aiConfig);
  });

  it("Close others spares the target and pinned tabs", () => {
    withState((state) => {
      const boot = state.aiSessions.sessions()[0]!.id;
      const b = state.newChat();
      const c = state.newChat();
      state.togglePinRightPanelTab(`chat:${boot}`);
      state.closeOtherRightPanelTabs(`chat:${b}`);
      const ids = state.rightPanelTabs().map((t) => t.id).sort();
      expect(ids).toEqual([boot, b].sort());
      expect(ids).not.toContain(c);
    }, aiConfig);
  });

  it("exportChat forwards a Markdown transcript to onExportChat", async () => {
    const onExportChat = vi.fn();
    const provider = {
      async *chat() {
        yield { type: "text-delta" as const, text: "hello world" };
        yield { type: "done" as const };
      },
      async complete() {
        return "";
      },
      async embed() {
        return [];
      },
    };
    await withState(
      async (state) => {
        const id = state.aiSessions.sessions()[0]!.id;
        await state.aiSessions.storeFor(id)!.sendMessage("hi");
        state.exportChat(id);
        expect(onExportChat).toHaveBeenCalledTimes(1);
        const payload = onExportChat.mock.calls[0]![0] as { title: string; markdown: string };
        expect(payload.markdown).toContain("## You");
        expect(payload.markdown).toContain("hi");
        expect(payload.markdown).toContain("hello world");
      },
      { createAIProvider: () => provider, onExportChat },
    );
  });
});

describe("AppState — right-panel manual reorder (drag-and-drop)", () => {
  const stubProvider = {
    async *chat() {
      yield { type: "done" as const };
    },
    async complete() {
      return "";
    },
    async embed() {
      return [];
    },
  };
  const aiConfig = { createAIProvider: () => stubProvider };
  const RP_KEY = "markdraw-right-panel-tabs";

  function persistedOrder(): string[] | undefined {
    const raw = localStorage.getItem(RP_KEY);
    return raw ? (JSON.parse(raw) as { order?: string[] }).order : undefined;
  }

  // All suites assert OUTSIDE the createRoot body so the persistence effect
  // (rpOrder → localStorage) has flushed before reading storage back.

  it("moving left inserts BEFORE the target; the new order is reflected and persisted", () => {
    const state = withState((s) => s, aiConfig);
    const boot = state.aiSessions.sessions()[0]!.id;
    const b = state.newChat();
    const c = state.newChat();
    expect(state.rightPanelTabs().map((t) => t.id)).toEqual([boot, b, c]);
    state.reorderRightPanelTab(`chat:${c}`, `chat:${boot}`);
    expect(state.rightPanelTabs().map((t) => t.id)).toEqual([c, boot, b]);
    expect(persistedOrder()).toEqual([`chat:${c}`, `chat:${boot}`, `chat:${b}`]);
  });

  it("moving right inserts AFTER the target (dragged lands where the target sat)", () => {
    const state = withState((s) => s, aiConfig);
    const boot = state.aiSessions.sessions()[0]!.id;
    const b = state.newChat();
    const c = state.newChat();
    state.reorderRightPanelTab(`chat:${boot}`, `chat:${b}`);
    expect(state.rightPanelTabs().map((t) => t.id)).toEqual([b, boot, c]);
  });

  it("cross-group clamp: a pinned tab dragged onto an unpinned target lands at the END of the pinned group, still pinned", () => {
    const state = withState((s) => s, aiConfig);
    const boot = state.aiSessions.sessions()[0]!.id;
    const b = state.newChat();
    const c = state.newChat();
    state.togglePinRightPanelTab(`chat:${boot}`);
    state.togglePinRightPanelTab(`chat:${b}`);
    expect(state.rightPanelTabs().map((t) => t.id)).toEqual([boot, b, c]);
    state.reorderRightPanelTab(`chat:${boot}`, `chat:${c}`);
    expect(state.rightPanelTabs().map((t) => t.id)).toEqual([b, boot, c]);
    // Pinned status NEVER changes from a drag.
    expect(state.rightPanelTabs().map((t) => t.pinned)).toEqual([true, true, false]);
  });

  it("cross-group clamp: an unpinned tab dragged onto a pinned target lands at the START of the unpinned group, still unpinned", () => {
    const state = withState((s) => s, aiConfig);
    const boot = state.aiSessions.sessions()[0]!.id;
    const b = state.newChat();
    const c = state.newChat();
    state.togglePinRightPanelTab(`chat:${boot}`);
    expect(state.rightPanelTabs().map((t) => t.id)).toEqual([boot, b, c]);
    state.reorderRightPanelTab(`chat:${c}`, `chat:${boot}`);
    expect(state.rightPanelTabs().map((t) => t.id)).toEqual([boot, c, b]);
    expect(state.rightPanelTabs().map((t) => t.pinned)).toEqual([true, false, false]);
  });

  it("a newly-opened tab lands AFTER the manually-ordered ones of its group", () => {
    const state = withState((s) => s, aiConfig);
    const boot = state.aiSessions.sessions()[0]!.id;
    const b = state.newChat();
    state.reorderRightPanelTab(`chat:${b}`, `chat:${boot}`);
    expect(state.rightPanelTabs().map((t) => t.id)).toEqual([b, boot]);
    const c = state.newChat();
    expect(state.rightPanelTabs().map((t) => t.id)).toEqual([b, boot, c]);
  });

  it("stale ids in the persisted order are ignored (no eager cleanup needed)", () => {
    localStorage.setItem(
      RP_KEY,
      JSON.stringify({
        toc: { open: true, pinned: false, openedAt: 1 },
        backlinks: { open: true, pinned: false, openedAt: 2 },
        activeTab: "toc",
        order: ["chat:ghost", "backlinks", "toc"],
      }),
    );
    const state = withState((s) => s, aiConfig);
    // The ghost chat id is skipped; the remembered specials order still wins
    // over the openedAt sort (toc opened first but ranks after backlinks).
    expect(state.rightPanelTabs().map((t) => t.id)).toEqual(["backlinks", "toc"]);
  });
});

describe("AppState — AI live plan (omp#3)", () => {
  it("starts with no plan (per-app-session, nothing restored from storage)", () => {
    withState((state) => {
      expect(state.aiPlan()).toBeNull();
    });
  });

  it("setAiPlanItems replaces the whole plan; toggleAiPlanItem flips one entry", () => {
    withState((state) => {
      state.setAiPlanItems([
        { done: false, text: "a" },
        { done: false, text: "b" },
      ]);
      expect(state.aiPlan()).toEqual({
        items: [
          { done: false, text: "a" },
          { done: false, text: "b" },
        ],
      });
      state.toggleAiPlanItem(1);
      // Mutation: flipping every item (or always index 0) would break the
      // "only the clicked checkbox toggles" contract.
      expect(state.aiPlan()!.items[0]!.done).toBe(false);
      expect(state.aiPlan()!.items[1]!.done).toBe(true);
      state.toggleAiPlanItem(1);
      expect(state.aiPlan()!.items[1]!.done).toBe(false);
    });
  });

  it("a later setAiPlanItems call REPLACES the previous plan (no merge)", () => {
    // Domain rule: app__update_plan sends the FULL plan each time — state
    // must mirror that, never append.
    withState((state) => {
      state.setAiPlanItems([{ done: true, text: "old" }]);
      state.setAiPlanItems([{ done: false, text: "new" }]);
      expect(state.aiPlan()).toEqual({ items: [{ done: false, text: "new" }] });
    });
  });

  it("toggleAiPlanItem ignores a missing plan and an out-of-range index", () => {
    withState((state) => {
      state.toggleAiPlanItem(0); // no plan yet — must not throw
      expect(state.aiPlan()).toBeNull();
      state.setAiPlanItems([{ done: false, text: "a" }]);
      state.toggleAiPlanItem(5);
      state.toggleAiPlanItem(-1);
      expect(state.aiPlan()).toEqual({ items: [{ done: false, text: "a" }] });
    });
  });

  it("setAiPlanItems(null) and clearAiPlan both drop the plan", () => {
    withState((state) => {
      state.setAiPlanItems([{ done: true, text: "a" }]);
      state.setAiPlanItems(null);
      expect(state.aiPlan()).toBeNull();
      state.setAiPlanItems([{ done: true, text: "a" }]);
      state.clearAiPlan();
      expect(state.aiPlan()).toBeNull();
    });
  });

  it("the plan is per-app-session — nothing written to localStorage", () => {
    // Mutation: persisting the plan would resurrect a stale checklist on the
    // next boot — it's a working agreement for THIS run only.
    withState((state) => {
      state.setAiPlanItems([{ done: false, text: "a" }]);
      const persisted = Object.keys(localStorage).some((k) => k.toLowerCase().includes("plan"));
      expect(persisted).toBe(false);
    });
  });
});

describe("AppState — AI Plan/Build mode", () => {
  // Captures the per-turn provider options (system prompt + tools) so we can
  // assert the mode gating. Yields a non-empty turn so onPlanComplete can fire.
  function captureProvider() {
    const calls: Array<{
      onApprovalRequest?: (req: ToolApprovalRequest) => Promise<boolean>;
      system?: string;
      tools?: AITool[];
    }> = [];
    const provider = {
      // eslint-disable-next-line require-yield
      async *chat(
        _messages: { role: string; content: string }[],
        opts?: {
          onApprovalRequest?: (req: ToolApprovalRequest) => Promise<boolean>;
          system?: string;
          tools?: AITool[];
        },
      ) {
        calls.push({
          onApprovalRequest: opts?.onApprovalRequest,
          system: opts?.system,
          tools: opts?.tools,
        });
        yield { type: "text-delta" as const, text: "PLAN BODY" };
        yield { type: "done" as const };
      },
      async complete() {
        return "";
      },
      async embed() {
        return [];
      },
    };
    return { calls, provider };
  }

  const fakeTools: AITool[] = [
    {
      description: "d",
      execute: async () => ({}),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      name: "edit",
      source: "app",
    },
  ];

  it("defaults to build mode", () => {
    withState((state) => {
      expect(state.aiMode()).toBe("build");
    });
  });

  it("setAiMode switches and persists to localStorage", () => {
    withState((state) => {
      state.setAiMode("plan");
      expect(state.aiMode()).toBe("plan");
      expect(localStorage.getItem("markdraw-ai-mode")).toBe("plan");
      state.setAiMode("build");
      expect(localStorage.getItem("markdraw-ai-mode")).toBe("build");
      state.setAiMode("ask");
      expect(state.aiMode()).toBe("ask");
      expect(localStorage.getItem("markdraw-ai-mode")).toBe("ask");
    });
  });

  it("build mode: forwards tools, auto-approves the gate, and does not save a plan", async () => {
    const { calls, provider } = captureProvider();
    const approvalGate = vi.fn(async () => false);
    const onPlanComplete = vi.fn();
    await withState(
      async (state) => {
        const id = state.newChat();
        await state.aiSessions.storeFor(id)!.sendMessage("hi");
        expect(calls.at(-1)?.system).toBeUndefined();
        expect(calls.at(-1)?.tools).toEqual(fakeTools);
        await expect(
          calls.at(-1)?.onApprovalRequest?.({
            args: {},
            toolName: "edit",
          }),
        ).resolves.toBe(true);
        expect(approvalGate).not.toHaveBeenCalled();
        expect(onPlanComplete).not.toHaveBeenCalled();
      },
      {
        createAIProvider: () => provider,
        getAITools: () => fakeTools,
        onPlanComplete,
        onToolApprovalRequest: approvalGate,
      },
    );
  });

  it("ask mode: forwards tools as prompt-gated and calls the approval gate", async () => {
    const { calls, provider } = captureProvider();
    const approvalGate = vi.fn(async () => false);
    await withState(
      async (state) => {
        state.setAiMode("ask");
        const id = state.newChat();
        await state.aiSessions.storeFor(id)!.sendMessage("hi");
        expect(calls.at(-1)?.tools).toEqual([
          expect.objectContaining({ approval: "prompt", name: "edit" }),
        ]);
        await expect(
          calls.at(-1)?.onApprovalRequest?.({
            args: { path: "notes.md" },
            source: "app",
            toolName: "edit",
          }),
        ).resolves.toBe(false);
        expect(approvalGate).toHaveBeenCalledWith({
          args: { path: "notes.md" },
          source: "app",
          toolName: "edit",
        });
      },
      {
        createAIProvider: () => provider,
        getAITools: () => fakeTools,
        onToolApprovalRequest: approvalGate,
      },
    );
  });

  it("plan mode: no tools, plan system prompt, onPlanComplete gets the text", async () => {
    const { calls, provider } = captureProvider();
    const onPlanComplete = vi.fn();
    await withState(
      async (state) => {
        state.setAiMode("plan");
        const id = state.newChat();
        await state.aiSessions.storeFor(id)!.sendMessage("design X");
        // Plan mode strips tools entirely (store omits the key when empty).
        expect(calls.at(-1)?.tools).toBeUndefined();
        expect(calls.at(-1)?.system).toContain("PLAN mode");
        expect(onPlanComplete).toHaveBeenCalledWith("PLAN BODY");
      },
      {
        createAIProvider: () => provider,
        getAITools: () => fakeTools,
        onPlanComplete,
      },
    );
  });
});

describe("AppState — custom instructions in the system prompt (omp#1)", () => {
  /** Captures the per-turn system prompt the chat hands the provider. */
  function captureProvider() {
    const calls: Array<{ system?: string }> = [];
    const provider = {
      async *chat(
        _messages: { role: string; content: string }[],
        opts?: { system?: string },
      ) {
        calls.push({ system: opts?.system });
        yield { type: "text-delta" as const, text: "ok" };
        yield { type: "done" as const };
      },
      async complete() {
        return "";
      },
      async embed() {
        return [];
      },
    };
    return { calls, provider };
  }

  it("append in build mode: the system prompt is exactly the instructions text", async () => {
    const { calls, provider } = captureProvider();
    await withState(
      async (state) => {
        const id = state.newChat();
        await state.aiSessions.storeFor(id)!.sendMessage("hi");
        expect(calls.at(-1)?.system).toBe("Be terse.");
      },
      {
        createAIProvider: () => provider,
        getCustomInstructions: () => ({ mode: "append", text: "Be terse." }),
      },
    );
  });

  it("append in plan mode: plan prompt + blank line + instructions", async () => {
    const { calls, provider } = captureProvider();
    await withState(
      async (state) => {
        state.setAiMode("plan");
        const id = state.newChat();
        await state.aiSessions.storeFor(id)!.sendMessage("hi");
        const system = calls.at(-1)?.system ?? "";
        expect(system.startsWith("You are in PLAN mode.")).toBe(true);
        expect(system.endsWith("\n\nBe terse.")).toBe(true);
      },
      {
        createAIProvider: () => provider,
        getCustomInstructions: () => ({ mode: "append", text: "Be terse." }),
      },
    );
  });

  it("replace in build mode: the system prompt is exactly the instructions text", async () => {
    const { calls, provider } = captureProvider();
    await withState(
      async (state) => {
        const id = state.newChat();
        await state.aiSessions.storeFor(id)!.sendMessage("hi");
        expect(calls.at(-1)?.system).toBe("You are a pirate.");
      },
      {
        createAIProvider: () => provider,
        getCustomInstructions: () => ({ mode: "replace", text: "You are a pirate." }),
      },
    );
  });

  it("replace in plan mode: the functional plan prompt is ALWAYS kept, text appended", async () => {
    // Domain rule: the plan prompt encodes the tool-less planning contract —
    // "replace" must never strip it, or Plan mode would lose its behavior.
    const { calls, provider } = captureProvider();
    await withState(
      async (state) => {
        state.setAiMode("plan");
        const id = state.newChat();
        await state.aiSessions.storeFor(id)!.sendMessage("hi");
        const system = calls.at(-1)?.system ?? "";
        expect(system.startsWith("You are in PLAN mode.")).toBe(true);
        expect(system.endsWith("\n\nYou are a pirate.")).toBe(true);
      },
      {
        createAIProvider: () => provider,
        getCustomInstructions: () => ({ mode: "replace", text: "You are a pirate." }),
      },
    );
  });

  it("no instructions (callback returns undefined): behavior unchanged in both modes", async () => {
    const { calls, provider } = captureProvider();
    await withState(
      async (state) => {
        const id = state.newChat();
        await state.aiSessions.storeFor(id)!.sendMessage("hi");
        expect(calls.at(-1)?.system).toBeUndefined();
        state.setAiMode("plan");
        await state.aiSessions.storeFor(id)!.sendMessage("again");
        expect(calls.at(-1)?.system).toContain("PLAN mode");
      },
      {
        createAIProvider: () => provider,
        getCustomInstructions: () => undefined,
      },
    );
  });

  it("replace branch toggling modes: build is exactly the text, plan keeps its prompt", async () => {
    // Exercises the EXPLICIT mode branch: build-mode "replace" returns the
    // instructions text alone (no plan-prompt leakage after a mode round
    // trip), while plan mode keeps its functional prompt on the same session.
    const { calls, provider } = captureProvider();
    await withState(
      async (state) => {
        const id = state.newChat();
        await state.aiSessions.storeFor(id)!.sendMessage("hi");
        expect(calls.at(-1)?.system).toBe("You are a pirate.");
        state.setAiMode("plan");
        await state.aiSessions.storeFor(id)!.sendMessage("plan it");
        const planSystem = calls.at(-1)?.system ?? "";
        expect(planSystem.startsWith("You are in PLAN mode.")).toBe(true);
        expect(planSystem.endsWith("\n\nYou are a pirate.")).toBe(true);
        state.setAiMode("build");
        await state.aiSessions.storeFor(id)!.sendMessage("build it");
        expect(calls.at(-1)?.system).toBe("You are a pirate.");
      },
      {
        createAIProvider: () => provider,
        getCustomInstructions: () => ({ mode: "replace", text: "You are a pirate." }),
      },
    );
  });
});

describe("AppState — rewriteTabPaths after a rename or move", () => {
  const file = (path: string): FSEntry => ({
    kind: "file",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
  });

  it("rewrites descendant tabs in every pane, background tabs included, and leaves unrelated paths alone", () => {
    const paneManager = createPaneManager();
    const left = paneManager.activePane();
    const right = paneManager.splitFromActive()!;
    withState(
      (state) => {
        const leftGuide = left.tabs.openTab(file("docs/guide.md"), "root", { background: true });
        left.tabs.updateTabContent(leftGuide, { editorContent: "kept buffer" });
        const leftNested = left.tabs.openTab(file("docs/sub dir/v1.adoc"), "root", { background: true });
        const leftSibling = left.tabs.openTab(file("docset/guide.md"), "root", { background: true });
        const leftOtherRoot = left.tabs.openTab(file("docs/guide.md"), "other-root", { background: true });
        const rightGuide = right.tabs.openTab(file("docs/guide.md"), "root", { background: true });
        right.tabs.markTabNeedsLoad(rightGuide);

        // Solid 2 keeps a store write pending until the flush: read the tabs
        // only after it, or the setup's own tabs look missing.
        flush();

        state.rewriteTabPaths("root", "docs", "manual");

        expect(left.tabs.getTab(leftGuide)).toBeUndefined();
        expect(left.tabs.findTabByFile("manual/guide.md", "root")).toMatchObject({
          fileName: "guide.md",
          editorContent: "kept buffer",
          needsLoad: false,
        });
        expect(left.tabs.getTab(leftNested)).toBeUndefined();
        expect(left.tabs.findTabByFile("manual/sub dir/v1.adoc", "root")).toMatchObject({
          fileName: "v1.adoc",
        });
        // `docset` shares the prefix string but is not under `docs`.
        expect(left.tabs.getTab(leftSibling)).toBeDefined();
        // Another root keeps its own tab untouched.
        expect(left.tabs.getTab(leftOtherRoot)).toBeDefined();
        // The same file open in the second pane follows too, keeping its
        // pending first read for the new path.
        expect(right.tabs.getTab(rightGuide)).toBeUndefined();
        expect(right.tabs.findTabByFile("manual/guide.md", "root")).toMatchObject({
          fileName: "guide.md",
          needsLoad: true,
        });
      },
      { paneManager },
    );
  });

  it("updates an active selection and resolves includes from the live buffer", () => {
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    withState((state) => {
      const entry = file("docs/guide.md");
      const id = pane.tabs.openTab(entry, "root");
      pane.setSelectedFile(entry);
      pane.setSelectedRootId("root");
      pane.setEditorContent("<!-- include: chapter.md -->");
      pane.setSavedContent("old buffer");
      pane.tabs.updateTabContent(id, { includePaths: ["docs/old.md"] });
      flush();
      state.rewriteTabPaths("root", "docs", "manual");
      flush();
      expect(pane.selectedFile()?.path).toBe("manual/guide.md");
      expect(pane.editorContent()).toBe("<!-- include: chapter.md -->");
      expect(pane.savedContent()).toBe("old buffer");
      expect(pane.tabs.getActiveTab()?.includePaths).toEqual(["manual/chapter.md"]);
    }, { paneManager });
  });

  it("keeps the tabs unique when the new path is already open in the same pane", () => {
    const paneManager = createPaneManager();
    const right = paneManager.splitFromActive()!;
    withState(
      (state) => {
        const stale = right.tabs.openTab(file("docs/guide.md"), "root", { background: true });
        const taken = right.tabs.openTab(file("manual/guide.md"), "root", { background: true });
        flush();

        state.rewriteTabPaths("root", "docs", "manual");

        // The rename cannot produce two tabs with one id: the stale tab keeps
        // its old path and the open one is preserved.
        expect(right.tabs.getTab(stale)).toBeDefined();
        expect(right.tabs.getTab(taken)).toBeDefined();
        const ids = right.tabs.tabs().map((tab) => tab.id);
        expect(new Set(ids).size).toBe(ids.length);
      },
      { paneManager },
    );
  });

  it("rewrites a single file's tab, spaces and accents included", () => {
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    withState(
      (state) => {
        const tab = pane.tabs.openTab(file("docs/relatório final.md"), "root", { background: true });
        flush();

        state.rewriteTabPaths("root", "docs/relatório final.md", "docs/relatório 2026.md");

        expect(pane.tabs.getTab(tab)).toBeUndefined();
        expect(pane.tabs.findTabByFile("docs/relatório 2026.md", "root")).toMatchObject({
          fileName: "relatório 2026.md",
        });
      },
      { paneManager },
    );
  });
});


// vi.useFakeTimers() replaces the clocks; keep the real ones to let real I/O finish.
const realSetTimeout = setTimeout;
const realNow = performance.now.bind(performance);

// MD_PERF_REPORT=<file> appends the measurements the cost tests take there
// (Vitest hides the output of passing tests).
function perfLine(label: string, value: unknown) {
  const file = process.env.MD_PERF_REPORT;
  if (file) appendFileSync(file, `[perf] ${label}: ${JSON.stringify(value)}\n`);
}

// ── Conversion cost: autosave echo, overlapping edits, nested includes ─────
//
// End to end through the real loader, autosave, watcher, folder and app state;
// only the Tauri bridge (invoke) and the converter are stubbed. The converter
// stub collects includes with the real `collectIncludes`, so the IPC counts
// below are the ones the production path makes.

describe("conversion cost", () => {
  const ROOT = "/perf-workspace";
  const MAIN = "main.adoc";
  const entry: FSEntry = { kind: "file", path: MAIN, name: MAIN };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // The scout's fixture shape: a main document with 10 direct includes, each
  // including 1 nested file (21 files, 20 includes).
  function syntheticDisk() {
    const disk = new Map<string, string>();
    let main = "= Perf\n\n";
    for (let i = 0; i < 10; i++) {
      main += `include::partials/p${i}.adoc[]\n\n`;
      disk.set(`${ROOT}/partials/p${i}.adoc`, `== Part ${i}\n\ninclude::nested/n${i}.adoc[]\n`);
      disk.set(`${ROOT}/partials/nested/n${i}.adoc`, `Leaf ${i}\n`);
    }
    disk.set(`${ROOT}/${MAIN}`, main);
    return disk;
  }

  interface Counters {
    conversions: number;
    readFile: number;
    readFileRelative: number;
    readFilesRelative: number;
    batchPaths: number;
    writes: number;
  }

  async function makeApp(over: { convertDelay?: () => Promise<void>; readDelay?: () => Promise<void> } = {}) {
    const disk = syntheticDisk();
    let files = [entry];
    const counters: Counters = { conversions: 0, readFile: 0, readFileRelative: 0, readFilesRelative: 0, batchPaths: 0, writes: 0 };
    const watched: string[][] = [];
    const listeners = new Map<string, (event: unknown) => void>();
    let callbackId = 0;
    const callbacks = new Map<number, (event: unknown) => void>();
    vi.stubGlobal("__TAURI_INTERNALS__", {
      transformCallback: (cb: (event: unknown) => void) => {
        callbacks.set(++callbackId, cb);
        return callbackId;
      },
      invoke: async (command: string, args: Record<string, any>) => {
        if (command === "watch_paths") watched.push(args.paths);
        if (command === "read_dir") {
          return files.filter((file) => disk.has(`${args.path}/${file.path}`));
        }
        if (command === "move_path") {
          const oldPath = `${args.srcRoot}/${args.srcRelative}`;
          disk.set(`${args.dstRoot}/${args.dstRelative}`, disk.get(oldPath)!);
          disk.delete(oldPath);
          return undefined;
        }
        if (command === "rename_file") {
          const oldPath = `${args.root}/${args.oldRelative}`;
          disk.set(`${args.root}/${args.newRelative}`, disk.get(oldPath)!);
          disk.delete(oldPath);
          files = files.map((file) => file.path === args.oldRelative
            ? { ...file, path: args.newRelative, name: args.newRelative }
            : file);
          return undefined;
        }
        if (command === "read_file") {
          counters.readFile++;
          // The text is captured when the read starts: a delayed read answers
          // with the disk as it was then, like a slow real read.
          const captured = disk.get(args.path);
          await over.readDelay?.();
          return captured;
        }
        if (command === "read_file_relative") {
          counters.readFileRelative++;
          const content = disk.get(`${args.root}/${args.relativePath}`);
          if (content === undefined) throw new Error("not found");
          return content;
        }
        if (command === "read_files_relative") {
          counters.readFilesRelative++;
          counters.batchPaths += args.paths.length;
          const out: Record<string, string> = {};
          for (const rel of args.paths as string[]) {
            const content = disk.get(`${args.root}/${rel}`);
            if (content !== undefined) out[rel] = content;
          }
          return out;
        }
        if (command === "write_file") {
          counters.writes++;
          disk.set(args.path, args.content);
          return undefined;
        }
        if (command === "plugin:event|listen") {
          listeners.set(args.event, callbacks.get(args.handler)!);
          return args.handler;
        }
        return undefined;
      },
    });
    vi.stubGlobal("__TAURI_EVENT_PLUGIN_INTERNALS__", { unregisterListener: vi.fn() });

    const ownWrites = createOwnWrites();
    // Every refresh a watcher event starts; tests wait for them to settle.
    const refreshes: Promise<unknown>[] = [];
    const watcher = new FileWatcher((paths) => {
      const pane = app.paneManager.activePane();
      const file = pane.selectedFile();
      if (!file) return;
      refreshes.push(app.loader.refreshFromDisk(file, undefined, paths));
    });
    const app = createRoot((dispose) => {
      const paneManager = createPaneManager({
        onTabSelected: (pane, tab) => { void actions.selectTab(pane, tab); },
      });
      const state = createAppState({
        paneManager,
        getStoredTheme: () => "system",
        applyTheme: () => {},
        convertAdoc: async (opts) => {
          counters.conversions++;
          // Like the real converter: includes resolve from the document's folder.
          const baseDir = opts.filePath.includes("/") ? opts.filePath.slice(0, opts.filePath.lastIndexOf("/")) : "";
          const included = await collectIncludes(opts.fileContent, baseDir, opts.readFile, new Set(), opts.readFiles);
          await over.convertDelay?.();
          return { html: `<p>${opts.fileContent.length}:${included.size}</p>`, frontmatter: null };
        },
        convertMarkdown: async ({ fileContent }) => ({ html: fileContent, frontmatter: null }),
      });
      const [rootPaths, setRootPaths] = createSignal(new Map<string, string>());
      const loader = createFileLoader({ state, rootPaths, watcher, ownWrites });
      const actions = createTabActions({
        state,
        rootPaths,
        syncWatcher: loader.syncWatcher,
        loadFileContent: loader.loadFileContent,
        loadTabContent: loader.loadTabContent,
      });
      const folder = createFolder({ state, rootPaths, setRootPaths, watcher, onRootClosed: actions.closeRootTabs, onFileRenamed: actions.renameOpenTab });
      createFileAutosave(state, folder.handleEditorSave, () => {}, {
        writes: ownWrites,
        rootPath: (rootId) => (rootId ? rootPaths().get(rootId) : undefined),
      });
      return { actions, folder, loader, paneManager, state, dispose };
    });
    expect(await app.folder.openFolderPath(ROOT)).toBe(true);
    return {
      app,
      counters,
      watched,
      disk,
      watcher,
      addFile: (file: FSEntry) => { files = [...files, file]; },
      /** What Rust emits after its 500 ms debounce. */
      emitFsChange: async (paths?: string[]) => {
        const fire = listeners.get("fs-change");
        expect(fire).toBeDefined(); // the watcher registered its listener
        const before = refreshes.length;
        fire!({ event: "fs-change", id: 1, payload: paths === undefined ? {} : { paths } });
        expect(refreshes.length).toBe(before + 1); // the event reached a refresh
        // Settle that refresh for real: its timers are faked, but hashing the
        // text (crypto.subtle) needs real event-loop turns.
        let settled = false;
        void refreshes[before]!.then(() => { settled = true; }, () => { settled = true; });
        const deadline = realNow() + 10_000; // real time: a loaded machine hashes slowly
        while (!settled) {
          if (realNow() > deadline) throw new Error("the refresh never settled");
          await vi.advanceTimersByTimeAsync(10);
          await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
        }
      },
      async close() {
        app.dispose();
        await watcher.destroy();
      },
    };
  }

  /** Types in the editor the way pane-view does. */
  function type(app: Awaited<ReturnType<typeof makeApp>>["app"], text: string) {
    app.state.debouncedConvert(text, MAIN, app.state._readFile ?? (async () => null));
    flush();
  }

  const report = (label: string, value: unknown) => {
    perfLine(label, value);
  };

  /** Opens the main file in split mode and returns the helpers of one edit cycle. */
  async function openForEditing() {
    const h = await makeApp();
    await h.app.actions.openFile(entry, ROOT, true);
    flush();
    const pane = h.app.paneManager.activePane();
    pane.setEditorMode("split"); // autosave only runs while editing
    flush();
    vi.useFakeTimers();
    return {
      h,
      pane,
      /** Type, wait for the preview conversion and the autosave write. */
      async editAndSave(text: string) {
        type(h.app, text);
        await vi.advanceTimersByTimeAsync(300);
        await vi.advanceTimersByTimeAsync(1000);
      },
    };
  }

  it("r4 regression: an older failed watcher read cannot replace a newer preview", async () => {
    let block = false;
    let failRead: (() => void) | undefined;
    const h = await makeApp({
      readDelay: async () => {
        if (!block) return;
        block = false;
        await new Promise<void>((_, reject) => {
          failRead = () => reject(new Error("old watcher read failed"));
        });
      },
    });
    try {
      await h.app.actions.openFile(entry, ROOT, true);
      const pane = h.app.paneManager.activePane();
      const path = `${ROOT}/${MAIN}`;
      vi.useFakeTimers();
      block = true;
      const first = h.emitFsChange([path]);
      const newer = "external text from the later event";
      try {
        await vi.advanceTimersByTimeAsync(10);
        expect(failRead).toBeTypeOf("function");
        h.disk.set(path, newer);
        await h.emitFsChange([path]);
        expect(pane.editorContent()).toBe(newer);
        expect(pane.html()).toBe(`<p>${newer.length}:0</p>`);
      } finally {
        failRead?.();
        await first;
      }
      expect(pane.html()).toBe(`<p>${newer.length}:0</p>`);
    } finally {
      await h.close();
    }
  });

  it("r4 regression: a pending preview edit follows a rename before the debounce", async () => {
    const { h, pane } = await openForEditing();
    try {
      const renamed = "renamed.adoc";
      const text = pane.editorContent() + "\nlatest text before rename\n";
      type(h.app, text);
      await h.app.folder.handleRename(entry, ROOT, renamed);
      flush();
      await vi.advanceTimersByTimeAsync(1300);
      const path = `${ROOT}/${renamed}`;
      expect(pane.selectedFile()?.path).toBe(renamed);
      expect(h.watched.at(-1)?.[0]).toBe(path);
      expect(h.disk.get(path)).toBe(text);
      expect(pane.savedContent()).toBe(text);
      await h.emitFsChange([path]);
      expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
    } finally {
      await h.close();
    }
  });

  it("r4 regression: a pending preview edit follows a tab moved before the debounce", async () => {
    const { h, pane } = await openForEditing();
    try {
      const text = pane.editorContent() + "\nlatest text before pane move\n";
      type(h.app, text);
      h.app.actions.moveTab(pane.tabs.activeTabId()!, 0);
      flush();
      await vi.advanceTimersByTimeAsync(1300);
      const target = h.app.paneManager.activePane();
      const path = `${ROOT}/${MAIN}`;
      expect(target).not.toBe(pane);
      expect(target.selectedFile()?.path).toBe(MAIN);
      expect(h.disk.get(path)).toBe(text);
      expect(target.savedContent()).toBe(text);
      await h.emitFsChange([path]);
      expect(target.html()).toBe(`<p>${text.length}:20</p>`);
    } finally {
      await h.close();
    }
  });

  it("r4 regression: a save echo converts again when the edit conversion failed", async () => {
    let rejectEdit = false;
    const h = await makeApp({
      convertDelay: async () => {
        if (!rejectEdit) return;
        rejectEdit = false;
        throw new Error("transient editor conversion failure");
      },
    });
    try {
      await h.app.actions.openFile(entry, ROOT, true);
      const pane = h.app.paneManager.activePane();
      pane.setEditorMode("split");
      flush();
      vi.useFakeTimers();
      const path = `${ROOT}/${MAIN}`;
      const latest = pane.editorContent() + "\nedit after transient failure\n";
      rejectEdit = true;
      type(h.app, latest);
      await vi.advanceTimersByTimeAsync(1300);
      expect(rejectEdit).toBe(false);
      expect(h.disk.get(path)).toBe(latest);
      expect(pane.savedContent()).toBe(latest);
      await h.emitFsChange([path]);
      expect(pane.html()).toBe(`<p>${latest.length}:20</p>`);
    } finally {
      await h.close();
    }
  });

  it("r4 regression: an older failed read of a plain-text file cannot blank the newer text", async () => {
    let block = false;
    let failRead: (() => void) | undefined;
    const h = await makeApp({
      readDelay: async () => {
        if (!block) return;
        block = false;
        await new Promise<void>((_, reject) => {
          failRead = () => reject(new Error("old text read failed"));
        });
      },
    });
    try {
      const notes: FSEntry = { kind: "file", path: "notes.txt", name: "notes.txt" };
      h.addFile(notes);
      const path = `${ROOT}/${notes.path}`;
      h.disk.set(path, "first text");
      await h.app.actions.openFile(notes, ROOT, true);
      const pane = h.app.paneManager.activePane();
      vi.useFakeTimers();
      block = true;
      const first = h.emitFsChange([path]);
      try {
        await vi.advanceTimersByTimeAsync(10);
        expect(failRead).toBeTypeOf("function");
        h.disk.set(path, "text from the later event");
        await h.emitFsChange([path]);
        expect(pane.editorContent()).toBe("text from the later event");
      } finally {
        failRead?.();
        await first;
      }
      expect(pane.editorContent()).toBe("text from the later event");
      expect(pane.savedContent()).toBe("text from the later event");
    } finally {
      await h.close();
    }
  });

  it("r4 regression: a pending preview edit follows a path rewrite of its tab", async () => {
    const { h, pane } = await openForEditing();
    try {
      const rootId = pane.selectedRootId()!;
      const text = pane.editorContent() + "\nlatest text before path rewrite\n";
      type(h.app, text);
      h.app.state.rewriteTabPaths(rootId, MAIN, "rewritten.adoc");
      flush();
      expect(pane.selectedFile()?.path).toBe("rewritten.adoc");
      const before = h.counters.conversions;
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(10);
      expect(h.counters.conversions).toBe(before + 1);
      expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
    } finally {
      await h.close();
    }
  });

  it("r4 regression: once the echo converted a failed edit again, a second echo of that text does not", async () => {
    let rejectEdit = false;
    const h = await makeApp({
      convertDelay: async () => {
        if (!rejectEdit) return;
        rejectEdit = false;
        throw new Error("transient editor conversion failure");
      },
    });
    try {
      await h.app.actions.openFile(entry, ROOT, true);
      const pane = h.app.paneManager.activePane();
      pane.setEditorMode("split");
      flush();
      vi.useFakeTimers();
      const path = `${ROOT}/${MAIN}`;
      const latest = pane.editorContent() + "\nedit after transient failure\n";
      rejectEdit = true;
      type(h.app, latest);
      await vi.advanceTimersByTimeAsync(1300);
      await h.emitFsChange([path]);
      expect(pane.html()).toBe(`<p>${latest.length}:20</p>`);
      const before = h.counters.conversions;
      await h.emitFsChange([path]);
      expect(h.counters.conversions).toBe(before);
    } finally {
      await h.close();
    }
  });

  /** Lets a watcher event go as far as it can while a conversion stays blocked:
   *  hashing the text takes real event-loop turns, its timers are faked. */
  async function pumpEcho() {
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(10);
      await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
    }
  }

  it("r4 control: a failed watcher read with no newer event still reports the error", async () => {
    let fail = false;
    const h = await makeApp({
      readDelay: async () => {
        if (!fail) return;
        fail = false;
        throw new Error("only watcher read failed");
      },
    });
    try {
      await h.app.actions.openFile(entry, ROOT, true);
      const pane = h.app.paneManager.activePane();
      vi.useFakeTimers();
      fail = true;
      await h.emitFsChange([`${ROOT}/${MAIN}`]);
      expect(pane.html()).toContain("only watcher read failed");
    } finally {
      await h.close();
    }
  });

  it("r4 regression: a pending preview edit follows a rename while its conversion runs", async () => {
    let block = false;
    let release: (() => void) | undefined;
    const h = await makeApp({
      convertDelay: async () => {
        if (!block) return;
        block = false;
        await new Promise<void>((resolve) => { release = resolve; });
      },
    });
    try {
      await h.app.actions.openFile(entry, ROOT, true);
      const pane = h.app.paneManager.activePane();
      pane.setEditorMode("split");
      flush();
      vi.useFakeTimers();
      const text = pane.editorContent() + "\nedit converting during rename\n";
      block = true;
      type(h.app, text);
      await vi.advanceTimersByTimeAsync(300);
      expect(release).toBeTypeOf("function"); // the conversion is running
      await h.app.folder.handleRename(entry, ROOT, "renamed-running.adoc");
      flush();
      release?.();
      await vi.advanceTimersByTimeAsync(1500);
      const path = `${ROOT}/renamed-running.adoc`;
      expect(h.disk.get(path)).toBe(text);
      await h.emitFsChange([path]);
      expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
    } finally {
      await h.close();
    }
  });

  it.each(["read", "conversion"] as const)(
    "r5 regression: an older watcher %s failure cannot replace a saved edit's preview after the echo",
    async (phase) => {
      let block = false;
      let rejectOld: (() => void) | undefined;
      const delay = async () => {
        if (!block) return;
        block = false;
        await new Promise<void>((_, reject) => {
          rejectOld = () => reject(new Error(`old watcher ${phase} failed`));
        });
      };
      const h = await makeApp(phase === "read" ? { readDelay: delay } : { convertDelay: delay });
      try {
        await h.app.actions.openFile(entry, ROOT, true);
        const pane = h.app.paneManager.activePane();
        pane.setEditorMode("split");
        flush();
        vi.useFakeTimers();
        const path = `${ROOT}/${MAIN}`;
        const included = `${ROOT}/partials/p0.adoc`;
        h.disk.set(included, "External include update");
        block = true;
        const oldRefresh = h.emitFsChange([included]);
        const text = pane.editorContent() + "\nnew edit already rendered and saved\n";
        try {
          await vi.advanceTimersByTimeAsync(20);
          expect(rejectOld).toBeTypeOf("function");
          type(h.app, text);
          await vi.advanceTimersByTimeAsync(1300);
          expect(pane.editorContent()).toBe(text);
          expect(pane.savedContent()).toBe(text);
          expect(h.disk.get(path)).toBe(text);
          await h.emitFsChange([path]); // the echo of the save confirms the preview
          expect(pane.html()).toMatch(new RegExp(`^<p>${text.length}:(19|20)</p>$`));
        } finally {
          rejectOld?.();
          await oldRefresh;
        }
        expect(pane.editorContent()).toBe(text);
        expect(pane.html()).toMatch(new RegExp(`^<p>${text.length}:(19|20)</p>$`));
        expect(pane.html()).not.toContain("error");
      } finally {
        await h.close();
      }
    },
  );

  it("r5 control: a watcher failure that started after the confirmed echo still reports the error", async () => {
    let failNext = false;
    const h = await makeApp({
      readDelay: async () => {
        if (!failNext) return;
        failNext = false;
        throw new Error("newer watcher read failed");
      },
    });
    try {
      await h.app.actions.openFile(entry, ROOT, true);
      const pane = h.app.paneManager.activePane();
      pane.setEditorMode("split");
      flush();
      vi.useFakeTimers();
      const path = `${ROOT}/${MAIN}`;
      const text = pane.editorContent() + "\nsaved edit\n";
      type(h.app, text);
      await vi.advanceTimersByTimeAsync(1300);
      await h.emitFsChange([path]);
      failNext = true;
      await h.emitFsChange([`${ROOT}/partials/p0.adoc`]);
      expect(pane.html()).toContain("newer watcher read failed");
    } finally {
      await h.close();
    }
  });

  async function failedEdit() {
    let mode: "ok" | "fail" | "hold" = "ok";
    let rejectHeld: (() => void) | undefined;
    const h = await makeApp({
      convertDelay: async () => {
        if (mode === "fail") {
          mode = "ok";
          throw new Error("edit conversion failed");
        }
        if (mode === "hold") {
          mode = "ok";
          await new Promise<void>((_, reject) => { rejectHeld = () => reject(new Error("edit conversion failed late")); });
        }
      },
    });
    await h.app.actions.openFile(entry, ROOT, true);
    const pane = h.app.paneManager.activePane();
    pane.setEditorMode("split");
    flush();
    vi.useFakeTimers();
    return {
      h,
      pane,
      arm: (next: "fail" | "hold") => { mode = next; },
      rejectHeld: () => rejectHeld?.(),
    };
  }

  it("r5 regression: the text of a failed edit conversion leaves the map when its tab closes", async () => {
    const { h, pane, arm } = await failedEdit();
    try {
      arm("fail");
      type(h.app, pane.editorContent() + "\nedit that fails\n");
      await vi.advanceTimersByTimeAsync(300);
      expect(h.app.state.publishedPreviews(pane)).toBe(1);
      pane.tabs.closeTab(pane.tabs.activeTabId()!);
      flush();
      expect(h.app.state.publishedPreviews(pane)).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("r5 regression: a conversion that rejects after its tab closed records nothing", async () => {
    const { h, pane, arm, rejectHeld } = await failedEdit();
    try {
      arm("hold");
      type(h.app, pane.editorContent() + "\nedit still converting\n");
      await vi.advanceTimersByTimeAsync(300);
      pane.tabs.closeTab(pane.tabs.activeTabId()!);
      flush();
      rejectHeld();
      await vi.advanceTimersByTimeAsync(10);
      expect(h.app.state.publishedPreviews(pane)).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("r5 control: a rename moves the failed text to the new identity, and closing that tab frees it", async () => {
    const { h, pane, arm } = await failedEdit();
    try {
      arm("fail");
      type(h.app, pane.editorContent() + "\nedit that fails\n");
      await vi.advanceTimersByTimeAsync(300);
      expect(h.app.state.publishedPreviews(pane)).toBe(1);
      await h.app.folder.handleRename(entry, ROOT, "renamed-failed.adoc");
      flush();
      expect(h.app.state.publishedPreviews(pane)).toBe(1);
      pane.tabs.closeTab(pane.tabs.activeTabId()!);
      flush();
      expect(h.app.state.publishedPreviews(pane)).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("r4 control: renaming a document with no pending edit converts nothing", async () => {
    const { h, pane } = await openForEditing();
    try {
      const before = h.counters.conversions;
      await h.app.folder.handleRename(entry, ROOT, "renamed-idle.adoc");
      flush();
      await vi.advanceTimersByTimeAsync(1500);
      expect(pane.selectedFile()?.path).toBe("renamed-idle.adoc");
      expect(h.counters.conversions).toBe(before);
    } finally {
      await h.close();
    }
  });

  it("r4 control: a save echo does not convert again after a successful edit conversion", async () => {
    const { h, pane, editAndSave } = await openForEditing();
    try {
      const text = pane.editorContent() + "\nedit that converts fine\n";
      await editAndSave(text);
      const before = h.counters.conversions;
      await h.emitFsChange([`${ROOT}/${MAIN}`]);
      expect(h.counters.conversions).toBe(before);
      expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
    } finally {
      await h.close();
    }
  });

  it("r4 regression: a save echo waits for the edit conversion still running instead of repeating it", async () => {
    let block = false;
    let release: (() => void) | undefined;
    const h = await makeApp({
      convertDelay: async () => {
        if (!block) return;
        block = false;
        await new Promise<void>((resolve) => { release = resolve; });
      },
    });
    try {
      await h.app.actions.openFile(entry, ROOT, true);
      const pane = h.app.paneManager.activePane();
      pane.setEditorMode("split");
      flush();
      vi.useFakeTimers();
      const path = `${ROOT}/${MAIN}`;
      const text = pane.editorContent() + "\nslow but valid edit\n";
      block = true;
      type(h.app, text);
      await vi.advanceTimersByTimeAsync(1300);
      expect(release).toBeTypeOf("function"); // still converting while the save landed
      expect(h.disk.get(path)).toBe(text);
      const before = h.counters.conversions;
      const echo = h.emitFsChange([path]);
      await pumpEcho(); // the echo hashed the text and now waits for the conversion
      release?.();
      await echo;
      expect(h.counters.conversions).toBe(before); // no second conversion of the same text
      expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
    } finally {
      await h.close();
    }
  });

  it("r4 regression: a save echo converts again when the conversion it waited for failed", async () => {
    let block = false;
    let fail: (() => void) | undefined;
    const h = await makeApp({
      convertDelay: async () => {
        if (!block) return;
        block = false;
        await new Promise<void>((_, reject) => { fail = () => reject(new Error("slow edit conversion failed")); });
      },
    });
    try {
      await h.app.actions.openFile(entry, ROOT, true);
      const pane = h.app.paneManager.activePane();
      pane.setEditorMode("split");
      flush();
      vi.useFakeTimers();
      const path = `${ROOT}/${MAIN}`;
      const text = pane.editorContent() + "\nslow edit that fails\n";
      block = true;
      type(h.app, text);
      await vi.advanceTimersByTimeAsync(1300);
      expect(fail).toBeTypeOf("function");
      const echo = h.emitFsChange([path]);
      await pumpEcho(); // the echo hashed the text and now waits for the conversion
      fail?.();
      await echo;
      expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
    } finally {
      await h.close();
    }
  });

  // One rule for the echo of an autosave: it is skipped only when the HTML on
  // screen was converted from the saved text. An error on screen (published by
  // the watcher's loader before the echo), the HTML of an older text and an
  // identity that was renamed or moved all convert again.
  it.each(["read", "conversion"] as const)(
    "r6 regression: the autosave echo repairs a watcher %s error published just before it",
    async (phase) => {
      let block = false;
      let rejectOld: (() => void) | undefined;
      const delay = async () => {
        if (!block) return;
        block = false;
        await new Promise<void>((_, reject) => {
          rejectOld = () => reject(new Error("temporary watcher failure before echo"));
        });
      };
      const h = await makeApp(phase === "read" ? { readDelay: delay } : { convertDelay: delay });
      try {
        await h.app.actions.openFile(entry, ROOT, true);
        const pane = h.app.paneManager.activePane();
        pane.setEditorMode("split");
        flush();
        vi.useFakeTimers();
        const path = `${ROOT}/${MAIN}`;
        block = true;
        const refresh = h.emitFsChange([`${ROOT}/partials/p0.adoc`]);
        const text = pane.editorContent() + "\nlater local edit\n";
        try {
          await vi.advanceTimersByTimeAsync(20);
          expect(rejectOld).toBeTypeOf("function");
          type(h.app, text);
          await vi.advanceTimersByTimeAsync(1300);
          expect(pane.savedContent()).toBe(text);
          expect(h.disk.get(path)).toBe(text);
          expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
        } finally {
          rejectOld?.();
          await refresh;
        }
        // The older failure reached the screen before the echo did.
        expect(pane.html()).toContain("temporary watcher failure before echo");
        const conversions = h.counters.conversions;
        await h.emitFsChange([path]);
        expect(pane.editorContent()).toBe(text);
        expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
        expect(h.counters.conversions).toBe(conversions + 1); // the echo converted once
        await h.emitFsChange([path]); // and the second echo of that text does not
        expect(h.counters.conversions).toBe(conversions + 1);
      } finally {
        await h.close();
      }
    },
  );

  it("r6 regression: an include error published before the echo of a plain edit is repaired by the echo", async () => {
    // The echo of a save with nothing in flight: the error is on screen from an
    // earlier refresh of the same text, so the preview of the saved text is not.
    let failNext = false;
    const h = await makeApp({
      convertDelay: async () => {
        if (!failNext) return;
        failNext = false;
        throw new Error("late include failure");
      },
    });
    try {
      await h.app.actions.openFile(entry, ROOT, true);
      const pane = h.app.paneManager.activePane();
      pane.setEditorMode("split");
      flush();
      vi.useFakeTimers();
      const path = `${ROOT}/${MAIN}`;
      const text = pane.editorContent() + "\nsaved edit\n";
      type(h.app, text);
      await vi.advanceTimersByTimeAsync(1300);
      expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
      failNext = true;
      await h.emitFsChange([`${ROOT}/partials/p0.adoc`]); // an include event: converts, fails
      expect(pane.html()).toContain("late include failure");
      await h.emitFsChange([path]); // the echo of the save of the same text
      expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
    } finally {
      await h.close();
    }
  });

  it.each(["rename", "move"] as const)(
    "r6 join: the autosave echo retries a failed edit carried across a %s",
    async (action) => {
      const { h, pane, arm } = await failedEdit();
      try {
        const text = pane.editorContent() + "\nedit before identity change\n";
        const oldHtml = pane.html();
        arm("fail");
        type(h.app, text);
        await vi.advanceTimersByTimeAsync(350);
        expect(pane.html()).toBe(oldHtml);
        const nextPath = action === "rename" ? "after-failure.adoc" : MAIN;
        if (action === "rename") {
          await h.app.folder.handleRename(entry, ROOT, nextPath);
        } else {
          h.app.actions.moveTab(pane.tabs.activeTabId()!, 0);
        }
        flush();
        const target = h.app.paneManager.activePane();
        const absolute = `${ROOT}/${nextPath}`;
        expect(target.selectedFile()?.path).toBe(nextPath);
        expect(h.watched.at(-1)?.[0]).toBe(absolute);
        expect(target.html()).toBe(oldHtml);
        await vi.advanceTimersByTimeAsync(1300);
        expect(target.savedContent()).toBe(text);
        expect(h.disk.get(absolute)).toBe(text);
        await h.emitFsChange([absolute]);
        expect(target.html()).toBe(`<p>${text.length}:20</p>`);
      } finally {
        await h.close();
      }
    },
  );

  it("r6 control: after a rename the edit is recorded under the new identity, so its echo converts nothing", async () => {
    const { h, pane } = await openForEditing();
    try {
      await h.app.folder.handleRename(entry, ROOT, "renamed-ok.adoc");
      flush();
      await vi.advanceTimersByTimeAsync(10);
      // The record of what is on screen follows the rename.
      const shown = pane.editorContent();
      expect(await h.app.state.previewReflects(pane, ROOT, "renamed-ok.adoc", shown)).toBe(true);
      expect(await h.app.state.previewReflects(pane, ROOT, MAIN, shown)).toBe(false);
      const path = `${ROOT}/renamed-ok.adoc`;
      const text = pane.editorContent() + "\nedit after the rename\n";
      h.app.state.debouncedConvert(text, "renamed-ok.adoc", h.app.state._readFile ?? (async () => null));
      flush();
      await vi.advanceTimersByTimeAsync(1300);
      expect(h.disk.get(path)).toBe(text);
      const before = h.counters.conversions;
      await h.emitFsChange([path]);
      expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
      expect(h.counters.conversions).toBe(before);
    } finally {
      await h.close();
    }
  });

  // The watcher follows what the accepted conversion asked the reader for.
  it("r6 regression: an include the edit removed leaves the watched set, direct and nested", async () => {
    const { h, pane, editAndSave } = await openForEditing();
    try {
      await vi.advanceTimersByTimeAsync(10); // the watcher registers asynchronously
      const direct = `${ROOT}/partials/p0.adoc`;
      const nested = `${ROOT}/partials/nested/n0.adoc`;
      expect(h.watched.at(-1)).toEqual(expect.arrayContaining([direct, nested]));
      const text = pane.editorContent().replace("include::partials/p0.adoc[]\n\n", "");
      await editAndSave(text);
      await vi.advanceTimersByTimeAsync(10);
      expect(h.disk.get(`${ROOT}/${MAIN}`)).toBe(text);
      expect(pane.html()).toBe(`<p>${text.length}:18</p>`);
      await h.emitFsChange([`${ROOT}/${MAIN}`]); // the echo of the save
      expect(h.watched.at(-1)).not.toContain(direct);
      expect(h.watched.at(-1)).not.toContain(nested);
      // The rest of the tree is still watched.
      expect(h.watched.at(-1)).toEqual(expect.arrayContaining([
        `${ROOT}/${MAIN}`,
        `${ROOT}/partials/p1.adoc`,
        `${ROOT}/partials/nested/n1.adoc`,
      ]));
      expect(pane.tabs.getActiveTab()?.includePaths).not.toContain("partials/p0.adoc");
    } finally {
      await h.close();
    }
  });

  it("r6 regression: an edit that removes every include leaves only the document watched", async () => {
    const { h, pane } = await openForEditing();
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(h.watched.at(-1)!.length).toBeGreaterThan(1);
      type(h.app, "= Perf\n\nno includes here\n");
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(10);
      expect(pane.html()).toBe(`<p>${"= Perf\n\nno includes here\n".length}:0</p>`);
      expect(h.watched.at(-1)).toEqual([`${ROOT}/${MAIN}`]);
      expect(pane.tabs.getActiveTab()?.includePaths).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it.each(["autosave echo", "manual refresh"] as const)(
    "a pending edit converts with the destination includes after a cross-root move and %s",
    async (refresh) => {
      const { h, pane } = await openForEditing();
      try {
        const dest = "/perf-destination";
        const destPath = `${dest}/${MAIN}`;
        const destInclude = `${dest}/partials/p0.adoc`;
        h.disk.set(destInclude, "destination include");
        expect(await h.app.folder.openFolderPath(dest)).toBe(true);
        const sourceTab = pane.tabs.findTabByFile(MAIN, ROOT)!;
        await h.app.actions.activateTab(pane, sourceTab.id);
        expect(pane.selectedRootId()).toBe(ROOT);
        const text = pane.editorContent() + "\nedit before changing workspace\n";
        type(h.app, text);

        await h.app.folder.handleMove(entry, "", ROOT, dest);
        flush();
        expect(pane.tabs.getActiveTab()).toMatchObject({ rootId: dest, filePath: MAIN });
        await vi.advanceTimersByTimeAsync(1300);
        expect(h.disk.get(destPath)).toBe(text);
        expect(h.watched.at(-1)).toContain(destInclude);
        await h.emitFsChange(refresh === "autosave echo" ? [destPath] : undefined);
        expect(pane.html()).toBe(`<p>${text.length}:1</p>`);
      } finally {
        await h.close();
      }
    },
  );

  it.each(["autosave echo", "manual refresh"] as const)(
    "an accepted edit keeps its nested includes watched across a same-folder rename and %s",
    async (refresh) => {
      const { h, pane } = await openForEditing();
      try {
        const text = pane.editorContent() + "\nedit already rendered\n";
        type(h.app, text);
        await vi.advanceTimersByTimeAsync(310);
        expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
        const nested = `${ROOT}/partials/nested/n0.adoc`;
        expect(h.watched.at(-1)).toContain(nested);
        await h.app.folder.handleRename(entry, ROOT, "renamed-ready.adoc");
        flush();
        await vi.advanceTimersByTimeAsync(1000);
        const path = `${ROOT}/renamed-ready.adoc`;
        expect(h.disk.get(path)).toBe(text);
        await h.emitFsChange(refresh === "autosave echo" ? [path] : undefined);
        expect(h.watched.at(-1)).toContain(nested);
      } finally {
        await h.close();
      }
    },
  );

  it("a rendered edit is converted again with the destination includes after a cross-root move", async () => {
    const { h, pane } = await openForEditing();
    try {
      const dest = "/perf-destination";
      const destPath = `${dest}/${MAIN}`;
      h.disk.set(`${dest}/partials/p0.adoc`, "destination include");
      expect(await h.app.folder.openFolderPath(dest)).toBe(true);
      await h.app.actions.activateTab(pane, pane.tabs.findTabByFile(MAIN, ROOT)!.id);
      const text = pane.editorContent() + "\nedit already rendered\n";
      type(h.app, text);
      await vi.advanceTimersByTimeAsync(310);
      expect(pane.html()).toBe(`<p>${text.length}:20</p>`); // built from the source workspace

      await h.app.folder.handleMove(entry, "", ROOT, dest);
      flush();
      await vi.advanceTimersByTimeAsync(1300);
      expect(h.disk.get(destPath)).toBe(text);
      await h.emitFsChange([destPath]); // the echo of the save in the destination
      expect(pane.html()).toBe(`<p>${text.length}:1</p>`);
    } finally {
      await h.close();
    }
  });

  it("control: a rendered edit is not converted again by the echo after a same-folder rename", async () => {
    const { h, pane } = await openForEditing();
    try {
      const text = pane.editorContent() + "\nedit already rendered\n";
      type(h.app, text);
      await vi.advanceTimersByTimeAsync(310);
      await h.app.folder.handleRename(entry, ROOT, "renamed-ready.adoc");
      flush();
      await vi.advanceTimersByTimeAsync(1000);
      const before = h.counters.conversions;
      await h.emitFsChange([`${ROOT}/renamed-ready.adoc`]);
      expect(h.counters.conversions - before).toBe(0);
      expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
    } finally {
      await h.close();
    }
  });

  it("an older disk read cannot undo a newer confirmed autosave", async () => {
    let block = false;
    let release: (() => void) | undefined;
    const h = await makeApp({
      readDelay: async () => {
        if (!block) return;
        block = false;
        await new Promise<void>((resolve) => { release = resolve; });
      },
    });
    try {
      await h.app.actions.openFile(entry, ROOT, true);
      const pane = h.app.paneManager.activePane();
      pane.setEditorMode("split");
      flush();
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(10);
      const path = `${ROOT}/${MAIN}`;
      h.disk.set(path, "older external edit");
      block = true;
      const olderRefresh = h.emitFsChange([path]);
      await vi.advanceTimersByTimeAsync(10);
      expect(release).toBeTypeOf("function");
      const latest = "newer local edit saved to disk";
      try {
        type(h.app, latest);
        await vi.advanceTimersByTimeAsync(1300);
        expect(h.disk.get(path)).toBe(latest);
        expect(pane.savedContent()).toBe(latest);
        await h.emitFsChange([path]);
      } finally {
        release!();
        await olderRefresh;
      }
      expect(h.disk.get(path)).toBe(latest);
      expect(pane.editorContent()).toBe(latest);
      expect(pane.savedContent()).toBe(latest);
    } finally {
      await h.close();
    }
  });

  it("watches a newly typed include after a file rename", async () => {
    const { h, pane } = await openForEditing();
    try {
      const renamed = "renamed.adoc";
      await h.app.folder.handleRename(entry, ROOT, renamed);
      flush();
      await vi.advanceTimersByTimeAsync(10);
      expect(pane.selectedFile()?.path).toBe(renamed);
      expect(pane.tabs.getActiveTab()?.filePath).toBe(renamed);
      expect(h.watched.at(-1)).toContain(`${ROOT}/${renamed}`);
      h.disk.set(`${ROOT}/added.adoc`, "new leaf");
      const text = pane.editorContent() + "\ninclude::added.adoc[]\n";
      h.app.state.debouncedConvert(text, renamed, async () => null);
      flush();
      await vi.advanceTimersByTimeAsync(1300);
      expect(pane.html()).toBe(`<p>${text.length}:21</p>`);
      await h.emitFsChange([`${ROOT}/${renamed}`]);
      // The target is the file under its new name, with the include that was typed.
      expect(h.watched.at(-1)![0]).toBe(`${ROOT}/${renamed}`);
      expect(h.watched.at(-1)).toContain(`${ROOT}/added.adoc`);
      expect(pane.tabs.getActiveTab()?.includePaths).toContain("added.adoc");
    } finally {
      await h.close();
    }
  });

  it("watches an include that does not exist yet relative to the folder the document moved to", async () => {
    const { h, pane } = await openForEditing();
    try {
      await h.app.folder.handleMove(entry, "sub", ROOT);
      flush();
      await vi.advanceTimersByTimeAsync(10);
      expect(pane.selectedFile()?.path).toBe(`sub/${MAIN}`);
      // Not on disk yet: only the text of the edit names it, resolved from the
      // folder the document is in now, not the one it was loaded from.
      const text = pane.editorContent() + "\ninclude::partials/later.adoc[]\n";
      h.app.state.debouncedConvert(text, `sub/${MAIN}`, async () => null);
      flush();
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(10);
      expect(h.watched.at(-1)![0]).toBe(`${ROOT}/sub/${MAIN}`);
      expect(h.watched.at(-1)).toContain(`${ROOT}/sub/partials/later.adoc`);
      expect(h.watched.at(-1)).not.toContain(`${ROOT}/partials/later.adoc`);
      expect(pane.tabs.getActiveTab()?.includePaths).toContain("sub/partials/later.adoc");
    } finally {
      await h.close();
    }
  });

  it("reselecting a tab whose saved edit finished in the background shows the edit", async () => {
    let block = false;
    let release: (() => void) | undefined;
    const h = await makeApp({
      convertDelay: async () => {
        if (!block) return;
        block = false;
        await new Promise<void>((resolve) => { release = resolve; });
      },
    });
    try {
      const other = { kind: "file", path: "other.adoc", name: "other.adoc" } as const;
      h.addFile(other);
      h.disk.set(`${ROOT}/${other.path}`, "other content");
      await h.app.folder.refreshRoot(ROOT);
      await h.app.actions.openFile(other, ROOT, true);
      await h.app.actions.openFile(entry, ROOT, true);
      const pane = h.app.paneManager.activePane();
      pane.setEditorMode("split");
      flush();
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(10);
      const mainTab = pane.tabs.getActiveTab()!;
      const otherTab = pane.tabs.findTabByFile(other.path, ROOT)!;
      const oldHtml = pane.html();
      const text = pane.editorContent() + "\nnew saved text\n";
      block = true;
      type(h.app, text);
      await vi.advanceTimersByTimeAsync(1100);
      expect(release).toBeTypeOf("function");
      expect(h.disk.get(`${ROOT}/${MAIN}`)).toBe(text);
      expect(pane.savedContent()).toBe(text);
      await h.app.actions.activateTab(pane, otherTab.id);
      await vi.advanceTimersByTimeAsync(10);
      expect(pane.selectedFile()?.path).toBe(other.path);
      release!();
      await vi.advanceTimersByTimeAsync(10);
      expect(pane.html()).toBe("<p>13:0</p>");
      // The conversion that ended in the background does not move the watcher
      // off the document on screen.
      expect(h.watched.at(-1)![0]).toBe(`${ROOT}/${other.path}`);
      await h.app.actions.activateTab(pane, mainTab.id);
      await vi.advanceTimersByTimeAsync(10);
      await h.emitFsChange([`${ROOT}/${MAIN}`]);
      expect(pane.editorContent()).toBe(text);
      expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
      expect(pane.html()).not.toBe(oldHtml);
    } finally {
      await h.close();
    }
  });

  it("a manual save during a watcher read is not undone by the older read", async () => {
    // Autosave is off (preview mode) and the save does not go through the
    // autosave's own-write marks: only the saved text tells that a save landed.
    let block = false;
    let release: (() => void) | undefined;
    const h = await makeApp({
      readDelay: async () => {
        if (!block) return;
        block = false;
        await new Promise<void>((resolve) => { release = resolve; });
      },
    });
    try {
      await h.app.actions.openFile(entry, ROOT, true);
      const pane = h.app.paneManager.activePane();
      flush();
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(10);
      const path = `${ROOT}/${MAIN}`;
      h.disk.set(path, "older external edit");
      block = true;
      const olderRefresh = h.emitFsChange([path]);
      await vi.advanceTimersByTimeAsync(10);
      expect(release).toBeTypeOf("function");
      const latest = "newer local edit saved by hand";
      try {
        type(h.app, latest);
        await h.app.folder.handleEditorSave();
        await vi.advanceTimersByTimeAsync(10);
        expect(h.disk.get(path)).toBe(latest);
        expect(pane.savedContent()).toBe(latest);
      } finally {
        release!();
        await olderRefresh;
      }
      expect(h.disk.get(path)).toBe(latest);
      expect(pane.editorContent()).toBe(latest);
      expect(pane.savedContent()).toBe(latest);
    } finally {
      await h.close();
    }
  });

  it("an older read cannot undo two autosaves that end on the text it started from", async () => {
    // The saved text is the same before and after (A, then B, then A again):
    // only the count of own writes shows that saves happened during the read.
    let block = false;
    let release: (() => void) | undefined;
    const h = await makeApp({
      readDelay: async () => {
        if (!block) return;
        block = false;
        await new Promise<void>((resolve) => { release = resolve; });
      },
    });
    try {
      await h.app.actions.openFile(entry, ROOT, true);
      const pane = h.app.paneManager.activePane();
      pane.setEditorMode("split");
      flush();
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(10);
      const path = `${ROOT}/${MAIN}`;
      const original = pane.savedContent();
      h.disk.set(path, "older external edit");
      block = true;
      const olderRefresh = h.emitFsChange([path]);
      await vi.advanceTimersByTimeAsync(10);
      expect(release).toBeTypeOf("function");
      try {
        type(h.app, "intermediate text");
        await vi.advanceTimersByTimeAsync(1300);
        expect(h.disk.get(path)).toBe("intermediate text");
        type(h.app, original);
        await vi.advanceTimersByTimeAsync(1300);
        expect(h.disk.get(path)).toBe(original);
        expect(pane.savedContent()).toBe(original);
        expect(h.counters.writes).toBe(2);
      } finally {
        release!();
        await olderRefresh;
      }
      expect(h.disk.get(path)).toBe(original);
      expect(pane.editorContent()).toBe(original);
      expect(pane.savedContent()).toBe(original);
    } finally {
      await h.close();
    }
  });

  it("a watcher read with no save in between still adopts the external edit", async () => {
    const h = await makeApp();
    try {
      await h.app.actions.openFile(entry, ROOT, true);
      const pane = h.app.paneManager.activePane();
      pane.setEditorMode("split");
      flush();
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(10);
      const path = `${ROOT}/${MAIN}`;
      h.disk.set(path, "external edit");
      const readsBefore = h.counters.readFile;
      await h.emitFsChange([path]);
      expect(h.counters.readFile).toBe(readsBefore + 1); // read once, no retry
      expect(pane.editorContent()).toBe("external edit");
      expect(pane.savedContent()).toBe("external edit");
    } finally {
      await h.close();
    }
  });

  it("a renamed document keeps its include cache when other documents load afterwards", async () => {
    const h = await makeApp();
    try {
      const other = { kind: "file", path: "other.adoc", name: "other.adoc" } as const;
      h.addFile(other);
      h.disk.set(`${ROOT}/${other.path}`, "other content");
      await h.app.folder.refreshRoot(ROOT);
      await h.app.actions.openFile(entry, ROOT, true);
      flush();
      const pane = h.app.paneManager.activePane();
      pane.setEditorMode("split");
      flush();
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(10);
      const renamed = "renamed.adoc";
      await h.app.folder.handleRename(entry, ROOT, renamed);
      flush();
      await vi.advanceTimersByTimeAsync(10);
      const renamedTab = pane.tabs.getActiveTab()!;
      expect(renamedTab.filePath).toBe(renamed);
      // Loading another document registers its reader and drops the readers of
      // paths no tab shows any more.
      const opened = h.app.actions.openFile(other, ROOT, true);
      await vi.advanceTimersByTimeAsync(10); // the load yields on a (faked) timer
      await opened;
      const back = h.app.actions.activateTab(pane, renamedTab.id);
      await vi.advanceTimersByTimeAsync(10);
      await back;
      expect(pane.selectedFile()?.path).toBe(renamed);
      const batches = h.counters.readFilesRelative;
      const text = pane.editorContent() + "\nmore text\n";
      h.app.state.debouncedConvert(text, renamed, async () => null);
      flush();
      await vi.advanceTimersByTimeAsync(300);
      expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
      expect(h.counters.readFilesRelative).toBe(batches); // every include came from its own cache
    } finally {
      await h.close();
    }
  });

  it("watches a newly typed include after autosave", async () => {
    const { h, pane, editAndSave } = await openForEditing();
    try {
      const newPath = `${ROOT}/new.adoc`;
      await vi.advanceTimersByTimeAsync(10);
      expect(h.watched.at(-1)).toContain(`${ROOT}/${MAIN}`);
      expect(h.watched.at(-1)).not.toContain(newPath);
      h.disk.set(newPath, "new leaf");
      const text = pane.editorContent() + "\ninclude::new.adoc[]\n";
      await editAndSave(text);
      expect(pane.html()).toBe(`<p>${text.length}:21</p>`);
      // The tab snapshot carries the dependencies too: a tab switch re-applies
      // them to the watcher.
      expect(pane.tabs.getActiveTab()?.includePaths).toContain("new.adoc");
      await h.emitFsChange([`${ROOT}/${MAIN}`]);
      expect(h.watched.at(-1)).toContain(newPath);
    } finally {
      await h.close();
    }
  });

  it("an autosave echo preserves an in-flight include refresh", async () => {
    let release: (() => void) | undefined;
    let block = false;
    const h = await makeApp({
      convertDelay: async () => {
        if (block) {
          block = false;
          await new Promise<void>((resolve) => { release = resolve; });
        }
      },
    });
    try {
      await h.app.actions.openFile(entry, ROOT, true);
      const pane = h.app.paneManager.activePane();
      pane.setEditorMode("split");
      flush();
      vi.useFakeTimers();
      const text = pane.editorContent() + "\nupdated\n";
      type(h.app, text);
      await vi.advanceTimersByTimeAsync(1300);
      expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
      expect(h.counters.writes).toBe(1);
      const partial = `${ROOT}/partials/p0.adoc`;
      h.disk.set(partial, "replacement with no nested include");
      block = true;
      const refresh = h.emitFsChange([partial]);
      await vi.advanceTimersByTimeAsync(10);
      expect(release).toBeTypeOf("function");
      try {
        await h.emitFsChange([`${ROOT}/${MAIN}`]);
      } finally {
        release!();
        await refresh;
      }
      flush();
      expect(pane.html()).toBe(`<p>${text.length}:19</p>`);
    } finally {
      await h.close();
    }
  });

  it("editing a loaded tab moved to an empty pane retains its includes", async () => {
    const { h, pane } = await openForEditing();
    try {
      expect(pane.html()).toContain(":20</p>");
      expect(h.app.paneManager.panes()).toHaveLength(1);
      const tab = pane.tabs.getActiveTab()!;
      expect(tab.needsLoad).toBe(false);
      h.app.actions.moveTab(tab.id, 0);
      flush();
      const target = h.app.paneManager.activePane();
      expect(target).not.toBe(pane);
      expect(target.tabs.getActiveTab()?.filePath).toBe(MAIN);
      expect(target.html()).toContain(":20</p>");
      const text = target.editorContent() + "\nedit after moving\n";
      type(h.app, text);
      await vi.advanceTimersByTimeAsync(300);
      expect(target.html()).toBe(`<p>${text.length}:20</p>`);
    } finally {
      await h.close();
    }
  });

  it("keeps the watched paths when an edit leaves the includes as they were", async () => {
    // Control of the newly typed include test: no include change, no new target.
    const { h, pane, editAndSave } = await openForEditing();
    try {
      await vi.advanceTimersByTimeAsync(10);
      const before = h.watched.length;
      const text = pane.editorContent() + "\nplain words\n";
      await editAndSave(text);
      expect(pane.html()).toBe(`<p>${text.length}:20</p>`);
      await h.emitFsChange([`${ROOT}/${MAIN}`]);
      expect(h.watched).toHaveLength(before);
    } finally {
      await h.close();
    }
  });

  it("reads no include and no batch for a document without includes", async () => {
    const h = await makeApp();
    try {
      h.disk.set(`${ROOT}/${MAIN}`, "= Plain\n\nno includes");
      await h.app.actions.openFile(entry, ROOT, true);
      expect(h.counters.readFilesRelative).toBe(0);
      expect(h.counters.readFileRelative).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("a missing nested include takes one batch per layer", async () => {
    const h = await makeApp();
    try {
      h.disk.set(`${ROOT}/${MAIN}`, "include::partials/p0.adoc[]");
      h.disk.delete(`${ROOT}/partials/nested/n0.adoc`);
      await h.app.actions.openFile(entry, ROOT, true);
      expect(h.counters.readFilesRelative).toBe(2);
      expect(h.counters.readFileRelative).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("a missing direct include takes one batch", async () => {
    const h = await makeApp();
    try {
      h.disk.set(`${ROOT}/${MAIN}`, "include::missing.adoc[]");
      await h.app.actions.openFile(entry, ROOT, true);
      expect(h.app.paneManager.activePane().html()).toContain(":0</p>");
      expect(h.counters.readFileRelative).toBe(0);
      expect(h.counters.readFilesRelative).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("echo of our own write: every autosave in a row converts once (the edit), not twice", async () => {
    // Mutation captured: dropping the ownWrites filter (or never marking in the
    // autosave) brings back a second conversion per save.
    const { h, pane, editAndSave } = await openForEditing();
    try {
      const base = h.counters.conversions;
      for (const n of [1, 2, 3]) {
        await editAndSave(`${pane.editorContent()}\nedit ${n}\n`);
        await h.emitFsChange([`${ROOT}/${MAIN}`]);
      }
      expect(h.counters.writes).toBe(3);
      expect(h.counters.conversions - base).toBe(3);
      // 1 load + 3 refreshes read the main file: the events were handled, then skipped
      expect(h.counters.readFile).toBe(4);
      expect(h.counters.readFileRelative).toBe(0);
      // skipped, not failed: a refresh that threw would put an error in the preview
      expect(pane.html()).not.toContain("Error converting file");
      expect(pane.html()).toContain("<p>");
    } finally {
      await h.close();
    }
  });

  it("an event for an include converts again", async () => {
    const { h, editAndSave } = await openForEditing();
    try {
      await editAndSave("= Perf\n\ninclude::partials/p0.adoc[]\n");
      h.disk.set(`${ROOT}/partials/p0.adoc`, "== Part 0 rewritten elsewhere\n");
      const base = h.counters.conversions;
      await h.emitFsChange([`${ROOT}/partials/p0.adoc`]);
      expect(h.counters.conversions - base).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("an event for the main file plus an include converts again", async () => {
    const { h, editAndSave } = await openForEditing();
    try {
      await editAndSave("= Perf\n\ninclude::partials/p0.adoc[]\n");
      const base = h.counters.conversions;
      await h.emitFsChange([`${ROOT}/${MAIN}`, `${ROOT}/partials/p0.adoc`]);
      expect(h.counters.conversions - base).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("an event with no paths converts again", async () => {
    const { h, editAndSave } = await openForEditing();
    try {
      await editAndSave("= Perf\n\nedited\n");
      const base = h.counters.conversions;
      await h.emitFsChange(undefined);
      expect(h.counters.conversions - base).toBe(1);
    } finally {
      await h.close();
    }
  });

  it("another program rewriting the same file is adopted and converted, whatever the event looks like", async () => {
    const { h, pane, editAndSave } = await openForEditing();
    try {
      await editAndSave("= Perf\n\nours\n");
      h.disk.set(`${ROOT}/${MAIN}`, "= Perf\n\ntheirs\n");
      const base = h.counters.conversions;
      await h.emitFsChange([`${ROOT}/${MAIN}`]);
      expect(h.counters.conversions - base).toBe(1);
      expect(pane.editorContent()).toBe("= Perf\n\ntheirs\n");
    } finally {
      await h.close();
    }
  });

  it("with autosave off nothing is marked, so a file event converts", async () => {
    const h = await makeApp();
    try {
      await h.app.actions.openFile(entry, ROOT, true);
      flush();
      expect(h.app.paneManager.activePane().editorMode()).toBe("preview"); // autosave stays idle
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(10); // the watcher finishes registering its listener
      const base = h.counters.conversions;
      await h.emitFsChange([`${ROOT}/${MAIN}`]);
      expect(h.counters.conversions - base).toBe(1);
      expect(h.counters.writes).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("measures include reads on load and conversions per edit with autosave on", async () => {
    const h = await makeApp();
    try {
      await h.app.actions.openFile(entry, ROOT, true);
      flush();
      const load = { ...h.counters };
      report("load", load);
      const ipcOnLoad = load.readFile + load.readFileRelative + load.readFilesRelative;

      h.app.paneManager.activePane().setEditorMode("split"); // autosave only runs while editing
      flush();
      vi.useFakeTimers();
      const before = h.counters.conversions;
      type(h.app, h.app.paneManager.activePane().editorContent() + "\nmore text\n");
      await vi.advanceTimersByTimeAsync(300); // debounced preview conversion
      await vi.advanceTimersByTimeAsync(1000); // autosave writes
      expect(h.counters.writes).toBe(1);
      await h.emitFsChange([`${ROOT}/${MAIN}`]); // Rust: the watcher saw our own write
      await vi.advanceTimersByTimeAsync(500);
      const perEdit = h.counters.conversions - before;
      report("edit-with-autosave", { conversionsPerEdit: perEdit, readsDuringEdit: h.counters.readFileRelative + h.counters.readFilesRelative - load.readFileRelative - load.readFilesRelative });

      // 1 main read + 1 batch of the direct includes + the nested ones
      expect(ipcOnLoad).toBe(3);
      expect(load.readFileRelative).toBe(0);
      expect(load.readFilesRelative).toBe(2);
      expect(perEdit).toBe(1);
    } finally {
      await h.close();
    }
  });
});

type PaneStore0 = ReturnType<typeof createPaneStore>;

describe("overlapping edit conversions", () => {
  const entry = (path: string): FSEntry => ({ kind: "file", path, name: path.split("/").pop()! });

  interface Gate {
    text: string;
    filePath: string;
    readFile: (p: string) => Promise<string | null>;
    readFiles?: (p: string[]) => Promise<Map<string, string | null>>;
    resolve: (html: string) => void;
  }

  /** A converter whose every call stays open until the test resolves it. */
  function gatedConverter() {
    const gates: Gate[] = [];
    let running = 0;
    let maxRunning = 0;
    const convertAdoc = vi.fn((opts: { fileContent: string; filePath: string; readFile: (p: string) => Promise<string | null>; readFiles?: Gate["readFiles"] }) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      return new Promise<{ html: string; frontmatter: null }>((resolve) => {
        gates.push({
          text: opts.fileContent,
          filePath: opts.filePath,
          readFile: opts.readFile,
          readFiles: opts.readFiles,
          resolve: (html) => { running--; resolve({ html, frontmatter: null }); },
        });
      });
    });
    return { convertAdoc, gates, maxRunning: () => maxRunning };
  }

  async function settle() {
    await vi.advanceTimersByTimeAsync(0);
    flush();
  }

  afterEach(() => { vi.useRealTimers(); });

  function open(pane: ReturnType<typeof createPaneManager>["panes"] extends () => infer P ? P extends Array<infer Q> ? Q : never : never, path: string) {
    pane.setSelectedRootId("root");
    pane.setSelectedFile(entry(path));
    pane.tabs.loadInActiveTab(entry(path), "root");
    flush();
  }

  it("keeps one conversion running and one pending; only the newest generation publishes", async () => {
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    await withState(
      async (state) => {
        open(pane, "doc.adoc");
        vi.useFakeTimers();
        const read = async () => null;
        state.debouncedConvert("v1", "doc.adoc", read);
        await vi.advanceTimersByTimeAsync(300);
        expect(conv.gates.map((g) => g.text)).toEqual(["v1"]);
        state.debouncedConvert("v2", "doc.adoc", read);
        await vi.advanceTimersByTimeAsync(300);
        state.debouncedConvert("v3", "doc.adoc", read);
        await vi.advanceTimersByTimeAsync(300);
        // v1 is still running; v2 was replaced by v3 before it ever started
        expect(conv.gates.map((g) => g.text)).toEqual(["v1"]);

        conv.gates[0]!.resolve("<p>html v1</p>");
        await settle();
        expect(pane.html()).toBe(""); // v1 is not the newest generation: dropped
        expect(conv.gates.map((g) => g.text)).toEqual(["v1", "v3"]);

        conv.gates[1]!.resolve("<p>html v3</p>");
        await settle();
        expect(pane.html()).toBe("<p>html v3</p>");
        expect(conv.maxRunning()).toBe(1);
        expect(conv.convertAdoc).toHaveBeenCalledTimes(2);
      },
      { paneManager, convertAdoc: conv.convertAdoc as never },
    );
  });

  it("a stale job is not started inside the newest debounce window", async () => {
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    await withState(async (state) => {
      open(pane, "doc.adoc");
      vi.useFakeTimers();
      const read = async () => null;
      state.debouncedConvert("v1", "doc.adoc", read);
      await vi.advanceTimersByTimeAsync(300);
      state.debouncedConvert("v2", "doc.adoc", read);
      await vi.advanceTimersByTimeAsync(300);
      state.debouncedConvert("v3", "doc.adoc", read);
      conv.gates[0]!.resolve("<p>html v1</p>");
      await settle();
      const beforeDebounce = conv.gates.map((g) => g.text);
      for (const gate of conv.gates.slice(1)) gate.resolve("old");
      await vi.advanceTimersByTimeAsync(300);
      conv.gates.at(-1)!.resolve("new");
      await settle();
      expect(pane.html()).toBe("new");
      expect(beforeDebounce).toEqual(["v1"]);
    }, { paneManager, convertAdoc: conv.convertAdoc as never });
  });

  it("a failed conversion releases the next one", async () => {
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    let fail: (cause: Error) => void;
    const convertAdoc = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockResolvedValueOnce({ html: "recovered", frontmatter: null });
    await withState(async (state) => {
      open(pane, "doc.adoc");
      vi.useFakeTimers();
      state.debouncedConvert("v1", "doc.adoc", async () => null);
      await vi.advanceTimersByTimeAsync(300);
      state.debouncedConvert("v2", "doc.adoc", async () => null);
      await vi.advanceTimersByTimeAsync(300);
      fail!(new Error("controlled conversion failure"));
      await settle();
      expect(pane.html()).toBe("recovered");
    }, { paneManager, convertAdoc });
  });

  it("measures stale publishes when conversions finish out of order", async () => {
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    const published: string[] = [];
    await withState(
      async (state) => {
        open(pane, "doc.adoc");
        vi.useFakeTimers();
        const read = async () => null;
        for (const text of ["v1", "v2", "v3"]) {
          state.debouncedConvert(text, "doc.adoc", read);
          await vi.advanceTimersByTimeAsync(300);
        }
        // Resolve whatever is running, newest first, until nothing is left.
        for (let guard = 0; guard < 10; guard++) {
          const open = conv.gates.filter((g) => !(g as Gate & { done?: boolean }).done);
          const gate = open[open.length - 1];
          if (!gate) break;
          (gate as Gate & { done?: boolean }).done = true;
          gate.resolve(`<p>html ${gate.text}</p>`);
          await settle();
          published.push(pane.html());
        }
        perfLine("out-of-order", { started: conv.gates.map((g) => g.text), published, maxRunning: conv.maxRunning() });
        expect(pane.html()).toBe("<p>html v3</p>");
      },
      { paneManager, convertAdoc: conv.convertAdoc as never },
    );
  });

  it("an older generation with the same text is still dropped (it ran with an older reader)", async () => {
    // The buffer check alone would let it through: A, B, back to A. Only the
    // generation tells the first A (older include cache) from the newest.
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    await withState(
      async (state) => {
        open(pane, "doc.adoc");
        vi.useFakeTimers();
        const read = async () => null;
        state.debouncedConvert("A", "doc.adoc", read);
        await vi.advanceTimersByTimeAsync(300);
        state.debouncedConvert("B", "doc.adoc", read);
        state.debouncedConvert("A", "doc.adoc", read); // undo: same text, newer generation
        await vi.advanceTimersByTimeAsync(300);
        expect(conv.gates.map((g) => g.text)).toEqual(["A"]);
        conv.gates[0]!.resolve("<p>old A</p>");
        await settle();
        expect(pane.html()).toBe(""); // not published: a newer generation exists
        expect(conv.gates.map((g) => g.text)).toEqual(["A", "A"]);
        conv.gates[1]!.resolve("<p>new A</p>");
        await settle();
        expect(pane.html()).toBe("<p>new A</p>");
      },
      { paneManager, convertAdoc: conv.convertAdoc as never },
    );
  });

  it("two files in one pane each convert with their own reader", async () => {
    // Mutation captured: serving the last registered reader of the pane sends
    // a.adoc's edits through b.adoc's root and cache.
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    await withState(
      async (state) => {
        open(pane, "a.adoc");
        pane.tabs.openTab(entry("b.adoc"), "root", { background: true });
        flush();
        const readA = async () => "a";
        const readB = async () => "b";
        state.registerReader(pane, "root", "a.adoc", { readFile: readA });
        state.registerReader(pane, "root", "b.adoc", { readFile: readB }); // loaded last
        vi.useFakeTimers();
        state.debouncedConvert("edit a", "a.adoc", async () => "fallback");
        await vi.advanceTimersByTimeAsync(300);
        expect(await conv.gates[0]!.readFile("probe")).toBe("a"); // the reader of a.adoc, not b.adoc's
      },
      { paneManager, convertAdoc: conv.convertAdoc as never },
    );
  });

  it("drops the result when the pane moved to another file meanwhile", async () => {
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    await withState(
      async (state) => {
        open(pane, "a.adoc");
        vi.useFakeTimers();
        state.debouncedConvert("text of a", "a.adoc", async () => null);
        await vi.advanceTimersByTimeAsync(300);
        expect(conv.gates).toHaveLength(1);
        pane.setSelectedFile(entry("b.adoc")); // the user opened another file
        pane.setHtml("<p>b</p>");
        conv.gates[0]!.resolve("<p>html of a</p>");
        await settle();
        expect(pane.html()).toBe("<p>b</p>");
      },
      { paneManager, convertAdoc: conv.convertAdoc as never },
    );
  });

  it("drops the result when another tab of the pane became active", async () => {
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    await withState(
      async (state) => {
        open(pane, "a.adoc");
        vi.useFakeTimers();
        state.debouncedConvert("text of a", "a.adoc", async () => null);
        await vi.advanceTimersByTimeAsync(300);
        const other = pane.tabs.openTab(entry("a.adoc"), "elsewhere"); // same path, other root: another tab
        flush();
        expect(pane.tabs.activeTabId()).toBe(other);
        pane.setHtml("<p>other tab</p>");
        conv.gates[0]!.resolve("<p>html of the first tab</p>");
        await settle();
        expect(pane.html()).toBe("<p>other tab</p>");
      },
      { paneManager, convertAdoc: conv.convertAdoc as never },
    );
  });

  it("never publishes over a buffer a reload replaced while converting", async () => {
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    await withState(
      async (state) => {
        open(pane, "a.adoc");
        vi.useFakeTimers();
        state.debouncedConvert("typed", "a.adoc", async () => null);
        await vi.advanceTimersByTimeAsync(300);
        pane.setEditorContent("text from disk"); // a reload adopted the disk text
        pane.setHtml("<p>from disk</p>");
        conv.gates[0]!.resolve("<p>html of typed</p>");
        await settle();
        expect(pane.html()).toBe("<p>from disk</p>");
      },
      { paneManager, convertAdoc: conv.convertAdoc as never },
    );
  });

  it("skips a waiting conversion whose tab closed, and a running one publishes nothing", async () => {
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    await withState(
      async (state) => {
        open(pane, "a.adoc");
        vi.useFakeTimers();
        state.debouncedConvert("v1", "a.adoc", async () => null);
        await vi.advanceTimersByTimeAsync(300);
        state.debouncedConvert("v2", "a.adoc", async () => null);
        await vi.advanceTimersByTimeAsync(300); // v2 waits behind v1
        pane.tabs.closeTab(pane.tabs.activeTabId()!);
        pane.setSelectedFile(null);
        flush();
        conv.gates[0]!.resolve("<p>html v1</p>");
        await settle();
        expect(pane.html()).toBe("");
        expect(conv.convertAdoc).toHaveBeenCalledTimes(1); // v2 never started
      },
      { paneManager, convertAdoc: conv.convertAdoc as never },
    );
  });

  it("two panes with the same file convert independently: an edit in one does not cancel the other", async () => {
    // Mutation captured: one shared timer/generation for all panes (the old
    // single `editorConvertTimer`) cancels pane 0's pending conversion here.
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    paneManager.splitFromActive();
    flush();
    const [pane0, pane1] = paneManager.panes() as [PaneStore0, PaneStore0];
    await withState(
      async (state) => {
        open(pane0, "doc.adoc");
        open(pane1, "doc.adoc");
        vi.useFakeTimers();
        paneManager.setActivePane(0);
        flush();
        state.debouncedConvert("pane0 text", "doc.adoc", async () => null);
        paneManager.setActivePane(1);
        flush();
        state.debouncedConvert("pane1 text", "doc.adoc", async () => null);
        await vi.advanceTimersByTimeAsync(300);
        expect(conv.gates.map((g) => g.text).sort()).toEqual(["pane0 text", "pane1 text"]);
        for (const g of conv.gates) g.resolve(`<p>${g.text}</p>`);
        await settle();
        expect(pane0.html()).toBe("<p>pane0 text</p>");
        expect(pane1.html()).toBe("<p>pane1 text</p>");
      },
      { paneManager, convertAdoc: conv.convertAdoc as never },
    );
  });

  it("a result for the pane that was active at the time lands there, not in the pane active at the end", async () => {
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    paneManager.splitFromActive();
    flush();
    const [pane0, pane1] = paneManager.panes() as [PaneStore0, PaneStore0];
    await withState(
      async (state) => {
        open(pane0, "doc.adoc");
        open(pane1, "other.adoc");
        vi.useFakeTimers();
        paneManager.setActivePane(0);
        flush();
        state.debouncedConvert("pane0 text", "doc.adoc", async () => null);
        await vi.advanceTimersByTimeAsync(300);
        paneManager.setActivePane(1); // the user clicked the other pane mid-conversion
        flush();
        conv.gates[0]!.resolve("<p>pane0 html</p>");
        await settle();
        expect(pane0.html()).toBe("<p>pane0 html</p>");
        expect(pane1.html()).toBe("");
      },
      { paneManager, convertAdoc: conv.convertAdoc as never },
    );
  });

  it("converts with the reader registered for that pane and file, not the last one registered", async () => {
    // Mutation captured: looking the reader up by "last registered" (the old
    // global `_readFile`) hands pane 0's edits pane 1's reader.
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    paneManager.splitFromActive();
    flush();
    const [pane0, pane1] = paneManager.panes() as [PaneStore0, PaneStore0];
    await withState(
      async (state) => {
        open(pane0, "doc.adoc");
        open(pane1, "doc.adoc");
        const read0 = async () => "root 0";
        const read1 = async () => "root 1";
        state.registerReader(pane0, "root", "doc.adoc", { readFile: read0 });
        state.registerReader(pane1, "root", "doc.adoc", { readFile: read1 }); // loaded last
        vi.useFakeTimers();
        paneManager.setActivePane(0);
        flush();
        state.debouncedConvert("edit in pane 0", "doc.adoc", async () => "fallback");
        await vi.advanceTimersByTimeAsync(300);
        paneManager.setActivePane(1);
        flush();
        state.debouncedConvert("edit in pane 1", "doc.adoc", async () => "fallback");
        await vi.advanceTimersByTimeAsync(300);
        expect(conv.gates).toHaveLength(2);
        expect(await conv.gates[0]!.readFile("probe")).toBe("root 0");
        expect(await conv.gates[1]!.readFile("probe")).toBe("root 1");
      },
      { paneManager, convertAdoc: conv.convertAdoc as never },
    );
  });

  it("uses the caller's reader when the document registered none, and the same-root reader after a rename", async () => {
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    await withState(
      async (state) => {
        open(pane, "doc.adoc");
        vi.useFakeTimers();
        const fallback = async () => "fallback";
        state.debouncedConvert("no reader registered", "doc.adoc", fallback);
        await vi.advanceTimersByTimeAsync(300);
        expect(await conv.gates[0]!.readFile("probe")).toBe("fallback");
        conv.gates[0]!.resolve("<p>1</p>");
        await settle();

        const registered = async () => "registered";
        state.registerReader(pane, "root", "old-name.adoc", { readFile: registered });
        state.debouncedConvert("after rename", "doc.adoc", fallback); // tab now shows doc.adoc
        await vi.advanceTimersByTimeAsync(300);
        expect(await conv.gates[1]!.readFile("probe")).toBe("registered");
      },
      { paneManager, convertAdoc: conv.convertAdoc as never },
    );
  });

  it("hands the reader's owner the paths the accepted conversion asked for, and only those", async () => {
    // Each of the two ways of reading (one file, one layer) is a mechanism of
    // its own; a path the conversion asked for and found missing counts too;
    // what an older conversion read stays in the reader's cache but not here.
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    await withState(
      async (state) => {
        open(pane, "a.adoc");
        const converted = vi.fn();
        state.registerReader(pane, "root", "a.adoc", {
          readFile: async (path) => (path === "gone.adoc" ? null : "text"),
          readFiles: async (paths) => new Map(paths.map((path) => [path, "text"] as const)),
          converted,
        });
        vi.useFakeTimers();
        state.debouncedConvert("first", "a.adoc", async () => null);
        await vi.advanceTimersByTimeAsync(300);
        await conv.gates[0]!.readFile("one.adoc");
        await conv.gates[0]!.readFile("gone.adoc"); // missing: still a dependency
        await conv.gates[0]!.readFiles!(["layer-a.adoc", "layer-b.adoc"]);
        conv.gates[0]!.resolve("<p>1</p>");
        await settle();
        expect(converted).toHaveBeenCalledTimes(1);
        expect(Array.from(converted.mock.calls[0]![3] as ReadonlySet<string>).sort())
          .toEqual(["gone.adoc", "layer-a.adoc", "layer-b.adoc", "one.adoc"]);

        state.debouncedConvert("second", "a.adoc", async () => null);
        await vi.advanceTimersByTimeAsync(300);
        await conv.gates[1]!.readFile("one.adoc");
        conv.gates[1]!.resolve("<p>2</p>");
        await settle();
        expect(converted).toHaveBeenCalledTimes(2);
        expect(Array.from(converted.mock.calls[1]![3] as ReadonlySet<string>)).toEqual(["one.adoc"]);
      },
      { paneManager, convertAdoc: conv.convertAdoc as never },
    );
  });

  it("forgets the readers of tabs that closed", async () => {
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    await withState(
      async (state) => {
        open(pane, "a.adoc");
        const readA = async () => "a";
        state.registerReader(pane, "root", "a.adoc", { readFile: readA });
        pane.tabs.closeTab(pane.tabs.activeTabId()!);
        flush();
        open(pane, "b.adoc");
        state.registerReader(pane, "root", "b.adoc", { readFile: async () => "b" }); // prunes a's
        pane.tabs.loadInActiveTab(entry("a.adoc"), "root");
        pane.setSelectedFile(entry("a.adoc"));
        flush();
        vi.useFakeTimers();
        const fallback = async () => "fallback";
        state.debouncedConvert("a again", "a.adoc", fallback);
        await vi.advanceTimersByTimeAsync(300);
        // a's own reader is gone; the same-root one (b's) serves, never a's closed cache
        expect(await conv.gates[0]!.readFile("probe")).toBe("b");
      },
      { paneManager, convertAdoc: conv.convertAdoc as never },
    );
  });
  it("rewriting a folder's paths moves the readers of its tabs along", async () => {
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    await withState(
      async (state) => {
        open(pane, "docs/a.adoc");
        pane.tabs.pinTab(pane.tabs.activeTabId()!);
        const readA = async () => "a";
        state.registerReader(pane, "root", "docs/a.adoc", { readFile: readA });
        state.rewriteTabPaths("root", "docs", "manual");
        flush();
        pane.tabs.openTab(entry("other.adoc"), "root");
        pane.setSelectedFile(entry("other.adoc"));
        // Registering the other reader drops those no tab shows.
        state.registerReader(pane, "root", "other.adoc", { readFile: async () => "o" });
        pane.tabs.activateTab(pane.tabs.findTabByFile("manual/a.adoc", "root")!.id);
        pane.setSelectedFile(entry("manual/a.adoc"));
        flush();
        vi.useFakeTimers();
        state.debouncedConvert("a edit", "manual/a.adoc", async () => "fallback");
        await vi.advanceTimersByTimeAsync(300);
        expect(await conv.gates[0]!.readFile("probe")).toBe("a");
      },
      { paneManager, convertAdoc: conv.convertAdoc as never },
    );
  });

  /** A pane with a loaded, pinned tab `a.adoc` whose reader records `converted`. */
  function withBackgroundDoc(
    run: (ctx: {
      state: State;
      pane: ReturnType<typeof createPaneManager>["panes"] extends () => infer P ? P extends Array<infer Q> ? Q : never : never;
      conv: ReturnType<typeof gatedConverter>;
      aId: string;
      converted: { content: string; doc: unknown }[];
      switchAway: () => void;
    }) => Promise<void>,
  ) {
    const conv = gatedConverter();
    const paneManager = createPaneManager();
    const pane = paneManager.activePane();
    return withState(
      async (state) => {
        open(pane, "a.adoc");
        const aId = pane.tabs.activeTabId()!;
        pane.tabs.pinTab(aId);
        const converted: { content: string; doc: unknown }[] = [];
        state.registerReader(pane, "root", "a.adoc", {
          readFile: async () => null,
          converted: (_pane, content, doc) => { converted.push({ content, doc }); },
        });
        vi.useFakeTimers();
        const switchAway = () => {
          pane.tabs.openTab(entry("b.adoc"), "root");
          pane.setSelectedFile(entry("b.adoc"));
          pane.setHtml("<p>b</p>");
          flush();
        };
        await run({ state, pane, conv, aId, converted, switchAway });
      },
      { paneManager, convertAdoc: conv.convertAdoc as never },
    );
  }

  it("a conversion that ends after a tab switch updates the snapshot of its own tab", async () => {
    await withBackgroundDoc(async ({ state, pane, conv, aId, converted, switchAway }) => {
      state.debouncedConvert("a edited", "a.adoc", async () => null);
      await vi.advanceTimersByTimeAsync(300);
      expect(conv.gates).toHaveLength(1);
      switchAway();
      conv.gates[0]!.resolve("<p>a new</p>");
      await settle();
      const tab = pane.tabs.getTab(aId)!;
      expect(tab.editorContent).toBe("a edited");
      expect(tab.html).toBe("<p>a new</p>"); // text and html agree
      expect(pane.html()).toBe("<p>b</p>"); // the tab on screen is untouched
      expect(converted).toEqual([{ content: "a edited", doc: { filePath: "a.adoc", rootId: "root", tabId: aId } }]);
    });
  });

  it("an edit followed by a tab switch inside the debounce window still converts that tab", async () => {
    await withBackgroundDoc(async ({ state, pane, conv, aId, switchAway }) => {
      state.debouncedConvert("a edited", "a.adoc", async () => null);
      switchAway(); // before the 300 ms timer fires
      await vi.advanceTimersByTimeAsync(300);
      expect(conv.gates).toHaveLength(1);
      expect(conv.gates[0]!.text).toBe("a edited");
      conv.gates[0]!.resolve("<p>a new</p>");
      await settle();
      expect(pane.tabs.getTab(aId)!.html).toBe("<p>a new</p>");
    });
  });

  it("a background result is dropped when the snapshot holds other text", async () => {
    await withBackgroundDoc(async ({ state, pane, conv, aId, converted, switchAway }) => {
      state.debouncedConvert("a edited", "a.adoc", async () => null);
      await vi.advanceTimersByTimeAsync(300);
      switchAway();
      pane.tabs.updateTabContent(aId, { editorContent: "changed elsewhere", html: "<p>kept</p>" });
      conv.gates[0]!.resolve("<p>a new</p>");
      await settle();
      expect(pane.tabs.getTab(aId)!.html).toBe("<p>kept</p>");
      expect(converted).toEqual([]);
    });
  });

  it("a background result of an older edit is dropped when a newer edit started", async () => {
    await withBackgroundDoc(async ({ state, pane, conv, aId, converted, switchAway }) => {
      // The same text twice: only the generation tells the old result apart.
      state.debouncedConvert("same text", "a.adoc", async () => null);
      await vi.advanceTimersByTimeAsync(300);
      state.debouncedConvert("same text", "a.adoc", async () => null); // newer generation
      switchAway();
      conv.gates[0]!.resolve("<p>first</p>");
      await settle();
      expect(pane.tabs.getTab(aId)!.html).not.toBe("<p>first</p>");
      expect(converted).toEqual([]);
    });
  });

  it("a conversion whose tab closed in the meantime publishes nothing and does not fail", async () => {
    await withBackgroundDoc(async ({ state, pane, conv, aId, converted, switchAway }) => {
      state.debouncedConvert("a edited", "a.adoc", async () => null);
      await vi.advanceTimersByTimeAsync(300);
      switchAway();
      pane.tabs.closeTab(aId);
      flush();
      conv.gates[0]!.resolve("<p>a new</p>");
      await settle();
      expect(pane.tabs.getTab(aId)).toBeUndefined();
      expect(pane.html()).toBe("<p>b</p>");
      expect(converted).toEqual([]);
    });
  });
});

describe("AppState — exportação PDF com diagramas pendentes", () => {
  it("espera o flush do preview antes de chamar printPage", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const unregister = registerMermaidFlush(async () => {
      order.push("flush-start");
      await gate;
      order.push("flush-end");
    });
    try {
      const pending = withState((state) => state.handleExportPdf(), {
        printPage: () => { order.push("print"); },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(order).toEqual(["flush-start"]);
      release();
      await pending;
      expect(order).toEqual(["flush-start", "flush-end", "print"]);
    } finally {
      unregister();
    }
  });

  it("drena os diagramas com o tema vigente e só remove dark para imprimir", async () => {
    const seen: string[] = [];
    document.documentElement.classList.add("dark");
    const unregister = registerMermaidFlush(async () => {
      seen.push(document.documentElement.classList.contains("dark") ? "dark" : "light");
    });
    try {
      await withState((state) => state.handleExportPdf(), {
        printPage: () => {
          seen.push(document.documentElement.classList.contains("dark") ? "dark" : "light");
        },
      });
      expect(seen).toEqual(["dark", "light"]);
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    } finally {
      unregister();
      document.documentElement.classList.remove("dark");
    }
  });
});

describe("AppState — tray icon preference", () => {
  it("defaults to on and persists both values through the handler", () => {
    // Mutation captured: a handler that only flips the signal would
    // forget the choice on the next launch; a hardcoded default would
    // remove the tray from existing installs on upgrade.
    withState((state) => {
      expect(state.showTrayIcon()).toBe(true);
      expect(localStorage.getItem("markdraw-window-tray-icon")).toBeNull();

      state.handleShowTrayIconChange(false);
      expect(state.showTrayIcon()).toBe(false);
      expect(localStorage.getItem("markdraw-window-tray-icon")).toBe("false");

      state.handleShowTrayIconChange(true);
      expect(state.showTrayIcon()).toBe(true);
      expect(localStorage.getItem("markdraw-window-tray-icon")).toBe("true");
    });
  });

  it("hydrates the signal from the stored preference", () => {
    localStorage.setItem("markdraw-window-tray-icon", "false");
    withState((state) => {
      expect(state.showTrayIcon()).toBe(false);
    });
  });
});
