import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { cleanup, render } from "@solidjs/testing-library";

const mermaidCtl = vi.hoisted(() => ({ hold: false, pending: [] as Array<() => void> }));
vi.mock(import("../lib/mermaid-frame.ts"), async (original) => ({
  ...await original(),
  ensureMermaidWarm: async () => {},
  renderInFrame: async (id: string) => {
    const result = { svg: `<svg id="${id}" viewBox="0 0 10 10"></svg>` };
    if (!mermaidCtl.hold) return result;
    return new Promise((resolve) => { mermaidCtl.pending.push(() => resolve(result)); });
  },
}));
vi.mock("@markdraw/core/kroki.ts", () => ({
  renderKroki: async () => '<svg viewBox="0 0 10 10"></svg>',
}));

import type { PreviewScrollAnchor } from "@markdraw/core/tabs.ts";
import { createPaneStore, type PaneStore } from "../composables/create-pane-store.ts";
import { mermaidCache } from "../lib/mermaid-cache.ts";
import { Preview } from "./preview.tsx";

interface Restore {
  tabId: string;
  path: string;
  scrollTop: number;
  anchor: PreviewScrollAnchor | null;
}

const BLOCK_TOPS = [0, 200, 400, 600, 800];
const DOC = BLOCK_TOPS
  .map((top, index) => `<p data-block="${index}" id="block-${index}">block ${index} @ ${top}</p>`)
  .join("");

function rect(top: number, bottom: number): DOMRect {
  return {
    top, bottom, left: 0, right: 100, width: 100, height: bottom - top,
    x: 0, y: top, toJSON: () => ({}),
  } as DOMRect;
}

function installLayout(scroller: HTMLElement, writes: number[]) {
  const state = { top: 0 };
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => state.top,
    set: (value: number) => { state.top = value; writes.push(value); },
  });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
  scroller.getBoundingClientRect = () => rect(0, 200);
  scroller.scrollTo = ((options?: ScrollToOptions) => {
    if (options?.top !== undefined) scroller.scrollTop = options.top;
  }) as typeof scroller.scrollTo;

  const nativeRect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this === scroller) return rect(0, 200);
    if (this.classList.contains("doc-body")) return rect(-state.top, 1000 - state.top);
    const parent = this.parentElement;
    if (parent?.classList.contains("doc-body")) {
      const index = Number((this as HTMLElement).dataset.block ?? 0);
      const top = (BLOCK_TOPS[index] ?? index * 200) - state.top;
      return rect(top, top + 100);
    }
    return nativeRect.call(this);
  });
  return scroller;
}

