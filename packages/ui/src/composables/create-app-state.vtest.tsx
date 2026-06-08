import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import type { FSEntry } from "@asciimark/core/types.ts";
import { UNSUPPORTED_CONTENT } from "@asciimark/core/utils.ts";
import { createAppState, type ThemeMode } from "./create-app-state.ts";

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
  return createRoot(() => fn(createAppState(deps), deps));
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
    localStorage.setItem("asciimark-editor-wrap-text", "true");
    localStorage.setItem("asciimark-editor-show-line-numbers", "true");
    localStorage.setItem("asciimark-editor-show-invisibles", "true");
    localStorage.setItem("asciimark-editor-sync-scroll", "true");
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
      expect(localStorage.getItem("asciimark-editor-wrap-text")).toBe("true");
      expect(localStorage.getItem("asciimark-editor-show-line-numbers")).toBe("true");
      expect(localStorage.getItem("asciimark-editor-show-invisibles")).toBe("true");
      expect(localStorage.getItem("asciimark-editor-sync-scroll")).toBe("true");
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

  it("starts on the TOC tab with no chats", () => {
    withState((state) => {
      expect(state.aiActiveTab()).toBe("toc");
      expect(state.aiSessions.sessions()).toEqual([]);
    }, aiConfig);
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

  it("ignores a blank/whitespace selection", () => {
    withState((state) => {
      state.addSelectionToContext({ from: 0, to: 3, text: "   " });
      expect(state.aiContextItems()).toHaveLength(0);
    }, aiConfig);
  });

  it("follows the manager back to TOC when the active chat is closed", () => {
    // closeChat reconciles the encoded tab synchronously: closing the active
    // (and only) chat drops it from sessions() → fall back to TOC.
    withState((state) => {
      const id = state.newChat();
      expect(state.aiActiveTab()).toBe(`chat:${id}`);
      state.closeChat(id);
      expect(state.aiActiveTab()).toBe("toc");
    }, aiConfig);
  });
});
