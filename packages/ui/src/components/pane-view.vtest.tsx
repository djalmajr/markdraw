import { afterEach, describe, expect, it, vi } from "vitest";
import { createComponent, createRoot, createSignal, flush, untrack } from "solid-js";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import type { FSEntry } from "@markdraw/core/types.ts";
import { UNSUPPORTED_CONTENT } from "@markdraw/core/utils.ts";
import type { AppState } from "../composables/create-app-state.ts";
import type { PaneStore } from "../composables/create-pane-store.ts";
import { createAppState } from "../composables/create-app-state.ts";
import { createTabActions } from "../../../../apps/desktop/src/lib/tab-actions.ts";
import { createNavigation } from "../../../../apps/desktop/src/lib/navigation.ts";

// PaneView's children all bring their own heavy dependencies
// (CodeMirror, markdown-it, dnd-kit). For a structural test of the
// resize-handle's parent-ref contract we don't need any of them —
// stub them with empty divs so the render finishes synchronously
// and the resize-handle's ancestor chain is what we actually probe.
vi.mock("./editor.tsx", () => ({ Editor: () => <div data-testid="editor-stub" /> }));
const previewCtl = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));
vi.mock("./preview.tsx", () => ({
  Preview: (props: Record<string, unknown>) => {
    previewCtl.props = props;
    return <div data-testid="preview-stub" />;
  },
}));

const disposers: Array<() => void> = [];
afterEach(async () => {
  cleanup();
  const hadAppState = disposers.length > 0;
  for (const dispose of disposers.splice(0)) dispose();
  previewCtl.props = null;
  if (hadAppState) await new Promise((resolve) => setTimeout(resolve, 550));
});
vi.mock("./editor-toolbar.tsx", () => ({ EditorToolbar: () => null }));
vi.mock("./content-toolbar.tsx", () => ({ ContentToolbar: () => null }));
vi.mock("./tab-bar.tsx", () => ({ TabBar: () => null, fromTabDndId: () => null }));
vi.mock("./empty-state.tsx", () => ({ EmptyState: () => null }));
vi.mock("../lib/dnd/index.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/dnd/index.ts")>(),
  useDroppable: () => ({ ref: () => {}, isDropTarget: () => false }),
}));

import { PaneView } from "./pane-view.tsx";
import { AppShell } from "./app-shell.tsx";

function fileEntry(name = "doc.md"): FSEntry {
  return { name, path: name, kind: "file" };
}

function makePane(opts: { file?: FSEntry; mode?: "edit" | "split" | "preview"; html?: string; rootId?: string } = {}): PaneStore {
  const [editorMode] = createSignal<"edit" | "split" | "preview">(opts.mode ?? "split");
  const [selectedFile] = createSignal<FSEntry | null>(opts.file ?? fileEntry());
  return {
    paneId: "p0",
    editorMode,
    selectedFile,
    // Methods PaneView's children would consume — children are mocked
    // so these are never reached, but the type cast needs SOMETHING.
    tabs: { tabs: () => [], getActiveTab: () => null, pinTab: () => {} },
    html: () => opts.html ?? "",
    editorContent: () => "",
    setEditorContent: () => {},
    savedContent: () => "",
    setSavedContent: () => {},
    frontmatter: () => null,
    setFrontmatter: () => {},
    selectedRootId: () => opts.rootId ?? null,
    setSelectedRootId: () => {},
    setSelectedFile: () => {},
    setEditorMode: () => {},
    setHtml: () => {},
    loading: () => false,
    setLoading: () => {},
  } as unknown as PaneStore;
}

