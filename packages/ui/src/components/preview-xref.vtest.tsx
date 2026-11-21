import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { createRoot, flush } from "solid-js";
import { convertAdoc } from "@markdraw/core/asciidoc.ts";
import { buildAnchorIndex } from "@markdraw/core/asciidoc-anchors.ts";
import { createAnchorNavigation, type AnchorIndexState } from "../../../../apps/desktop/src/lib/anchor-navigation.ts";
import { createNavigation } from "../../../../apps/desktop/src/lib/navigation.ts";
import { createTabActions } from "../../../../apps/desktop/src/lib/tab-actions.ts";
import { createAppState, type FragmentSource } from "../composables/create-app-state.ts";

const mermaidControl = vi.hoisted(() => ({
  ensureMermaidWarm: async () => {},
  renderInFrame: async (id: string) => ({
    svg: `<svg id="${id}" viewBox="0 0 10 10"><text>x</text></svg>`,
  }),
}));
vi.mock(import("../lib/mermaid-frame.ts"), async (original) => ({
  ...await original(),
  ...mermaidControl,
}));

import { Preview } from "./preview.tsx";
import { AppShell } from "./app-shell.tsx";
import { mermaidCache } from "../lib/mermaid-cache.ts";

const defaults = {
  frontmatter: null,
  loading: false,
  searchOpen: false,
  syncScrollActive: false,
  syncScrollTargetRatio: null,
  syncScrollTargetVersion: 0,
  wrapTables: false,
  findTrigger: 0,
  pendingFragment: null,
  tocVisible: false,
  onFragmentHandled: () => {},
  onNavigate: () => {},
  onScrollRatioChange: () => {},
  onSearchOpenChange: () => {},
  onTocChange: () => {},
};

const disposers: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  mermaidCache.clear();
  localStorage.clear();
});

async function renderLink(html: string, onUnresolvedFragment?: (id: string) => void) {
  const { container } = render(() => (
    <Preview {...defaults} html={html} onUnresolvedFragment={onUnresolvedFragment} />
  ));
  await waitFor(() => expect(container.querySelector("a#xref")).not.toBeNull());
  return container.querySelector<HTMLAnchorElement>("a#xref")!;
}

it("rola até uma âncora presente sem chamar onUnresolvedFragment", async () => {
  const scrollIntoView = vi.fn();
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scrollIntoView;
  const onUnresolvedFragment = vi.fn();
  try {
    const link = await renderLink(
      '<h1 id="target">Target</h1><a id="xref" href="#target">Link</a>',
      onUnresolvedFragment,
    );
    link.click();
    expect(scrollIntoView).toHaveBeenCalled();
    expect(onUnresolvedFragment).not.toHaveBeenCalled();
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

it("chama onUnresolvedFragment com o id decodificado quando a âncora falta", async () => {
  const onUnresolvedFragment = vi.fn();
  const link = await renderLink('<a id="xref" href="#id%20com%20espaco">Link</a>', onUnresolvedFragment);
  link.click();
  expect(onUnresolvedFragment).toHaveBeenCalledTimes(1);
  expect(onUnresolvedFragment).toHaveBeenCalledWith("id com espaco");
});

it("não quebra quando a prop não é fornecida", async () => {
  const link = await renderLink('<a id="xref" href="#ausente">Link</a>');
  expect(() => link.click()).not.toThrow();
});

async function mountAdocLink({ split = false, waitForIndex = false } = {}) {
  const rootId = "/work/Guias%20São Paulo";
  const otherRoot = "/work/Guias São Paulo";
  const from = { name: "index.adoc", path: "index.adoc", kind: "file" } as const;
  const target = { name: "capítulo%20um.adoc", path: "capítulo%20um.adoc", kind: "file" } as const;
  const sourceText = "Veja <<alvo>>.";
  const targetText = "[[alvo]]\n== Destino";
  const documents = [
    [from, sourceText],
    [target, targetText],
  ] as const;
  const html = new Map<string, string>(await Promise.all(documents.map(async ([file, fileContent]) => {
    return [file.path, (await convertAdoc({
      filePath: file.path, fileContent, readFile: async () => null,
    })).html] as const;
  })));
  const rootPaths = () => new Map([[rootId, rootId], [otherRoot, otherRoot]]);
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
      rootPaths,
      syncWatcher: () => {},
      loadFileContent: async () => {},
      loadTabContent: async (pane, entry, tab) => {
        pane.setSelectedFile(entry);
        pane.setSelectedRootId(tab.rootId);
        pane.setEditorMode("preview");
        pane.setHtml(html.get(entry.path)!);
        pane.tabs.updateTabContent(tab.id, { needsLoad: false });
      },
    });
    const navigation = createNavigation({
      state,
      rootPaths,
      loadFileContent: async () => {},
      onOpenFile: actions.openFile,
    });
    return { state, actions, navigation };
  });
  state.addRoot({ id: rootId, name: "Guias%20São Paulo", entries: [from, target], collapsed: false });
  state.addRoot({ id: otherRoot, name: "Guias São Paulo", entries: [from, target], collapsed: false });
  flush();
  await actions.openFile(from, rootId, true);
  flush();
  const left = state.paneManager.activePane();
  if (split) {
    state.paneManager.splitFromActive();
    flush();
    await actions.openFile(from, rootId, true);
    state.paneManager.setActivePane(0);
    flush();
  }

  const index = buildAnchorIndex([rootId, otherRoot].map((rootId) => ({
    rootId, rootName: rootId, path: target.path, content: targetText,
  })));
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let indexState: AnchorIndexState = waitForIndex ? { index: null, pending } : { index, pending: null };
  const publish = () => {
    indexState = { index, pending: null };
    finish();
  };
  const navigate = vi.fn(navigation.handleNavigate);
  const handle = createAnchorNavigation({
    getState: () => indexState,
    getActivePane: state.paneManager.activePane,
    navigate,
  });
  const unresolved = vi.fn((_id: string, source?: FragmentSource) => source && handle(source));
  const { container } = render(() => (
    <AppShell state={state} hasRoot={true} showEditorTabs={false} showNavButtons={false}
      showToolbar={false} showSidebar={false} toolbarFilePath={null} toolbarRootName=""
      onGoBack={() => {}} onGoForward={() => {}} onLoadFile={() => {}}
      onUnresolvedFragment={unresolved} />
  ));
  await waitFor(() => expect(container.querySelector('[data-pane-index="0"] a[href="#alvo"]')).not.toBeNull());
  const link = container.querySelector<HTMLAnchorElement>('[data-pane-index="0"] a[href="#alvo"]')!;
  return { state, left, rootId, otherRoot, target, from, link, publish, navigate, unresolved, container };
}

