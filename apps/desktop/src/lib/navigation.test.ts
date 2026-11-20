import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { FSEntry } from "@markdraw/core/types.ts";
import type { AppState } from "@markdraw/ui/composables/create-app-state.ts";
import { resolveNavigationTarget } from "./navigation-target.ts";

interface ToastOptions {
  title: string;
  description: string;
  duration?: number;
}

const toasts: ToastOptions[] = [];
let readTreeResult: FSEntry[] | Error = new Error("not a directory");
let readFileResult: string | Error = new Error("not a file");
const fsCalls: string[] = [];

// Desktop-only modules: navigation talks to Tauri through ./fs.ts and to the
// UI toast store. Stub both so the navigation decision runs without a host.
mock.module("./fs.ts", () => ({
  readTree: async (path: string) => {
    fsCalls.push(`tree:${path}`);
    if (readTreeResult instanceof Error) throw readTreeResult;
    return readTreeResult;
  },
  readFileContent: async (path: string) => {
    fsCalls.push(`file:${path}`);
    if (readFileResult instanceof Error) throw readFileResult;
    return readFileResult;
  },
}));
mock.module("@markdraw/ui/components/ui/toast.tsx", () => ({
  showToast: (options: ToastOptions) => {
    toasts.push(options);
  },
}));

// Dynamic import so the module-level mocks above are installed first.
const { createNavigation } = await import("./navigation.ts");

function makeNavigation(
  entriesByRoot: Record<string, string[]>,
  overrides: Record<string, string> = {},
  history?: { stack: Array<{ path: string; rootId: string }>; index: number },
) {
  const loaded: Array<{ entry: FSEntry; rootId?: string }> = [];
  const opened: Array<{ entry: FSEntry; rootId: string; pinned: boolean; pushHistory: boolean }> = [];
  const fragments: Array<string | null> = [];
  const htmlTargets: Array<{ paneId: string; target: { rootId: string; path: string; fragment: string } | null }> = [];
  const rootsAdded: Array<{ id: string; name: string; collapsed: boolean; entries: FSEntry[] }> = [];
  const selectedRoots: Array<string | null> = [];
  const roots = new Map(Object.keys(entriesByRoot).map((id) => [id, `/work/${id}`]));
  for (const [id, path] of Object.entries(overrides)) roots.set(id, path);
  const state = {
    setPendingFragment: (fragment: string | null) => fragments.push(fragment),
    paneManager: { activePane: () => ({ paneId: "pane-0" }) },
    setPendingHtmlNavigation: (paneId: string, target: { rootId: string; path: string; fragment: string } | null) => htmlTargets.push({ paneId, target }),
    navStack: () => history?.stack ?? [],
    navIndex: () => history?.index ?? -1,
    setNavIndex: () => {},
    selectedRootId: () => "root",
    findEntryByPath: (path: string, rootId?: string): FSEntry | null => {
      const files = entriesByRoot[rootId ?? "root"] ?? [];
      return files.includes(path)
        ? { name: path.split("/").pop()!, path, kind: "file" }
        : null;
    },
    rootsList: () => [...roots.keys()].map((id) => ({ id, name: id })),
    showHiddenEntries: () => false,
    addRoot: (root: { id: string; name: string; collapsed: boolean; entries: FSEntry[] }) => { rootsAdded.push(root); },
    setSelectedRootId: (id: string | null) => { selectedRoots.push(id); },
    setSidebarVisible: () => {},
    setSelectedFile: () => {},
    setHtml: () => {},
  } as unknown as AppState;
  const navigation = createNavigation({
    loadFileContent: (entry, _pushHistory, _force, rootId) => {
      loaded.push({ entry, rootId });
      return Promise.resolve();
    },
    rootPaths: () => roots,
    state,
    onOpenFile: (entry, rootId, pinned, pushHistory) => {
      opened.push({ entry, rootId, pinned, pushHistory });
      return Promise.resolve();
    },
  });
  return { navigation, loaded, opened, fragments, htmlTargets, rootsAdded, selectedRoots };
}