function makeState(onEditorResizeStart: (...args: unknown[]) => void): AppState {
  const [pendingFragment, setPendingFragment] = createSignal<string | null>(null);
  type HtmlNavigation = { rootId: string; path: string; fragment: string };
  const [pendingHtmlNavigation, updatePending] = createSignal<Record<string, HtmlNavigation>>({});
  const [appliedHtmlNavigation, updateApplied] = createSignal<Record<string, HtmlNavigation>>({});
  const clearAppliedHtmlNavigation = (paneId: string) => updateApplied((current) => {
    const next = { ...current };
    delete next[paneId];
    return next;
  });
  const setPendingHtmlNavigation = (paneId: string, target: HtmlNavigation | null) => {
    updatePending((current) => {
      const next = { ...current };
      if (target) next[paneId] = target;
      else delete next[paneId];
      return next;
    });
    clearAppliedHtmlNavigation(paneId);
  };
  const consumePendingHtmlNavigation = (paneId: string, target: HtmlNavigation) => {
    updatePending((current) => {
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    updateApplied((current) => ({ ...current, [paneId]: target }));
  };
  const [pendingHeadingText, setPendingHeadingText] = createSignal<string | null>(null);
  return {
    editorWidth: () => 50,
    syncScroll: () => false,
    darkMode: () => false,
    indentMode: () => "spaces",
    indentSize: () => 2,
    showLineNumbers: () => true,
    showInvisibles: () => false,
    wrapText: () => true,
    fontPrefs: () => ({ fontSize: 14, fontFamily: "system" }),
    FontFamilies: [],
    FontSizes: [],
    autoRefresh: () => true,
    editorSearchOpen: () => false,
    setEditorSearchOpen: () => {},
    editorFindTrigger: () => 0,
    previewSearchOpen: () => false,
    setPreviewSearchOpen: () => {},
    previewFindTrigger: () => 0,
    triggerPreviewFind: () => {},
    pendingFragment,
    setPendingFragment,
    pendingHtmlNavigation,
    appliedHtmlNavigation,
    setPendingHtmlNavigation,
    consumePendingHtmlNavigation,
    clearAppliedHtmlNavigation,
    pendingHeadingText,
    setPendingHeadingText,
    onEditorResizeStart,
    onEditorResizeReset: () => {},
    handleIndentModeChange: () => {},
    handleIndentSizeChange: () => {},
    handleShowInvisiblesChange: () => {},
    handleLineNumbersChange: () => {},
    handleSyncScrollChange: () => {},
    handleWrapTextChange: () => {},
    handleFontPrefsChange: () => {},
    setAutoRefresh: () => {},
    debouncedConvert: () => {},
    _readFile: null,
  } as unknown as AppState;
}

describe("PaneView resize handle", () => {
  it("mounts the resize handle inside .content-panels with .editor-panel + .content as siblings", () => {
    // Mutation captured: moving the `.resize-handle` out of
    // `.content-panels` (or renaming either sibling class) breaks
    // the structural contract that `onEditorResizeStart` depends
    // on. The handler's selector logic queries the parent for
    // both classes; without this invariant the drag is silent.
    const pane = makePane();
    const state = makeState(() => {});
    const { container } = render(() => (
      <PaneView pane={pane} state={state} paneIndex={0} isActive={true} />
    ));
    const handle = container.querySelector<HTMLElement>(".resize-handle");
    expect(handle).not.toBeNull();
    const parent = handle!.parentElement;
    expect(parent).not.toBeNull();
    expect(parent!.classList.contains("content-panels")).toBe(true);
    expect(parent!.querySelector(".editor-panel")).not.toBeNull();
    expect(parent!.querySelector(".content")).not.toBeNull();
  });

  it("mousedown on the resize handle passes a ref that resolves both .editor-panel and .content", () => {
    // Mutation captured: this is the exact bug fixed in 584f01a —
    // passing `editorPanelRef` (or any sibling/descendant of
    // `.content-panels`) instead of `contentPanelsRef` makes both
    // querySelector calls return null inside the handler, and the
    // drag silently does nothing. Spy on `onEditorResizeStart` and
    // assert the ref the handler received has the right descendants
    // — this fails the moment the call site forwards the wrong ref.
    const onEditorResizeStart = vi.fn();
    const pane = makePane();
    const state = makeState(onEditorResizeStart);
    const { container } = render(() => (
      <PaneView pane={pane} state={state} paneIndex={0} isActive={true} />
    ));
    const handle = container.querySelector<HTMLElement>(".resize-handle");
    expect(handle).not.toBeNull();
    fireEvent.mouseDown(handle!);
    expect(onEditorResizeStart).toHaveBeenCalledTimes(1);
    const [, mainRef] = onEditorResizeStart.mock.calls[0]!;
    const ref = mainRef as HTMLElement | undefined;
    expect(ref).toBeDefined();
    expect(ref!.querySelector(".editor-panel")).not.toBeNull();
    expect(ref!.querySelector(".content")).not.toBeNull();
  });
});

describe("PaneView content routing by file kind", () => {
  it("an image file renders the media viewer, not the editor/preview", () => {
    // Mutation captured: dropping the isMedia() branch (or its guards on
    // the editor/preview Shows) would mount the text editor for a binary
    // image — there'd be an .editor-panel and no .media-viewer.
    const pane = makePane({ file: fileEntry("pic.png"), mode: "preview", rootId: "root-0" });
    const state = makeState(() => {});
    const { container } = render(() => (
      <PaneView
        pane={pane}
        state={state}
        paneIndex={0}
        isActive={true}
        resolveFileSrc={(_root, p) => `asset://${p}`}
      />
    ));
    expect(container.querySelector(".media-viewer")).not.toBeNull();
    expect(container.querySelector(".editor-panel")).toBeNull();
    expect(container.querySelector("img.media-image")?.getAttribute("src")).toBe("asset://pic.png");
  });

  it("an unsupported binary (UNSUPPORTED_CONTENT html) shows the notice, no editor/viewer", () => {
    // Mutation captured: removing the isUnsupported() branch leaves the
    // editor/preview Shows to render an empty editor for binary junk.
    // The notice carries the filename regardless of locale.
    const pane = makePane({ file: fileEntry("archive.zip"), mode: "edit", html: UNSUPPORTED_CONTENT });
    const state = makeState(() => {});
    const { container } = render(() => (
      <PaneView pane={pane} state={state} paneIndex={0} isActive={true} />
    ));
    const notice = container.querySelector(".media-message");
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain("archive.zip");
    expect(container.querySelector(".editor-panel")).toBeNull();
    expect(container.querySelector(".media-viewer")).toBeNull();
  });
});

describe("PaneView resolved HTML navigation", () => {
  it("keeps the resolved anchor in src after load without applying it to a different root or path", async () => {
    const [selectedFile, selectFile] = createSignal<FSEntry | null>(fileEntry("source.adoc"));
    const [root, setRoot] = createSignal("root-0");
    const pane = { ...makePane({ mode: "preview" }), selectedFile, selectedRootId: root };
    const state = makeState(() => {});
    const host = {
      docOrigin: () => "markdraw-preview://r0",
      register: async (_root: string, path: string) => ({ token: "r0", entryRel: path, ownRoot: false }),
      setOverlay: () => {}, clearOverlay: () => {},
    };
    const { container } = render(() => (
      <PaneView pane={pane} state={state} paneIndex={0} isActive={true} htmlPreviewHost={host} />
    ));
    state.setPendingHtmlNavigation("p0", { rootId: "root-1", path: "sub/my página.html", fragment: 'a "&#?=/' });
    state.setPendingFragment('a "&#?=/');
    selectFile({ name: "my página.html", path: "other/my página.html", kind: "file" });
    setRoot("root-1");
    flush();
    await vi.waitFor(() => expect(container.querySelector("iframe")?.getAttribute("src")).toContain("am-token=r0&v=0"));
    expect(container.querySelector("iframe")!.getAttribute("src")).not.toContain("#");
    selectFile({ name: "my página.html", path: "sub/my página.html", kind: "file" });
    setRoot("root-0");
    flush();
    await vi.waitFor(() => expect(container.querySelector("iframe")?.getAttribute("src")).toContain("sub/my%20p%C3%A1gina.html"));
    expect(container.querySelector("iframe")!.getAttribute("src")).not.toContain("#");
    setRoot("root-1");
    flush();
    await vi.waitFor(() => expect(container.querySelector("iframe")?.getAttribute("src")).toMatch(/#a%20%22%26%23%3F%3D%2F$/));
    const iframe = container.querySelector("iframe")!;
    const before = iframe.getAttribute("src");
    const changes: Array<string | null> = [];
    const observer = new MutationObserver(() => changes.push(iframe.getAttribute("src")));
    observer.observe(iframe, { attributes: true, attributeFilter: ["src"] });
    try {
      iframe.dispatchEvent(new Event("load"));
      flush();
      await Promise.resolve();
      expect(state.pendingHtmlNavigation()).toEqual({});
      expect(iframe.getAttribute("src")).toBe(before);
      expect(changes).toEqual([]);
      expect(container.querySelector("iframe")).toBe(iframe);
    } finally {
      observer.disconnect();
    }
  });
});

describe("AppShell HTML navigation pane ownership", () => {
  const file: FSEntry = { name: "page.html", path: "page.html", kind: "file" };
  const source: FSEntry = { name: "source.adoc", path: "source.adoc", kind: "file" };

  function mount(split: boolean) {
    localStorage.clear();
    const { state, actions, navigation } = createRoot((dispose) => {
      disposers.push(dispose);
      const state = createAppState({
        applyTheme: () => {},
        convertAdoc: async () => ({ html: "", frontmatter: null }),
        convertMarkdown: async () => ({ html: "", frontmatter: null }),
        getStoredTheme: () => "system",
      });
      const actions = createTabActions({
        state,
        rootPaths: () => new Map([["root", "/workspace"]]),
        syncWatcher: () => {},
        loadTabContent: async (pane, entry, tab) => {
          pane.tabs.updateTabContent(tab.id, { needsLoad: false });
          pane.setSelectedFile(entry);
          pane.setSelectedRootId("root");
          pane.setEditorMode("preview");
        },
        loadFileContent: async (entry, _pushHistory, _force, rootId) => {
          const pane = state.paneManager.activePane();
          pane.setSelectedFile(entry);
          pane.setSelectedRootId(rootId ?? null);
        },
      });
      const navigation = createNavigation({
        state,
        rootPaths: () => new Map([["root", "/workspace"]]),
        loadFileContent: async () => {},
        onOpenFile: (entry, rootId, pinned, pushHistory) => actions.openFile(entry, rootId, pinned, pushHistory),
      });
      return { state, actions, navigation };
    });
    state.addRoot({ id: "root", name: "workspace", collapsed: false, entries: [file, source] });
    state.paneManager.activePane().setSelectedRootId("root");
    flush();
    if (split) {
      state.paneManager.splitFromActive();
      flush();
      const right = state.paneManager.activePane();
      right.setSelectedFile(file);
      right.setSelectedRootId("root");
      right.setEditorMode("preview");
      state.paneManager.setActivePane(0);
      flush();
    }
    let resolveLeft!: (value: { token: string; entryRel: string; ownRoot: boolean }) => void;
    const leftRegistration = new Promise<{ token: string; entryRel: string; ownRoot: boolean }>((resolve) => { resolveLeft = resolve; });
    let registrations = 0;
    const host = {
      docOrigin: (token: string) => `markdraw-preview://${token}`,
      register: () => {
        registrations += 1;
        return split && registrations === 1
          ? Promise.resolve({ token: "right", entryRel: file.path, ownRoot: false })
          : leftRegistration;
      },
      setOverlay: () => {}, clearOverlay: () => {},
    };
    const view = render(() => (
      <AppShell state={state} hasRoot={true} showEditorTabs={false} showNavButtons={false}
        showToolbar={false} showSidebar={false} toolbarFilePath={null} toolbarRootName=""
        onGoBack={() => {}} onGoForward={() => {}} onLoadFile={() => {}} htmlPreviewHost={host} />
    ));
    return { state, actions, navigation, resolveLeft, container: view.container };
  }

  it("applies an HTML anchor in the single pane without a visual focus border", async () => {
    const f = mount(false);
    await f.navigation.handleNavigate(file.path, "seção");
    flush();
    f.resolveLeft({ token: "left", entryRel: file.path, ownRoot: false });
    await vi.waitFor(() => expect(f.container.querySelector("iframe")?.getAttribute("src")).toContain("#se%C3%A7%C3%A3o"));
    const iframe = f.container.querySelector("iframe")!;
    expect(f.container.querySelector(".pane-view-active")).toBeNull();
    iframe.dispatchEvent(new Event("load"));
    flush();
    expect(f.state.pendingHtmlNavigation()).toEqual({});
    expect(iframe.getAttribute("src")).toContain("#se%C3%A7%C3%A3o");
  });

  it("keeps both anchors while the first pane registration is delayed", async () => {
    const f = mount(true);
    await vi.waitFor(() => expect(f.container.querySelector('[data-pane-index="1"] iframe')).not.toBeNull());
    await f.navigation.handleNavigate(file.path, "seção");
    flush();
    f.state.paneManager.setActivePane(1);
    flush();
    await f.navigation.handleNavigate(file.path, "other");
    flush();
    await vi.waitFor(() => expect(f.container.querySelector('[data-pane-index="1"] iframe')?.getAttribute("src")).toContain("#other"));
    f.container.querySelector<HTMLIFrameElement>('[data-pane-index="1"] iframe')!.dispatchEvent(new Event("load"));
    flush();
    f.resolveLeft({ token: "left", entryRel: file.path, ownRoot: false });
    await vi.waitFor(() => expect(f.container.querySelector('[data-pane-index="0"] iframe')?.getAttribute("src")).toContain("#se%C3%A7%C3%A3o"));
    const left = f.container.querySelector<HTMLIFrameElement>('[data-pane-index="0"] iframe')!;
    left.dispatchEvent(new Event("load"));
    flush();
    expect(left.getAttribute("src")).toContain("#se%C3%A7%C3%A3o");
    expect(f.container.querySelector('[data-pane-index="1"] iframe')?.getAttribute("src")).toContain("#other");
    f.state.paneManager.setActivePane(0);
    flush();
    await f.navigation.handleNavigate(file.path, null);
    flush();
    await vi.waitFor(() => expect(f.container.querySelector('[data-pane-index="0"] iframe')?.getAttribute("src")).not.toContain("#"));
    expect(f.container.querySelector('[data-pane-index="1"] iframe')?.getAttribute("src")).toContain("#other");
  });

  it("clears a pending anchor when reopening HTML without a fragment in edit mode", async () => {
    const f = mount(false);
    const pane = f.state.paneManager.activePane();
    await f.actions.openFile(file, "root", true);
    flush();
    pane.setEditorMode("edit");
    flush();
    await f.actions.openFile(source, "root", true);
    flush();
    pane.setEditorMode("preview");
    flush();
    f.state.setPendingHtmlNavigation(pane.paneId, { rootId: "root", path: file.path, fragment: "old" });
    flush();
    await f.navigation.handleNavigate(file.path, null);
    flush();
    expect(pane.editorMode()).toBe("edit");
    expect(pane.selectedFile()?.path).toBe(file.path);
    expect(f.container.querySelector(".editor-panel")).not.toBeNull();
    expect(f.container.querySelector("iframe")).toBeNull();
    expect(f.state.pendingHtmlNavigation()).toEqual({});
  });

  it("drops a closed pane's anchor so the next pane with its id does not inherit it", async () => {
    const f = mount(true);
    await vi.waitFor(() => expect(f.container.querySelector('[data-pane-index="1"] iframe')).not.toBeNull());
    f.state.paneManager.setActivePane(1);
    flush();
    await f.navigation.handleNavigate(file.path, "seção");
    flush();
    expect(f.state.pendingHtmlNavigation()["pane-1"]).toBeDefined();
    // Let the right pane apply it first, so both the pending and the applied
    // records exist when the pane closes.
    await vi.waitFor(() => expect(f.container.querySelector('[data-pane-index="1"] iframe')?.getAttribute("src")).toContain("#se%C3%A7%C3%A3o"));
    f.container.querySelector<HTMLIFrameElement>('[data-pane-index="1"] iframe')!.dispatchEvent(new Event("load"));
    flush();
    expect(f.state.appliedHtmlNavigation()["pane-1"]).toBeDefined();
    f.state.paneManager.collapseRightPane();
    flush();
    expect(f.state.pendingHtmlNavigation()["pane-1"]).toBeUndefined();
    expect(f.state.appliedHtmlNavigation()["pane-1"]).toBeUndefined();
    f.state.paneManager.splitFromActive();
    flush();
    // The tree opens the same page in the new `pane-1`, without a fragment.
    await f.actions.openFile(file, "root");
    flush();
    expect(f.state.paneManager.activePane().selectedFile()?.path).toBe(file.path);
    expect(f.state.pendingHtmlNavigation()["pane-1"]).toBeUndefined();
  });

  it("keeps the opening pane's HTML anchor when focus changes before registration", async () => {
    const f = mount(true);
    await vi.waitFor(() => expect(f.container.querySelector('[data-pane-index="1"] iframe')).not.toBeNull());
    await f.navigation.handleNavigate(file.path, "seção");
    flush();
    f.state.paneManager.setActivePane(1);
    flush();
    await f.actions.openFile(file, "root");
    flush();
    const right = f.container.querySelector<HTMLIFrameElement>('[data-pane-index="1"] iframe')!;
    expect(right.getAttribute("src")).not.toContain("#");
    right.dispatchEvent(new Event("load"));
    flush();
    expect(f.state.pendingHtmlNavigation()["pane-0"]).toBeDefined();
    f.resolveLeft({ token: "left", entryRel: file.path, ownRoot: false });
    await vi.waitFor(() => expect(f.container.querySelector('[data-pane-index="0"] iframe')?.getAttribute("src")).toContain("#se%C3%A7%C3%A3o"));
    const left = f.container.querySelector<HTMLIFrameElement>('[data-pane-index="0"] iframe')!;
    left.dispatchEvent(new Event("load"));
    flush();
    expect(f.state.pendingHtmlNavigation()).toEqual({});
    expect(left.getAttribute("src")).toContain("#se%C3%A7%C3%A3o");
    expect(right.getAttribute("src")).not.toContain("#");
  });
});

describe("AppShell → PaneView resolveFileBlob wiring", () => {
  it("AppShell hands resolveFileBlob to the PaneView so a dot-folder image opens from a blob: URL", async () => {
    // Mutation: dropping `resolveFileBlob={props.resolveFileBlob}` from the
    // AppShell's <PaneView> leaves the viewer on the (refused) asset URL path.
    URL.createObjectURL = vi.fn(() => "blob:test/shell");
    URL.revokeObjectURL = vi.fn();
    const load = vi.fn(async () => new Blob([new Uint8Array([1])], { type: "image/png" }));
    const resolveFileBlob = vi.fn((_root: string, p: string) => (p.startsWith(".docs/") ? load : null));
    let state!: ReturnType<typeof createAppState>;
    const { container } = render(() => {
      state = createAppState({
        applyTheme: () => {},
        convertAdoc: async () => ({ html: "", frontmatter: null }),
        convertMarkdown: async () => ({ html: "", frontmatter: null }),
        getStoredTheme: () => "system",
      });
      return createComponent(AppShell, {
        state,
        showToolbar: false,
        hasRoot: true,
        showEditorTabs: true,
        showNavButtons: false,
        showSidebar: false,
        toolbarFilePath: null,
        toolbarRootName: "",
        onGoBack: vi.fn(),
        onGoForward: vi.fn(),
        onLoadFile: vi.fn(),
        onOpenFolder: vi.fn(),
        resolveFileSrc: (_root: string, p: string) => `asset://${p}`,
        resolveFileBlob,
      });
    });
    const pane = state.paneManager.activePane();
    pane.setSelectedFile({ name: "img.png", path: ".docs/img.png", kind: "file" });
    pane.setSelectedRootId("root-0");
    flush();
    await waitFor(() =>
      expect(container.querySelector("img.media-image")?.getAttribute("src")).toBe("blob:test/shell"),
    );
    expect(resolveFileBlob).toHaveBeenCalledWith("root-0", ".docs/img.png");
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("PaneView pending jump discard", () => {
  function mountWithPreview(state: AppState) {
    render(() => (
      <PaneView pane={makePane({ mode: "preview" })} state={state} paneIndex={0} isActive={true} />
    ));
    const props = previewCtl.props!;
    return {
      discardFragment: props.onFragmentDiscarded as (fragment: string) => void,
      discardHeading: props.onHeadingDiscarded as (heading: string) => void,
    };
  }

  it("clears only the discarded fragment signal", () => {
    const state = makeState(() => {});
    const { discardFragment } = mountWithPreview(state);
    state.setPendingFragment("target-a");
    flush();
    discardFragment("target-a");
    flush();
    expect(untrack(state.pendingFragment)).toBeNull();

    state.setPendingFragment("target-b");
    flush();
    discardFragment("target-a");
    flush();
    expect(untrack(state.pendingFragment)).toBe("target-b");
  });

  it("clears only the discarded heading signal", () => {
    const state = makeState(() => {});
    const { discardHeading } = mountWithPreview(state);
    state.setPendingHeadingText("Target A");
    flush();
    discardHeading("Target A");
    flush();
    expect(untrack(state.pendingHeadingText)).toBeNull();

    state.setPendingHeadingText("Target B");
    flush();
    discardHeading("Target A");
    flush();
    expect(untrack(state.pendingHeadingText)).toBe("Target B");
  });
});
