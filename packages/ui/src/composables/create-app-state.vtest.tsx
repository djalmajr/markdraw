import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import type { FSEntry } from "@markdraw/core/types.ts";
import { UNSUPPORTED_CONTENT } from "@markdraw/core/utils.ts";
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

  it("addSelectionToContext emits aiInlineReference with the chip label, bumping seq", () => {
    withState((state) => {
      expect(state.aiInlineReference()).toBeNull();
      state.addSelectionToContext({ from: 0, to: 5, text: "hello" });
      const first = state.aiContextItems()[0]!;
      expect(state.aiInlineReference()).toEqual({
        itemId: first.id,
        seq: 1,
        token: first.label,
      });
      // A second selection retriggers with a HIGHER seq (the panel keys its
      // insertion effect on it).
      state.addSelectionToContext({ from: 6, to: 8, text: "wo" });
      const second = state.aiContextItems()[1]!;
      expect(state.aiInlineReference()).toEqual({
        itemId: second.id,
        seq: 2,
        token: second.label,
      });
    }, aiConfig);
  });

  it("ignores a blank/whitespace selection", () => {
    withState((state) => {
      state.addSelectionToContext({ from: 0, to: 3, text: "   " });
      expect(state.aiContextItems()).toHaveLength(0);
      expect(state.aiInlineReference()).toBeNull();
    }, aiConfig);
  });

  it("addPreviewSelectionToContext labels the chip '<file>:sel' with -2/-3 dedupe", () => {
    withState((state) => {
      const text = "This is a long preview selection that needs truncating";
      state.addPreviewSelectionToContext(text);
      const items = state.aiContextItems();
      expect(items).toHaveLength(1);
      expect(items[0]!.kind).toBe("selection");
      // The selected text rides `content` untouched; the label is the short
      // token-friendly form ("preview" — no active file in this stub).
      expect(items[0]!.content).toBe(text);
      expect(items[0]!.label).toBe("preview:sel");
      expect(state.aiInlineReference()).toEqual({
        itemId: items[0]!.id,
        seq: 1,
        token: "preview:sel",
      });
      // A second, different selection dedupes against the existing label.
      state.addPreviewSelectionToContext("another bit");
      expect(state.aiContextItems()[1]!.label).toBe("preview:sel-2");
      expect(state.aiInlineReference()?.token).toBe("preview:sel-2");
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
      expect(sent?.at(-1)?.content).toContain('<context kind="folder" source="src/">');
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
  const RP_KEY = "asciimark-right-panel-tabs";

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
    const calls: Array<{ system?: string; tools?: unknown[] }> = [];
    const provider = {
      // eslint-disable-next-line require-yield
      async *chat(
        _messages: { role: string; content: string }[],
        opts?: { system?: string; tools?: unknown[] },
      ) {
        calls.push({ system: opts?.system, tools: opts?.tools });
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

  const fakeTools = [{ name: "edit", description: "d" }] as never;

  it("defaults to build mode", () => {
    withState((state) => {
      expect(state.aiMode()).toBe("build");
    });
  });

  it("setAiMode switches and persists to localStorage", () => {
    withState((state) => {
      state.setAiMode("plan");
      expect(state.aiMode()).toBe("plan");
      expect(localStorage.getItem("asciimark-ai-mode")).toBe("plan");
      state.setAiMode("build");
      expect(localStorage.getItem("asciimark-ai-mode")).toBe("build");
    });
  });

  it("build mode: forwards tools, no plan prompt, onPlanComplete not called", async () => {
    const { calls, provider } = captureProvider();
    const onPlanComplete = vi.fn();
    await withState(
      async (state) => {
        const id = state.newChat();
        await state.aiSessions.storeFor(id)!.sendMessage("hi");
        expect(calls.at(-1)?.system).toBeUndefined();
        expect(calls.at(-1)?.tools).toEqual(fakeTools);
        expect(onPlanComplete).not.toHaveBeenCalled();
      },
      {
        createAIProvider: () => provider,
        getAITools: () => fakeTools,
        onPlanComplete,
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