function mount(pane?: PaneStore) {
  const writes: number[] = [];
  const [html, setHtml] = createSignal("");
  const [tabId, setTabId] = createSignal<string | null>(null);
  const [activationVersion, setActivationVersion] = createSignal(0);
  const [restore, setRestore] = createSignal<Restore | null>(null);
  const [fragment, setFragment] = createSignal<string | null>(null);
  let scroller!: HTMLElement;
  render(() => (
    <div class="content" ref={(element) => { scroller = installLayout(element, writes); }}>
      <Preview
        findTrigger={0}
        html={pane ? pane.html() : html()}
        frontmatter={null}
        loading={false}
        searchOpen={false}
        syncScrollActive={false}
        syncScrollTargetRatio={null}
        syncScrollTargetVersion={0}
        tocVisible={false}
        wrapTables={false}
        currentFilePath={pane ? pane.selectedFile()?.path ?? null : "doc.md"}
        currentTabId={pane ? pane.tabs.activeTabId() : tabId()}
        tabActivationVersion={pane ? pane.tabs.activationVersion() : activationVersion()}
        getTabScrollRestore={() => {
          if (!pane) return restore();
          const tab = pane.tabs.getActiveTab();
          return tab ? {
            tabId: tab.id, path: tab.filePath, scrollTop: tab.previewScrollTop, anchor: tab.previewScrollAnchor,
          } : null;
        }}
        pendingFragment={fragment()}
        onNavigate={() => {}}
        onScrollRatioChange={() => {}}
        onSearchOpenChange={() => {}}
        onTocChange={() => {}}
        onFragmentHandled={() => {}}
      />
    </div>
  ));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 50));
  return {
    scroller,
    writes,
    tick,
    setTop: (value: number) => { scroller.scrollTop = value; },
    setRestore: (next: Restore | null) => { setRestore(next); },
    rename: (id: string) => { setTabId(id); },
    load: async (id: string | null, next: Restore | null, fragmentId: string | null = null) => {
      setHtml("");
      flush();
      setTabId(id);
      setActivationVersion((version) => version + 1);
      setRestore(next);
      setFragment(fragmentId);
      setHtml(DOC);
      flush();
      await tick();
    },
    queueLoad: (id: string | null, next: Restore | null) => {
      setHtml("");
      flush();
      setTabId(id);
      setActivationVersion((version) => version + 1);
      setRestore(next);
      setHtml(DOC);
      flush();
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Preview — scroll position per tab", () => {
  it("rodada 2 F2 — restaura cada aba em cache com HTML idêntico e preserva a posição ao renomear", async () => {
    const pane = createPaneStore("identical-html");
    try {
      const view = mount(pane);
      const a = { kind: "file", name: "a.md", path: "a.md" } as const;
      const b = { kind: "file", name: "b.md", path: "b.md" } as const;
      const tabA = pane.tabs.openTab(a, "root", { background: true });
      const tabB = pane.tabs.openTab(b, "root", { background: true });
      pane.tabs.updateTabContent(tabA, { html: DOC });
      pane.tabs.updateTabContent(tabB, { html: DOC });
      flush();

      const activate = async (tabId: string, file: typeof a | typeof b) => {
        pane.tabs.activateTab(tabId);
        pane.setSelectedFile(file);
        flush();
        await view.tick();
        expect(pane.html()).toBe(DOC);
      };
      await activate(tabA, a);
      view.setTop(408);
      pane.tabs.snapshotActiveTab({ previewScrollTop: 408, previewScrollAnchor: { blockIndex: 2, offset: -8 } });
      await activate(tabB, b);
      view.setTop(608);
      pane.tabs.snapshotActiveTab({ previewScrollTop: 608, previewScrollAnchor: { blockIndex: 3, offset: -8 } });
      await activate(tabA, a);
      expect(view.scroller.querySelector("#block-2")!.getBoundingClientRect().top).toBe(-8);
      await activate(tabB, b);
      expect(view.scroller.querySelector("#block-3")!.getBoundingClientRect().top).toBe(-8);

      view.setTop(700);
      pane.tabs.updateTabFile(tabB, "renamed.md", "renamed.md");
      pane.setSelectedFile({ kind: "file", name: "renamed.md", path: "renamed.md" });
      flush();
      await view.tick();
      expect(view.scroller.scrollTop).toBe(700);
    } finally {
      pane.tabs.discardSession();
    }
  });

  it("restores the stored anchor block at the same offset when returning to a tab", async () => {
    const view = mount();
    await view.load("tab-a", null);
    view.setTop(720);
    await view.load("tab-b", null);
    view.setTop(0);
    await view.load("tab-a", {
      tabId: "tab-a",
      path: "doc.md",
      scrollTop: 100,
      anchor: { blockIndex: 4, offset: 80 },
    });
    expect(view.scroller.scrollTop).toBe(720);
  });

  it("falls back to the clamped scrollTop when the anchor does not exist", async () => {
    const view = mount();
    view.setTop(0);
    await view.load("tab-b", {
      tabId: "tab-b",
      path: "doc.md",
      scrollTop: 350,
      anchor: { blockIndex: 99, offset: 0 },
    });
    expect(view.scroller.scrollTop).toBe(350);
  });

  it("gives a pending fragment priority over the stored position", async () => {
    const view = mount();
    view.setTop(0);
    await view.load("tab-c", {
      tabId: "tab-c",
      path: "doc.md",
      scrollTop: 500,
      anchor: null,
    }, "block-3");
    expect(view.writes).not.toContain(500);
    expect(view.scroller.scrollTop).toBe(BLOCK_TOPS[3]! - 16);
  });

  it("starts a tab without a saved position at the top, ignoring a stale restore from another tab", async () => {
    const view = mount();
    await view.load("tab-a", null);
    view.setTop(300);
    await view.load("tab-new", {
      tabId: "tab-old",
      path: "doc.md",
      scrollTop: 250,
      anchor: null,
    });
    expect(view.scroller.scrollTop).toBe(0);
  });

  it("does not restore a superseded tab when another tab is activated before the swap", async () => {
    const view = mount();
    await view.load("initial", null);
    view.queueLoad("tab-a", {
      tabId: "tab-a", path: "doc.md", scrollTop: 700, anchor: null,
    });
    view.queueLoad("tab-b", {
      tabId: "tab-b", path: "doc.md", scrollTop: 120, anchor: null,
    });
    await view.tick();
    expect(view.scroller.scrollTop).toBe(120);
  });

  it("F4 — renomear a aba ativa não reaplica a posição salva", async () => {
    const view = mount();
    await view.load("tab-a", null);
    view.setTop(720);
    view.setRestore({ tabId: "tab-a", path: "doc.md", scrollTop: 120, anchor: null });
    view.rename("tab-a-renomeada");
    // The store rekeys the snapshot when the tab id changes; the document on
    // screen is still the very same one.
    view.setRestore({ tabId: "tab-a-renomeada", path: "doc.md", scrollTop: 120, anchor: null });
    flush();
    await view.tick();
    expect(view.scroller.scrollTop).toBe(720);
  });
});