describe("createNavigation.handleNavigate — links .html sem irmão .adoc", () => {
  beforeEach(() => {
    toasts.length = 0;
    fsCalls.length = 0;
    readTreeResult = new Error("not a directory");
    readFileResult = new Error("not a file");
  });

  it("abre o .html quando o .adoc irmão não existe", async () => {
    const { navigation, opened, loaded, htmlTargets } = makeNavigation({
      root: ["diagrams/arquitetura.html"],
    });
    await navigation.handleNavigate("diagrams/arquitetura.adoc", "secao");
    expect(opened.map((call) => [call.entry.path, call.rootId, call.pinned, call.pushHistory]))
      .toEqual([["diagrams/arquitetura.html", "root", false, true]]);
    // Link clicks go through tab actions — never through the raw loader.
    expect(loaded).toEqual([]);
    expect(htmlTargets.at(-1)).toEqual({ paneId: "pane-0", target: { rootId: "root", path: "diagrams/arquitetura.html", fragment: "secao" } });
    expect(toasts).toEqual([]);
  });

  it("prefere o .adoc quando ele existe ao lado do .html", async () => {
    const { navigation, opened } = makeNavigation({
      root: ["diagrams/arquitetura.adoc", "diagrams/arquitetura.html"],
    });
    await navigation.handleNavigate("diagrams/arquitetura.adoc", "secao");
    expect(opened.map((call) => call.entry.path)).toEqual(["diagrams/arquitetura.adoc"]);
    expect(toasts).toEqual([]);
  });

  it("mantém a falha anterior quando nenhum dos dois existe", async () => {
    const { navigation, opened, fragments } = makeNavigation({ root: [] });
    await navigation.handleNavigate("diagrams/arquitetura.adoc", "secao");
    expect(opened).toEqual([]);
    expect(toasts).toEqual([
      { title: "File not found", description: "diagrams/arquitetura.adoc", duration: 4000 },
    ]);
    expect(fragments).toEqual(["secao"]);
  });

  it("mantém o fragmento quando o fallback .html abre", async () => {
    const { navigation, fragments, opened } = makeNavigation({
      root: ["diagrams/arquitetura.html"],
    });
    await navigation.handleNavigate("diagrams/arquitetura.adoc", "secao");
    expect(fragments).toEqual(["secao"]);
    expect(opened.map((call) => call.entry.path)).toEqual(["diagrams/arquitetura.html"]);
  });

  it("entrega a identidade resolvida e decodificada do fallback à pane", async () => {
    const { navigation, htmlTargets, opened } = makeNavigation({
      root: [], docs: ["sub/my página.html"],
    });
    await navigation.handleNavigate("sub/my%20p%C3%A1gina.adoc", "secao");
    expect(opened.map((call) => [call.entry.path, call.rootId])).toEqual([["sub/my página.html", "docs"]]);
    expect(htmlTargets.at(-1)).toEqual({ paneId: "pane-0", target: { rootId: "docs", path: "sub/my página.html", fragment: "secao" } });
  });

  it("acha o .html em outra raiz aberta", async () => {
    const { navigation, opened } = makeNavigation({
      root: [],
      docs: ["diagrams/arquitetura.html"],
    });
    await navigation.handleNavigate("diagrams/arquitetura.adoc");
    expect(opened.map((call) => [call.entry.path, call.rootId])).toEqual([
      ["diagrams/arquitetura.html", "docs"],
    ]);
  });

  it("acha o .html de um link relativo com ../", async () => {
    const { navigation, opened } = makeNavigation({
      root: ["../diagrams/arquitetura.html"],
    });
    await navigation.handleNavigate("../diagrams/arquitetura.adoc");
    expect(opened.map((call) => call.entry.path)).toEqual(["../diagrams/arquitetura.html"]);
  });

  it("usa as ações de aba no fallback do sistema de arquivos", async () => {
    readFileResult = "<p>html</p>";
    const { navigation, opened, loaded, htmlTargets } = makeNavigation({ root: [] });
    await navigation.handleNavigate("solto.html", "topo");
    expect(opened.map((call) => [call.entry.path, call.rootId, call.pinned, call.pushHistory]))
      .toEqual([["solto.html", "root", false, true]]);
    expect(htmlTargets.at(-1)).toEqual({ paneId: "pane-0", target: { rootId: "root", path: "solto.html", fragment: "topo" } });
    expect(loaded).toEqual([]);
  });

  it("abre um diretório vazio como nova raiz em vez do .html homônimo", async () => {
    readTreeResult = [];
    const { navigation, opened, loaded, rootsAdded, selectedRoots } = makeNavigation({ root: [] });
    await navigation.handleNavigate("x.adoc");
    expect(rootsAdded).toEqual([{
      id: "/work/root/x.adoc", name: "x.adoc", collapsed: false, entries: [],
    }]);
    expect(selectedRoots).toEqual(["/work/root/x.adoc"]);
    expect(opened).toEqual([]);
    expect(loaded).toEqual([]);
    expect(fsCalls).toEqual(["tree:/work/root/x.adoc"]);
  });

  it("ainda abre um diretório não vazio como nova raiz", async () => {
    const child: FSEntry = { name: "filho.adoc", path: "filho.adoc", kind: "file" };
    readTreeResult = [child];
    const { navigation, rootsAdded } = makeNavigation({ root: [] });
    await navigation.handleNavigate("pasta");
    expect(rootsAdded).toEqual([{
      id: "/work/root/pasta", name: "pasta", collapsed: false, entries: [child],
    }]);
  });

  it("voltar continua usando o loader direto, sem actions de aba", () => {
    const { navigation, opened, loaded } = makeNavigation(
      { root: ["a.adoc"] },
      {},
      { stack: [{ path: "a.adoc", rootId: "root" }], index: 1 },
    );
    navigation.handleGoBack();
    expect(loaded.map((call) => [call.entry.path, call.rootId])).toEqual([["a.adoc", "root"]]);
    expect(opened).toEqual([]);
  });
});

