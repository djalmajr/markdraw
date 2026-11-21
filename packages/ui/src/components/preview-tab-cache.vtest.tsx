import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import Prism from "prismjs";

const diagrams = vi.hoisted(() => ({
  render: vi.fn(),
  release: undefined as (() => void) | undefined,
}));
vi.mock(import("../lib/mermaid-frame.ts"), async (original) => ({
  ...await original(),
  ensureMermaidWarm: async () => {},
  renderInFrame: (id: string, source: string, theme: string) => diagrams.render(id, source, theme),
}));

import { mermaidCache } from "../lib/mermaid-cache.ts";
import { flushPendingMermaid } from "../lib/mermaid-flush.ts";
import type { TabState } from "@markdraw/core/tabs.ts";
import { Preview } from "./preview.tsx";

const docs: Record<string, string> = {
  a: '<div id="toc"><ul><li><a href="#alpha">Alpha</a></li></ul></div>'
    + '<h2 id="alpha">Alpha</h2><p>Needle in A</p><a href="next.md#target">Link</a>'
    + '<pre><code class="language-js">const value = 1;</code></pre>'
    + '<div class="mermaid">a-near</div><div class="mermaid">a-far</div>',
  b: "<p>Document B</p>",
  c: "<p>Document C</p>",
  d: "<p>Document D</p>",
};

class TestObserver {
  static instances: TestObserver[] = [];
  targets = new Set<Element>();
  disconnected = false;
  constructor(private callback: IntersectionObserverCallback) { TestObserver.instances.push(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.disconnected = true; this.targets.clear(); }
  enter(target: Element) {
    this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

function rect(top: number, height = 20) {
  return DOMRect.fromRect({ x: 0, y: top, width: 500, height });
}

function mount() {
  vi.stubGlobal("IntersectionObserver", TestObserver);
  const [tabId, setTabId] = createSignal("a");
  const [html, setHtml] = createSignal(docs.a!);
  const [tabs, setTabs] = createSignal<Pick<TabState, "id" | "diskChange">[]>(Object.keys(docs).map((id) => ({ id })));
  const [theme, setTheme] = createSignal(false);
  const [version, setVersion] = createSignal(0);
  const [fragment, setFragment] = createSignal<string | null>(null);
  const [search, setSearch] = createSignal(false);
  const navigate = vi.fn();
  const handled = vi.fn();
  const toc = document.createElement("aside");
  const restore = new Map<string, { scrollTop: number; offset: number }>();
  const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
  const highlight = vi.spyOn(Prism, "highlightElement");
  const originalRect = Element.prototype.getBoundingClientRect;
  let alphaTop = 500;
  let scroller!: HTMLElement;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this === scroller) return rect(0, 200);
    if (this.matches(".mermaid")) {
      return rect(this.previousElementSibling?.matches("pre") ? 10 : 900);
    }
    if (this.id === "alpha") return rect(alphaTop - scroller.scrollTop);
    if (this.tagName === "P") return rect(250 - scroller.scrollTop);
    return originalRect.call(this);
  });
  render(() => (
    <div class="content" ref={(el) => {
      scroller = el;
      Object.defineProperties(el, {
        clientHeight: { configurable: true, value: 200 },
        scrollHeight: { configurable: true, value: 2000 },
      });
      el.scrollTo = (options) => { if (typeof options === "object") el.scrollTop = options.top ?? 0; };
    }}>
      <Preview
        cacheTabs={tabs()}
        darkMode={theme()}
        html={html()}
        currentTabId={tabId()}
        currentFilePath={tabId() + ".md"}
        tabActivationVersion={version()}
        getTabScrollRestore={() => restore.has(tabId()) ? {
          tabId: tabId(), path: tabId() + ".md", scrollTop: restore.get(tabId())!.scrollTop,
          anchor: { blockIndex: 0, offset: restore.get(tabId())!.offset },
        } : null}
        frontmatter={null}
        loading={false}
        findTrigger={0}
        searchOpen={search()}
        syncScrollActive={false}
        syncScrollTargetRatio={null}
        syncScrollTargetVersion={0}
        tocVisible
        wrapTables={false}
        tocContainer={toc}
        pendingFragment={fragment()}
        onFragmentHandled={handled}
        onNavigate={navigate}
        onScrollRatioChange={() => {}}
        onSearchOpenChange={setSearch}
        onTocChange={() => {}}
      />
    </div>
  ));
  return {
    article: () => scroller.querySelector<HTMLElement>(".doc-body")!,
    scroller, parse, highlight, toc, navigate, handled, restore, setSearch,
    reflowAlpha: (top: number) => { alphaTop = top; },
    setTheme: (dark: boolean) => {
      document.documentElement.classList.toggle("dark", dark);
      setTheme(dark);
      flush();
    },
    close: (id: string) => { setTabs((list) => list.filter((tab) => tab.id !== id)); flush(); },
    reopen: (id: string) => { setTabs((list) => [...list, { id }]); flush(); },
    markStale: (id: string) => {
      setTabs((list) => list.map((tab) => tab.id === id ? { id, diskChange: Symbol() } : tab));
      flush();
    },
    clearStale: (id: string) => {
      setTabs((list) => list.map((tab) => tab.id === id ? { id } : tab));
      flush();
    },
    switchTo: (id: string, nextHtml = docs[id]!, pending: string | null = null) => {
      setTabId(id);
      setHtml(nextHtml);
      setVersion((n) => n + 1);
      setFragment(pending);
      flush();
    },
  };
}

