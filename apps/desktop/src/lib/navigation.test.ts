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

// Desktop-only modules: navigation talks to Tauri through ./fs.ts and to the
// UI toast store. Stub both so the navigation decision runs without a host.
mock.module("./fs.ts", () => ({
  readTree: async () => {
    throw new Error("not a directory");
  },
  readFileContent: async () => {
    throw new Error("not a file");
  },
}));
mock.module("@markdraw/ui/components/ui/toast.tsx", () => ({
  showToast: (options: ToastOptions) => {
    toasts.push(options);
  },
}));

// Dynamic import so the module-level mocks above are installed first.
const { createNavigation } = await import("./navigation.ts");

function makeNavigation(entriesByRoot: Record<string, string[]>) {
  const loaded: Array<{ entry: FSEntry; rootId?: string }> = [];
  const fragments: Array<string | null> = [];
  const roots = new Map(Object.keys(entriesByRoot).map((id) => [id, `/work/${id}`]));
  const state = {
    setPendingFragment: (fragment: string | null) => fragments.push(fragment),
    selectedRootId: () => "root",
    findEntryByPath: (path: string, rootId?: string): FSEntry | null => {
      const files = entriesByRoot[rootId ?? "root"] ?? [];
      return files.includes(path)
        ? { name: path.split("/").pop()!, path, kind: "file" }
        : null;
    },
    rootsList: () => [...roots.keys()].map((id) => ({ id, name: id })),
    showHiddenEntries: () => false,
    addRoot: () => {},
    setSelectedRootId: () => {},
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
  });
  return { navigation, loaded, fragments };
}

describe("createNavigation.handleNavigate — links .html sem irmão .adoc", () => {
  beforeEach(() => {
    toasts.length = 0;
  });

  it("abre o .html quando o .adoc irmão não existe", async () => {
    const { navigation, loaded } = makeNavigation({
      root: ["diagrams/arquitetura.html"],
    });
    await navigation.handleNavigate("diagrams/arquitetura.adoc", "secao");
    expect(loaded.map((call) => call.entry.path)).toEqual(["diagrams/arquitetura.html"]);
    expect(toasts).toEqual([]);
  });

  it("prefere o .adoc quando ele existe ao lado do .html", async () => {
    const { navigation, loaded } = makeNavigation({
      root: ["diagrams/arquitetura.adoc", "diagrams/arquitetura.html"],
    });
    await navigation.handleNavigate("diagrams/arquitetura.adoc", "secao");
    expect(loaded.map((call) => call.entry.path)).toEqual(["diagrams/arquitetura.adoc"]);
    expect(toasts).toEqual([]);
  });

  it("mantém a falha anterior quando nenhum dos dois existe", async () => {
    const { navigation, loaded, fragments } = makeNavigation({ root: [] });
    await navigation.handleNavigate("diagrams/arquitetura.adoc", "secao");
    expect(loaded).toEqual([]);
    expect(toasts).toEqual([
      { title: "File not found", description: "diagrams/arquitetura.adoc", duration: 4000 },
    ]);
    expect(fragments).toEqual(["secao"]);
  });

  it("mantém o fragmento quando o fallback .html abre", async () => {
    const { navigation, fragments, loaded } = makeNavigation({
      root: ["diagrams/arquitetura.html"],
    });
    await navigation.handleNavigate("diagrams/arquitetura.adoc", "secao");
    expect(fragments).toEqual(["secao"]);
    expect(loaded.map((call) => call.entry.path)).toEqual(["diagrams/arquitetura.html"]);
  });

  it("acha o .html em outra raiz aberta", async () => {
    const { navigation, loaded } = makeNavigation({
      root: [],
      docs: ["diagrams/arquitetura.html"],
    });
    await navigation.handleNavigate("diagrams/arquitetura.adoc");
    expect(loaded.map((call) => [call.entry.path, call.rootId])).toEqual([
      ["diagrams/arquitetura.html", "docs"],
    ]);
  });

  it("acha o .html de um link relativo com ../", async () => {
    const { navigation, loaded } = makeNavigation({
      root: ["../diagrams/arquitetura.html"],
    });
    await navigation.handleNavigate("../diagrams/arquitetura.adoc");
    expect(loaded.map((call) => call.entry.path)).toEqual(["../diagrams/arquitetura.html"]);
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