describe("createNavigation — voltar e avançar com abas de id com sufixo", () => {
  function setup(tabs: Array<{ id: string; rootId: string; filePath: string }>) {
    const activated: string[] = [];
    const historyOpened: string[] = [];
    const state = {
      navStack: () => [{ path: "sub/page.html", rootId: "/other" }, { path: "b.md", rootId: "/other" }],
      navIndex: () => 1,
      setNavIndex: () => {},
      findEntryByPath: (path: string): FSEntry => ({ name: path.split("/").pop()!, path, kind: "file" }),
    } as unknown as AppState;
    const navigation = createNavigation({
      loadFileContent: () => Promise.resolve(),
      rootPaths: () => new Map(),
      state,
      // The store answers like the real one: the canonical id first, else the
      // tab of that root and path, whatever its id.
      tabStore: () => ({
        getTab: (id: string) => tabs.find((tab) => tab.id === id),
        findTabByFile: (path: string, rootId: string) =>
          tabs.find((tab) => tab.id === `${rootId}::${path}`)
          ?? tabs.find((tab) => tab.rootId === rootId && tab.filePath === path),
      }) as never,
      onActivateTab: (id) => { activated.push(id); },
      onOpenHistoryTab: (entry) => { historyOpened.push(entry.path); },
      onOpenFile: () => Promise.resolve(),
    });
    return { navigation, activated, historyOpened };
  }

  it("ativa a única aba do caminho mesmo quando o id dela tem sufixo", () => {
    const { navigation, activated, historyOpened } = setup([
      { id: "/other::sub/page.html#1", rootId: "/other", filePath: "sub/page.html" },
    ]);
    navigation.handleGoBack();
    expect(activated).toEqual(["/other::sub/page.html#1"]);
    expect(historyOpened).toEqual([]);
  });

  it("controle: com o id canônico, ativa esse id", () => {
    const { navigation, activated } = setup([
      { id: "/other::sub/page.html#1", rootId: "/other", filePath: "sub/page.html" },
      { id: "/other::sub/page.html", rootId: "/other", filePath: "sub/page.html" },
    ]);
    navigation.handleGoBack();
    expect(activated).toEqual(["/other::sub/page.html"]);
  });

  it("sem aba do caminho, abre pelo histórico", () => {
    const { navigation, activated, historyOpened } = setup([]);
    navigation.handleGoBack();
    expect(activated).toEqual([]);
    expect(historyOpened).toEqual(["sub/page.html"]);
  });
});

describe("resolveNavigationTarget", () => {
  const roots = new Map([
    ["repo", "/Users/djalmajr/Developer/djalmajr/markdraw"],
    ["docs", "/Users/djalmajr/Developer/djalmajr/markdraw/docs"],
  ]);

  it("keeps repo-relative paths unchanged", () => {
    expect(resolveNavigationTarget("apps/site/public/demo-folder/docs/architecture.adoc", roots))
      .toEqual({ path: "apps/site/public/demo-folder/docs/architecture.adoc" });
  });

  it("maps absolute paths under an open root to root-relative paths", () => {
    expect(resolveNavigationTarget(
      "/Users/djalmajr/Developer/djalmajr/markdraw/apps/site/public/demo-folder/docs/architecture.adoc",
      roots,
    )).toEqual({
      path: "apps/site/public/demo-folder/docs/architecture.adoc",
      rootId: "repo",
    });
  });

  it("prefers the deepest open root for absolute paths", () => {
    expect(resolveNavigationTarget(
      "file:///Users/djalmajr/Developer/djalmajr/markdraw/docs/README.md",
      roots,
    )).toEqual({ path: "README.md", rootId: "docs" });
  });

  it("removes an open root name prefix from model-emitted paths", () => {
    expect(resolveNavigationTarget("markdraw/apps/site/public/demo-folder/docs/architecture.adoc", roots))
      .toEqual({
        path: "apps/site/public/demo-folder/docs/architecture.adoc",
        rootId: "repo",
      });
  });
});
