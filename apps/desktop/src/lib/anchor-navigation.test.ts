import { beforeEach, describe, expect, it, mock } from "bun:test";
import { buildAnchorIndex } from "@markdraw/core/asciidoc-anchors.ts";
import type { FragmentSource } from "@markdraw/ui/composables/create-app-state.ts";
import type { AnchorIndexState } from "./anchor-navigation.ts";
import type { QualifiedPath } from "@markdraw/core/types.ts";

interface ToastOptions {
  title?: string;
  description?: string;
  duration?: number;
}

const toasts: ToastOptions[] = [];
mock.module("@markdraw/ui/components/ui/toast.tsx", () => ({
  showToast: (options: ToastOptions) => { toasts.push(options); },
}));

const { createAnchorNavigation } = await import("./anchor-navigation.ts");

const index = buildAnchorIndex([
  { rootId: "root", rootName: "root", path: "index.adoc", content: "[[intro]]" },
  { rootId: "root", rootName: "root", path: "chapters/one.adoc", content: "[[intro]]" },
  { rootId: "other", rootName: "other", path: "elsewhere.adoc", content: "[[intro]]" },
]);
const source: FragmentSource = {
  id: "intro", rootId: "root", path: "index.adoc", paneId: "pane-1", tabId: "tab-index",
};

function paneFor(from: FragmentSource) {
  return {
    paneId: from.paneId,
    selectedFile: () => ({ name: from.path, path: from.path, kind: "file" as const }),
    tabs: { getActiveTab: () => ({ id: from.tabId, rootId: from.rootId, filePath: from.path }) },
  };
}

function setup(
  getState: () => AnchorIndexState = () => ({ index, pending: null }),
  getActivePane = () => paneFor(source),
) {
  const navigations: Array<{ target: QualifiedPath; fragment: string }> = [];
  const handle = createAnchorNavigation({
    getState,
    getActivePane,
    navigate: (target, fragment) => { navigations.push({ target, fragment }); },
  });
  return { handle, navigations };
}

describe("createAnchorNavigation", () => {
  beforeEach(() => { toasts.length = 0; });

  it("navega com o caminho qualificado do arquivo da âncora e o id", async () => {
    const { handle, navigations } = setup();
    await handle(source);
    expect(navigations).toEqual([{
      target: { rootId: "root", path: "chapters/one.adoc" }, fragment: "intro",
    }]);
    expect(toasts).toHaveLength(0);
  });

  it("espera a montagem em curso antes de decidir", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    let state: AnchorIndexState = { index: null, pending };
    const { handle, navigations } = setup(() => state);
    const running = handle(source);
    await Promise.resolve();
    expect(navigations).toHaveLength(0);
    expect(toasts).toHaveLength(0);
    state = { index, pending: null };
    finish();
    await running;
    expect(navigations).toHaveLength(1);
  });

  it("espera a montagem mais nova se ela substituir a anterior", async () => {
    let finishOld!: () => void;
    let finishNew!: () => void;
    const oldPending = new Promise<void>((resolve) => { finishOld = resolve; });
    let state = { index: null as ReturnType<typeof buildAnchorIndex> | null, pending: oldPending };
    const { handle, navigations } = setup(() => state);
    const running = handle(source);

    const newPending = new Promise<void>((resolve) => { finishNew = resolve; });
    state = {
      index: buildAnchorIndex([
        { rootId: "root", rootName: "root", path: "other.adoc", content: "[[intro]]" },
      ]),
      pending: newPending,
    };
    finishOld();
    await Promise.resolve();
    expect(navigations).toHaveLength(0);
    finishNew();
    await running;
    expect(navigations).toEqual([{
      target: { rootId: "root", path: "other.adoc" }, fragment: "intro",
    }]);
  });

  it("mostra o aviso com título i18n e o id quando a âncora não existe", async () => {
    const { handle, navigations } = setup();
    await handle({ ...source, id: "ausente" });
    expect(navigations).toHaveLength(0);
    expect(toasts).toEqual([{
      title: "Link target not found",
      description: "ausente",
      duration: 4000,
    }]);
  });

  it("F4 ignora Markdown mesmo depois de navegar a partir de AsciiDoc", async () => {
    let reads = 0;
    const { handle, navigations } = setup(() => {
      reads++;
      return { index, pending: null };
    });
    await handle(source);
    await handle({ ...source, path: "fonte.md" });
    expect(reads).toBe(1);
    expect(navigations).toHaveLength(1);
    expect(toasts).toEqual([]);
  });

  it.each([
    ["painel ativo", { ...source, paneId: "pane-2" }],
    ["aba exibida", { ...source, tabId: "tab-other", path: "other.adoc" }],
    ["raiz da aba", { ...source, rootId: "other" }],
  ])("F5 descarta a navegação quando muda %s enquanto o índice carrega", async (_, replacement) => {
    let active = paneFor(source);
    let finish!: () => void;
    let state: AnchorIndexState = {
      index: null,
      pending: new Promise<void>((resolve) => { finish = resolve; }),
    };
    const { handle, navigations } = setup(() => state, () => active);
    const running = handle(source);
    expect(navigations).toEqual([]);
    active = paneFor(replacement);
    state = { index, pending: null };
    finish();
    await running;
    expect(navigations).toEqual([]);
    expect(toasts).toEqual([]);
  });

  // F8: the empty branch must invalidate an in-flight workspace build.
  it("F8 invalida a montagem ao fechar a última raiz", async () => {
    const code = await Bun.file(new URL("../app.tsx", import.meta.url)).text();
    const start = code.indexOf("  let anchorIndexState: AnchorIndexState");
    const end = code.indexOf("  const handleUnresolvedFragment", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const effectSource = new Bun.Transpiler({ loader: "ts" }).transformSync(
      code.slice(start, end) + "\nreturn () => anchorIndexState;",
    );
    let apply!: (input: { roots: { id: string }[]; paths: Map<string, string> }) => void;
    const reads = new Map<string, (content: string) => void>();
    const latestIndex = new Function(
      "createEffect", "state", "flattenWorkspace", "isSupportedFile", "readFileContent",
      "buildAnchorIndex", "buildBacklinkIndex", "buildWorkspaceSymbols", "setWorkspaceSymbols", effectSource,
    )(
      (_compute: unknown, run: typeof apply) => { apply = run; },
      { setBacklinkIndex() {} },
      (roots: { id: string }[]) => roots.map(({ id }) => ({ rootId: id, rootName: id, path: "target.adoc" })),
      () => true,
      (path: string) => new Promise((resolve) => { reads.set(path, resolve); }),
      buildAnchorIndex, () => new Map(), () => [], () => {},
    );

    const roots = new Map([["old", "/old"], ["new", "/new"]]);
    apply({ roots: [{ id: "old" }], paths: roots });
    const oldBuild = latestIndex().pending;
    apply({ roots: [{ id: "new" }], paths: roots });
    const newBuild = latestIndex().pending;
    reads.get("/new/target.adoc")!("[[new-id]]\n== Novo");
    await newBuild;
    reads.get("/old/target.adoc")!("[[old-id]]\n== Velho");
    await oldBuild;
    expect([...latestIndex().index.keys()]).toEqual(["new-id"]);

    apply({ roots: [{ id: "old" }], paths: roots });
    const pendingAtClose = latestIndex().pending;
    apply({ roots: [], paths: new Map() });
    expect(latestIndex().index.size).toBe(0);
    reads.get("/old/target.adoc")!("[[old-id]]\n== Velho");
    await pendingAtClose;
    expect([...latestIndex().index.keys()]).toEqual([]);
  });
});