function mountWithLayout(options: {
  html: string;
  layout: (scroller: HTMLElement, writes: number[]) => void;
  tocContainer?: HTMLElement;
}) {
  const writes: number[] = [];
  const [html, setHtml] = createSignal("");
  const [tabId, setTabId] = createSignal<string | null>(null);
  const [activationVersion, setActivationVersion] = createSignal(0);
  const [restore, setRestore] = createSignal<Restore | null>(null);
  let scroller!: HTMLElement;
  render(() => (
    <div class="content" ref={(element) => { scroller = element; options.layout(element, writes); }}>
      <Preview
        findTrigger={0}
        html={html()}
        frontmatter={null}
        loading={false}
        searchOpen={false}
        syncScrollActive={false}
        syncScrollTargetRatio={null}
        syncScrollTargetVersion={0}
        tocVisible={false}
        wrapTables={false}
        tocContainer={options.tocContainer}
        currentFilePath="doc.md"
        currentTabId={tabId()}
        tabActivationVersion={activationVersion()}
        getTabScrollRestore={() => restore()}
        pendingFragment={null}
        onNavigate={() => {}}
        onScrollRatioChange={() => {}}
        onSearchOpenChange={() => {}}
        onTocChange={() => {}}
        onFragmentHandled={() => {}}
      />
    </div>
  ));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 50));
  return {
    scroller,
    writes,
    tick,
    setTop: (value: number) => { scroller.scrollTop = value; },
    setRestore: (next: Restore | null) => { setRestore(next); },
    replaceHtml: (next: string) => { setHtml(next); flush(); },
    load: async (id: string, next: Restore | null, nextHtml = options.html) => {
      setHtml("");
      flush();
      setTabId(id);
      setActivationVersion((version) => version + 1);
      setRestore(next);
      setHtml(nextHtml);
      flush();
      await tick();
    },
    queueLoad: (id: string, next: Restore | null) => {
      setHtml("");
      flush();
      setTabId(id);
      setActivationVersion((version) => version + 1);
      setRestore(next);
      setHtml(options.html);
      flush();
    },
  };
}

function scrollRig(scroller: HTMLElement, writes: number[], height: () => number, viewport = 200) {
  const state = { top: 0 };
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => state.top,
    set: (value: number) => {
      state.top = Math.max(0, Math.min(height() - viewport, value));
      writes.push(state.top);
    },
  });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: height });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: viewport });
  scroller.getBoundingClientRect = () => rect(0, viewport);
  scroller.scrollTo = ((options?: ScrollToOptions) => {
    if (options?.top !== undefined) scroller.scrollTop = options.top;
  }) as typeof scroller.scrollTo;
  return state;
}