it("F4 abre o destino no primeiro clique e usa a raiz da aba exibida", async () => {
  const f = await mountAdocLink();
  f.left.setSelectedRootId(f.otherRoot);
  flush();
  expect(f.left.tabs.getActiveTab()).toMatchObject({ rootId: f.rootId, filePath: f.from.path });
  const rect = Element.prototype.getBoundingClientRect;
  const measure = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const original = rect.call(this);
    return this.id === "alvo" ? { ...original, top: 100 } : original;
  });
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(() => {});
  try {
    f.link.click();
    expect(f.unresolved).toHaveBeenCalledExactlyOnceWith("alvo", {
      id: "alvo", paneId: f.left.paneId, tabId: f.left.tabs.getActiveTab()?.id,
      rootId: f.rootId, path: f.from.path,
    });
    await f.unresolved.mock.results[0]!.value;
    expect(f.navigate).toHaveBeenCalledExactlyOnceWith({ rootId: f.rootId, path: f.target.path }, "alvo");
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ top: 84, behavior: "instant" }));
    expect(f.left.tabs.getActiveTab()).toMatchObject({ rootId: f.rootId, filePath: f.target.path });
    expect(f.state.pendingFragment()).toBeNull();
  } finally {
    scroll.mockRestore();
    measure.mockRestore();
  }
});

it("F5 descarta o clique se o foco mudar durante a espera, mesmo com a mesma aba aberta", async () => {
  const f = await mountAdocLink({ split: true, waitForIndex: true });
  const right = f.state.paneManager.panes()[1]!;
  expect(right.tabs.getActiveTab()?.id).toBe(f.left.tabs.getActiveTab()?.id);
  f.link.click();
  expect(f.unresolved).toHaveBeenCalledTimes(1);
  expect(f.navigate).not.toHaveBeenCalled();
  f.state.paneManager.setActivePane(1);
  flush();
  f.publish();
  await f.unresolved.mock.results[0]!.value;
  expect(f.navigate).not.toHaveBeenCalled();
  expect(f.left.tabs.getActiveTab()?.filePath).toBe(f.from.path);
  expect(right.tabs.getActiveTab()?.filePath).toBe(f.from.path);
  expect(f.state.pendingFragment()).toBeNull();
});