afterEach(() => {
  cleanup();
  diagrams.release?.();
  diagrams.release = undefined;
  diagrams.render.mockReset();
  TestObserver.instances.length = 0;
  document.documentElement.classList.remove("dark");
  mermaidCache.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function svg(id: string) {
  return { svg: `<svg id="${id}" viewBox="0 0 10 10"><text>diagram</text></svg>` };
}

describe("Preview cache per tab", () => {
  it("reattaches the article, TOC, click handlers, search, observer and export flush without reprocessing completed blocks", async () => {
    diagrams.render.mockImplementation(svg);
    const view = mount();
    await waitFor(() => expect(view.article().querySelector(".mermaid svg")).not.toBeNull());
    const article = view.article();
    const toc = view.toc.querySelector("#toc");
    const far = article.querySelectorAll(".mermaid")[1]!;
    const originalObserver = TestObserver.instances.find((observer) => observer.targets.has(far))!;
    const highlightCount = view.highlight.mock.calls.length;
    expect(highlightCount).toBe(1);
    expect(diagrams.render.mock.calls.map((call) => call[1])).toEqual(["a-near"]);
    view.restore.set("a", { scrollTop: 137, offset: 363 });
    view.switchTo("b");
    expect(article.isConnected).toBe(false);
    expect(originalObserver.disconnected).toBe(true);
    expect(view.toc.textContent).toBe("");
    const parseCount = view.parse.mock.calls.filter(([text]) => text === docs.a).length;
    view.switchTo("a");
    expect(view.article()).toBe(article);
    expect(view.scroller.scrollTop).toBe(137);
    expect(view.toc.querySelector("#toc")).toBe(toc);
    expect(view.parse.mock.calls.filter(([text]) => text === docs.a)).toHaveLength(parseCount);
    expect(view.highlight).toHaveBeenCalledTimes(highlightCount);
    expect(diagrams.render.mock.calls.map((call) => call[1])).toEqual(["a-near"]);
    await waitFor(() => expect(TestObserver.instances.some((observer) => observer !== originalObserver && observer.targets.has(far))).toBe(true));
    await flushPendingMermaid();
    expect(diagrams.render.mock.calls.map((call) => call[1])).toEqual(["a-near", "a-far"]);
    fireEvent.click(article.querySelector('a[href="next.md#target"]')!);
    expect(view.navigate).toHaveBeenCalledWith("next.md", "target");
    view.scroller.scrollTop = 500;
    fireEvent.scroll(view.scroller);
    expect(toc?.querySelector(".toc-active")?.getAttribute("href")).toBe("#alpha");

    view.setSearch(true);
    flush();
    fireEvent.input(document.querySelector(".search-input")!, { target: { value: "Needle" } });
    await waitFor(() => expect(article.querySelector("mark")?.textContent).toBe("Needle"));
  });

  it("keeps the open search and reapplies its options when changing articles", async () => {
    diagrams.render.mockImplementation(svg);
    const view = mount();
    const articleA = view.article();
    const highlights = (article: HTMLElement) =>
      Array.from(article.querySelectorAll("mark.search-highlight"), (mark) => mark.textContent);
    view.setSearch(true);
    flush();
    const input = () => document.querySelector<HTMLInputElement>(".search-input")!;
    fireEvent.input(input(), { target: { value: "Needle" } });
    fireEvent.click(document.querySelector('button[aria-label="Ignore case"]')!);
    fireEvent.click(document.querySelector('button[aria-label="Ignore accents"]')!);
    await waitFor(() => expect(highlights(articleA)).toEqual(["Needle"]));

    view.switchTo("b", "<p>Needle needle Néedle Needle</p>");
    const articleB = view.article();
    expect(articleB).not.toBe(articleA);
    expect(input().value).toBe("Needle");
    expect(highlights(articleA)).toEqual([]);
    await waitFor(() => expect(highlights(articleB)).toEqual(["Needle", "Needle"]));

    view.restore.set("a", { scrollTop: 137, offset: 363 });
    view.switchTo("a");
    expect(view.article()).toBe(articleA);
    expect(input().value).toBe("Needle");
    expect(highlights(articleB)).toEqual([]);
    await waitFor(() => expect(highlights(articleA)).toEqual(["Needle"]));
    expect(view.scroller.scrollTop).toBe(137);
  });

  it("restores the saved block offset after a parked article reflows", () => {
    diagrams.render.mockImplementation(svg);
    const view = mount();
    const article = view.article();
    view.scroller.scrollTop = 480;
    const block = article.querySelector("#alpha")!;
    const offset = block.getBoundingClientRect().top - view.scroller.getBoundingClientRect().top;
    view.restore.set("a", { scrollTop: 480, offset });
    view.switchTo("b");
    view.reflowAlpha(800);
    view.switchTo("a");

    expect(view.article()).toBe(article);
    expect(view.scroller.scrollTop).toBe(780);
    expect(block.getBoundingClientRect().top - view.scroller.getBoundingClientRect().top).toBe(offset);
  });

  it("keeps the three most recently visited articles and evicts a closed tab", async () => {
    diagrams.render.mockImplementation(svg);
    const view = mount();
    const a = view.article().querySelector("p");
    view.switchTo("b");
    const b = view.article().querySelector("p");
    view.switchTo("c");
    view.switchTo("a");
    expect(view.article().querySelector("p")).toBe(a);
    view.switchTo("d");
    view.switchTo("b");
    expect(view.article().querySelector("p")).not.toBe(b);
    view.close("a");
    view.reopen("a");
    view.switchTo("a");
    expect(view.article().querySelector("p")).not.toBe(a);
  });

  it("rejects a cached article when HTML has changed and gives a fragment priority on a cache hit", async () => {
    diagrams.render.mockImplementation(svg);
    const view = mount();
    const oldArticle = view.article();
    view.switchTo("b");
    view.switchTo("a", '<p id="alpha">Updated</p>');
    expect(view.article()).not.toBe(oldArticle);
    expect(view.article().textContent).toContain("Updated");
    const updatedArticle = view.article();
    view.switchTo("b");
    view.restore.set("a", { scrollTop: 137, offset: 363 });
    view.switchTo("a", '<p id="alpha">Updated</p>', "alpha");
    expect(view.article()).toBe(updatedArticle);
    await waitFor(() => expect(view.handled).toHaveBeenCalledOnce());
    expect(view.scroller.scrollTop).toBe(484);
  });

  it("evicts a disk-invalidated article even when reconversion returns identical HTML", async () => {
    diagrams.render.mockImplementation(svg);
    const view = mount();
    const article = view.article();
    view.switchTo("b");
    view.markStale("a");
    view.clearStale("a");
    view.switchTo("a");
    expect(view.article()).not.toBe(article);
    expect(view.article().querySelector("#alpha")).not.toBeNull();
  });

  it("drops a parked article on theme change", async () => {
    diagrams.render.mockImplementation(svg);
    const view = mount();
    const a = view.article();
    await waitFor(() => expect(diagrams.render.mock.calls.some((call) => call[2] === "default")).toBe(true));
    view.switchTo("b");
    view.setTheme(true);
    view.switchTo("a");
    expect(view.article()).not.toBe(a);
    await waitFor(() => expect(diagrams.render.mock.calls.some((call) => call[1] === "a-near" && call[2] === "dark")).toBe(true));
  });

  it("stops the departed generation and rejects its late publication", async () => {
    diagrams.render.mockImplementation((id: string, source: string) => source === "a-near"
      ? new Promise((resolve) => { diagrams.release = () => resolve(svg(id)); })
      : svg(id));
    const view = mount();
    await waitFor(() => expect(diagrams.release).toBeDefined());
    const oldArticle = view.article();
    const far = oldArticle.querySelectorAll(".mermaid")[1]!;
    const oldObserver = TestObserver.instances.find((observer) => observer.targets.has(far))!;
    oldObserver.enter(far);
    view.switchTo("b");
    expect(oldObserver.disconnected).toBe(true);
    diagrams.release?.();
    await flushPendingMermaid();
    expect(diagrams.render.mock.calls.map((call) => call[1])).toEqual(["a-near"]);
    expect(oldArticle.querySelector("svg")).toBeNull();
    expect(view.article().textContent).toBe("Document B");
  });
});