describe("Preview — Classes da revisão de rolagem por aba", () => {
  afterEach(() => {
    mermaidCache.clear();
    mermaidCtl.hold = false;
    mermaidCtl.pending.length = 0;
  });

  it("F1 — restaura a âncora depois de mover o sumário para fora do artigo", async () => {
    const tocContainer = document.createElement("aside");
    document.body.appendChild(tocContainer);
    try {
      const html = `<nav id="toc"><a href="#p2">sumário</a></nav>`
        + [0, 1, 2, 3].map((i) => `<p id="p${i}">parágrafo ${i}</p>`).join("");
      const view = mountWithLayout({
        html,
        tocContainer,
        layout: (scroller, writes) => {
          scrollRig(scroller, writes, () => 4000);
          const nativeRect = Element.prototype.getBoundingClientRect;
          vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
            if (this === scroller) return rect(0, 200);
            const article = this.parentElement;
            if (article?.classList.contains("doc-body")) {
              const top = article.querySelector("#toc")
                ? (Array.prototype.indexOf.call(article.children, this) === 0
                  ? 0 : 100 + (Array.prototype.indexOf.call(article.children, this) - 1) * 200)
                : Array.prototype.indexOf.call(article.children, this) * 200;
              return rect(top - scroller.scrollTop, top - scroller.scrollTop + 100);
            }
            return nativeRect.call(this);
          });
        },
      });
      await view.load("tab-a", null);
      const article = view.scroller.querySelector<HTMLElement>(".doc-body")!;
      expect(article.querySelector("#toc")).toBeNull();
      expect(tocContainer.querySelector("#toc")).not.toBeNull();
      expect(Array.from(article.children).map((child) => child.id)).toEqual(["p0", "p1", "p2", "p3"]);

      view.setTop(408);
      const offset = article.children[2]!.getBoundingClientRect().top - view.scroller.getBoundingClientRect().top;
      expect(offset).toBe(-8);
      await view.load("tab-b", null);
      await view.load("tab-a", {
        tabId: "tab-a", path: "doc.md", scrollTop: 408, anchor: { blockIndex: 2, offset },
      });
      expect(view.scroller.scrollTop).toBe(408);
    } finally {
      tocContainer.remove();
    }
  });

  it("rodada 2 F1 — mantém o bloco a −8 px no fim do documento após quatro diagramas", async () => {
    const diagrams = 4;
    const viewport = 500;
    const rawHeight = 60;
    const placeholderHeight = 120;
    const diagramHeight = 420;
    const html = Array.from({ length: diagrams }, (_, index) =>
      `<div class="mermaid">graph TD; A--&gt;B${index}</div>`).join("")
      + '<p id="saved-block">bloco salvo</p>';
    const view = mountWithLayout({
      html,
      layout: (scroller, writes) => {
        const heightOf = (block: Element) => {
          if (!block.matches(".mermaid")) return viewport + 8;
          if (block.querySelector("svg")) return diagramHeight;
          return block.hasAttribute("data-mermaid-pending") ? placeholderHeight : rawHeight;
        };
        const totalHeight = () => Array.from(scroller.querySelectorAll(".doc-body > *"))
          .reduce((height, block) => height + heightOf(block), 0);
        scrollRig(scroller, writes, totalHeight, viewport);
        const nativeRect = Element.prototype.getBoundingClientRect;
        vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
          if (this.parentElement?.classList.contains("doc-body")) {
            let top = -scroller.scrollTop;
            for (let sibling = this.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
              top += heightOf(sibling);
            }
            return rect(top, top + heightOf(this));
          }
          return nativeRect.call(this);
        });
      },
    });
    const bottom = () => view.scroller.scrollHeight - view.scroller.clientHeight;
    const offset = () => view.scroller.querySelector("#saved-block")!.getBoundingClientRect().top
      - view.scroller.getBoundingClientRect().top;
    const rendered = () => view.scroller.querySelectorAll(".mermaid svg").length;
    await view.load("diagrama", null);
    await vi.waitFor(() => expect(rendered()).toBe(diagrams));
    view.setTop(bottom());
    const savedTop = view.scroller.scrollTop;
    const savedOffset = offset();
    expect(savedOffset).toBe(-8);
    await view.load("outro", null, "<p>outro documento</p>");

    mermaidCache.clear();
    mermaidCtl.hold = true;
    const firstRestoreWrite = view.writes.length;
    view.queueLoad("diagrama", {
      tabId: "diagrama", path: "doc.md", scrollTop: savedTop, anchor: { blockIndex: diagrams, offset: savedOffset },
    });
    await vi.waitFor(() => expect(mermaidCtl.pending).toHaveLength(1));
    expect(view.writes.slice(firstRestoreWrite)).toContain(diagrams * rawHeight + 8);
    for (let completed = 1; completed <= diagrams; completed++) {
      await vi.waitFor(() => expect(mermaidCtl.pending).toHaveLength(1));
      mermaidCtl.pending.shift()!();
      await vi.waitFor(() => expect(rendered()).toBe(completed));
    }
    expect(offset()).toBe(-8);
  });

  it.each(["roda", "teclado", "toque", "barra", "aba", "geração"] as const)(
    "cancela o alvo de rolagem pendente em caso de %s",
    async (interrupt) => {
      mermaidCtl.hold = true;
      const source = "graph LR";
      const html = `<div class="mermaid">${source}</div>`
        + [1, 2, 3, 4, 5].map((i) => `<p data-block="${i}" id="p${i}">parágrafo ${i}</p>`).join("");
      const view = mountWithLayout({
        html,
        layout: (scroller, writes) => {
          scrollRig(scroller, writes, () => scroller.querySelector(".mermaid svg") ? 2600 : 1200);
          const nativeRect = Element.prototype.getBoundingClientRect;
          vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
            if (this === scroller) return rect(0, 200);
            const article = this.parentElement;
            if (article?.classList.contains("doc-body")) {
              const index = Array.prototype.indexOf.call(article.children, this);
              if (index === 0) return rect(0, 100);
              const grown = !!scroller.querySelector(".mermaid svg");
              const top = index * 200 + (grown ? 1300 : 0);
              return rect(top - scroller.scrollTop, top - scroller.scrollTop + 100);
            }
            return nativeRect.call(this);
          });
        },
      });
      await view.load("sem-diagrama", null, "<p>sem diagrama</p>");
      view.queueLoad("diagrama", {
        tabId: "diagrama", path: "doc.md", scrollTop: 1008, anchor: { blockIndex: 5, offset: -8 },
      });
      for (let i = 0; i < 20 && mermaidCtl.pending.length === 0; i++) await view.tick();
      expect(mermaidCtl.pending.length).toBeGreaterThan(0);
      expect(view.scroller.scrollTop).toBe(1000);
      if (interrupt === "aba") {
        await view.load("sem-diagrama", null, "<p>outra aba</p>");
      } else if (interrupt === "geração") {
        view.replaceHtml("<p>nova geração da mesma aba</p>");
        await view.tick();
      } else if (interrupt === "teclado") {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
      } else {
        const events = { roda: "wheel", toque: "touchmove", barra: "pointerdown" };
        view.scroller.dispatchEvent(new Event(events[interrupt]));
      }
      view.setTop(600);
      const beforeDiagram = view.scroller.scrollTop;
      expect(beforeDiagram).toBe(600);
      mermaidCtl.pending.shift()!();
      if (interrupt === "aba" || interrupt === "geração") {
        await view.tick();
        expect(view.scroller.querySelector(".mermaid")).toBeNull();
      } else {
        await vi.waitFor(() => expect(view.scroller.querySelector(".mermaid svg")).not.toBeNull());
      }
      expect(view.scroller.scrollTop).toBe(beforeDiagram);
    },
  );
});
