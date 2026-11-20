import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

const ctl = vi.hoisted(() => {
  const defaultFixture = `#mermaid-1 { fill: #333 }
  #mermaid-1 p { margin: 0 }
  :root { --mermaid-font-family: inherit }`;
  return {
    fixture: defaultFixture,
    calls: [] as string[],
    ids: [] as string[],
    events: [] as string[],
    mode: "resolve" as "resolve" | "pending",
    pending: [] as Array<() => void>,
    reset() {
      this.fixture = defaultFixture;
      this.calls.length = 0;
      this.ids.length = 0;
      this.events.length = 0;
      this.mode = "resolve";
      this.pending.length = 0;
    },
  };
});

vi.mock("mermaid", () => ({
  default: {
    initialize: () => {},
    render: (id: string, source: string) => {
      if (id === "mermaid-prewarm") return Promise.resolve({ svg: '<svg viewBox="0 0 10 10"></svg>' });
      ctl.calls.push(source);
      ctl.ids.push(id);
      ctl.events.push(`render:${source}`);
      const css = ctl.fixture.replaceAll("#mermaid-1", `#${id}`);
      const svg = `<svg id="${id}" viewBox="0 0 10 20"><style>${css}</style><text>${source}</text></svg>`;
      if (ctl.mode === "pending") {
        return new Promise<{ svg: string }>((resolve) => {
          ctl.pending.push(() => resolve({ svg }));
        });
      }
      return Promise.resolve({ svg });
    },
  },
}));

vi.mock("@markdraw/core/kroki.ts", () => ({ renderKroki: async () => '<svg viewBox="0 0 10 10"></svg>' }));

import { Preview } from "./preview.tsx";
import { mermaidCache, mermaidCacheKey } from "../lib/mermaid-cache.ts";
import { createMermaidLazyRenderer } from "../lib/mermaid-lazy.ts";
import { flushPendingMermaid } from "../lib/mermaid-flush.ts";

class FakeIO {
  static instances: FakeIO[] = [];
  readonly targets = new Set<Element>();
  readonly root: Element | null;
  readonly rootMargin: string;
  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.root = (options?.root as Element | null) ?? null;
    this.rootMargin = options?.rootMargin ?? "";
    FakeIO.instances.push(this);
  }
  disconnected = false;
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.disconnected = true; this.targets.clear(); }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  emit(targets: Element[], isIntersecting: boolean) {
    const entries = targets.map((target) => ({
      target,
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0,
      boundingClientRect: target.getBoundingClientRect(),
    })) as IntersectionObserverEntry[];
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

// happy-dom's CSSStyleRule.selectorText has no setter; inject the smallest
// mutable CSSOM so the CSS-sharing path runs in this suite too.
class StubRule {
  selectorText: string | undefined;
  readonly cssRules: StubRule[] = [];
  constructor(readonly prelude: string, readonly body: string) {
    this.selectorText = prelude.startsWith("@") ? undefined : prelude;
  }
  get cssText(): string {
    return this.selectorText !== undefined
      ? `${this.selectorText} { ${this.body} }`
      : `${this.prelude} { ${this.cssRules.map((rule) => rule.cssText).join(" ")} }`;
  }
}
class StubCSSStyleSheet {
  cssRules: StubRule[] = [];
  replaceSync(css: string): void {
    const rules: StubRule[] = [];
    let i = 0;
    while (i < css.length) {
      const open = css.indexOf("{", i);
      if (open < 0) break;
      const close = css.indexOf("}", open);
      if (close < 0) break;
      rules.push(new StubRule(css.slice(i, open).trim(), css.slice(open + 1, close).trim()));
      i = close + 1;
    }
    this.cssRules = rules;
  }
}

class FakeRO {
  static instances: FakeRO[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeRO.instances.push(this);
  }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  emit() { this.callback([], this as unknown as ResizeObserver); }
}

function rect(top: number, bottom: number) {
  return {
    top, bottom, left: 0, right: 100, width: 100, height: bottom - top,
    x: 0, y: top, toJSON: () => ({}),
  } as DOMRect;
}

function place(el: Element, top: number, bottom: number) {
  el.getBoundingClientRect = () => rect(top, bottom);
}

function props(over: Record<string, unknown> = {}) {
  return {
    html: "",
    frontmatter: null,
    loading: false,
    searchOpen: false,
    syncScrollActive: false,
    syncScrollTargetRatio: null,
    syncScrollTargetVersion: 0,
    tocVisible: false,
    wrapTables: false,
    findTrigger: 0,
    currentFilePath: "doc.md",
    pendingFragment: null,
    onNavigate: () => {},
    onScrollRatioChange: () => {},
    onSearchOpenChange: () => {},
    onTocChange: () => {},
    onFragmentHandled: () => {},
    ...over,
  };
}

const doc = (...sources: string[]) => sources.map((s) => `<div class="mermaid">${s}</div>`).join("");
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  ctl.reset();
  mermaidCache.clear();
  document.documentElement.classList.remove("dark");
  FakeIO.instances.length = 0;
  FakeRO.instances.length = 0;
  vi.stubGlobal("IntersectionObserver", FakeIO);
  vi.stubGlobal("ResizeObserver", FakeRO);
  vi.stubGlobal("CSSStyleSheet", StubCSSStyleSheet);
});

afterEach(() => {
  cleanup();
  mermaidCache.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Preview — Mermaid sob demanda", () => {
  it("só chama render para diagramas visíveis; o observer desenha o que entra na margem", async () => {
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.appendChild(scroller);
    try {
      render(() => <Preview {...props({ html: doc("A", "B") })} />, { container: scroller });
      const blocks = Array.from(scroller.querySelectorAll<HTMLElement>(".mermaid"));
      place(scroller, 0, 200);
      place(blocks[0]!, 10, 60);
      place(blocks[1]!, 1000, 1050);
      await waitFor(() => expect(ctl.calls).toEqual(["A"]));
      await tick(40);
      expect(ctl.calls).toEqual(["A"]);
      expect(blocks[1]!.textContent).toContain("Rendering diagram...");
      expect(FakeIO.instances.at(-1)?.rootMargin).toBe("200px 0px");
      expect(FakeIO.instances.at(-1)?.root).toBe(scroller);

      FakeIO.instances.at(-1)!.emit([blocks[1]!], true);
      await waitFor(() => expect(ctl.calls).toEqual(["A", "B"]));
      await waitFor(() => expect(blocks[1]!.querySelector("svg")).not.toBeNull());
    } finally {
      scroller.remove();
    }
  });

  it("devolve o controle ao event loop entre dois renders", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) => {
      if (ms === 0) ctl.events.push("macrotask");
      return nativeSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.appendChild(scroller);
    try {
      render(() => <Preview {...props({ html: doc("A", "B") })} />, { container: scroller });
      const blocks = Array.from(scroller.querySelectorAll<HTMLElement>(".mermaid"));
      place(scroller, 0, 200);
      place(blocks[0]!, 10, 50);
      place(blocks[1]!, 60, 100);
      await waitFor(() => expect(ctl.calls).toEqual(["A", "B"]));
      expect(ctl.events).toEqual(["render:A", "macrotask", "render:B"]);
    } finally {
      scroller.remove();
    }
  });

  it("insere o SVG sem <style>, com a classe no root, e compartilha uma folha por CSS", async () => {
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.appendChild(scroller);
    try {
      render(() => <Preview {...props({ html: doc("A", "B") })} />, { container: scroller });
      const blocks = Array.from(scroller.querySelectorAll<HTMLElement>(".mermaid"));
      place(scroller, 0, 200);
      place(blocks[0]!, 10, 50);
      place(blocks[1]!, 60, 100);
      await waitFor(() => expect(scroller.querySelectorAll(".mermaid svg")).toHaveLength(2));

      const styles = Array.from(scroller.querySelectorAll<HTMLStyleElement>("style[data-mermaid-css]"));
      expect(styles).toHaveLength(1);
      for (const block of blocks) {
        expect(block.innerHTML).not.toContain("<style");
        const svg = block.querySelector("svg")!;
        expect(svg.getAttribute("class")).toMatch(/^mermaid-css-[0-9a-f]{8}$/);
        expect(svg.getAttribute("class")).toBe(styles[0]!.getAttribute("data-mermaid-css"));
      }
      expect(styles[0]!.textContent).toContain(`.${styles[0]!.getAttribute("data-mermaid-css")} p`);
      expect(styles[0]!.textContent).toContain(":root { --mermaid-font-family: inherit }");
      expect(styles[0]!.textContent).not.toContain("#mermaid-");
    } finally {
      scroller.remove();
    }
  });

  it("trocar o html cancela um diagrama que ainda não começou a desenhar", async () => {
    ctl.mode = "pending";
    const [html, setHtml] = createSignal(doc("A", "B"));
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.appendChild(scroller);
    try {
      render(() => <Preview {...props({ html: html() })} />, { container: scroller });
      const blocks = Array.from(scroller.querySelectorAll<HTMLElement>(".mermaid"));
      place(scroller, 0, 200);
      place(blocks[0]!, 10, 50);
      place(blocks[1]!, 60, 100);
      await waitFor(() => expect(ctl.calls).toEqual(["A"]));
      setHtml("<p>outro documento</p>");
      flush();
      ctl.pending.shift()!();
      await tick(40);
      expect(ctl.calls).toEqual(["A"]);
      expect(scroller.querySelector(".mermaid")).toBeNull();
    } finally {
      scroller.remove();
    }
  });

  it("insere um SVG em cache na visibilidade, sem fila de render", async () => {
    const source = "cached";
    mermaidCache.set(mermaidCacheKey(source, "default"), '<svg id="cached" viewBox="0 0 10 10"><path /></svg>');
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.appendChild(scroller);
    try {
      render(() => <Preview {...props({ html: doc(source) })} />, { container: scroller });
      const block = scroller.querySelector<HTMLElement>(".mermaid")!;
      place(scroller, 0, 200);
      place(block, 1000, 1050);
      await tick(30);
      expect(ctl.calls).toEqual([]);
      FakeIO.instances.at(-1)!.emit([block], true);
      await waitFor(() => expect(block.querySelector("svg")).not.toBeNull());
      expect(ctl.calls).toEqual([]);
    } finally {
      scroller.remove();
    }
  });

  it("compensa o scrollTop quando um diagrama acima da área visível muda de altura", async () => {
    ctl.mode = "pending";
    let height = 20;
    const scroller = document.createElement("div");
    scroller.className = "content";
    scroller.scrollTop = 500;
    document.body.appendChild(scroller);
    try {
      render(() => <Preview {...props({ html: doc("A") })} />, { container: scroller });
      const block = scroller.querySelector<HTMLElement>(".mermaid")!;
      place(scroller, 100, 300);
      place(block, 0, 50);
      Object.defineProperty(block, "offsetHeight", {
        configurable: true,
        get: () => block.querySelector("svg") ? 60 : height,
      });
      await waitFor(() => expect(ctl.calls).toEqual(["A"]));
      expect(scroller.scrollTop).toBe(500);
      ctl.pending.shift()!();
      await waitFor(() => expect(block.querySelector("svg")).not.toBeNull());
      expect(scroller.scrollTop).toBe(540);
    } finally {
      scroller.remove();
    }
  });

  it("assenta o pós-processamento sem esperar um diagrama fora da tela", async () => {
    ctl.mode = "pending";
    const discarded = vi.fn();
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.appendChild(scroller);
    try {
      render(() => (
        <Preview {...props({
          html: doc("A", "B") + '<h1 id="a">A</h1>',
          currentFilePath: "settled.md",
          pendingFragment: "inexistente",
          onFragmentDiscarded: discarded,
        })}
        />
      ), { container: scroller });
      const blocks = Array.from(scroller.querySelectorAll<HTMLElement>(".mermaid"));
      place(scroller, 0, 200);
      place(blocks[0]!, 10, 50);
      place(blocks[1]!, 1000, 1050);
      await waitFor(() => expect(ctl.calls).toEqual(["A"]));
      await tick(20);
      expect(discarded).not.toHaveBeenCalled();
      expect(ctl.calls).not.toContain("B");

      ctl.pending.shift()!();
      await waitFor(() => expect(discarded).toHaveBeenCalledWith("inexistente"));
      expect(ctl.calls).toEqual(["A"]);
      expect(blocks[1]!.textContent).toContain("Rendering diagram...");
    } finally {
      scroller.remove();
    }
  });

  it("F1: um bloco resolvido no caminho síncrono não entra na contagem inicial", async () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    const calls: string[] = [];
    let releaseA!: () => void;
    const renderer = createMermaidLazyRenderer({
      root: null,
      blocks: [a, b],
      tryImmediate: (block) => block === b,
      render: (block) => {
        calls.push(block === a ? "A" : "B");
        return new Promise<void>((resolve) => { if (block === a) releaseA = resolve; else resolve(); });
      },
    });
    let settled = false;
    void renderer.whenInitialDone().then(() => { settled = true; });
    await tick(0);
    expect(calls).toEqual(["A"]);
    expect(settled).toBe(false);
    releaseA();
    await renderer.whenInitialDone();
    expect(settled).toBe(true);
    renderer.dispose();
  });

  it("F2: a margem é em pixels da altura do painel e é recriada no resize", async () => {
    const scroller = document.createElement("div");
    scroller.className = "content";
    place(scroller, 0, 200);
    document.body.appendChild(scroller);
    try {
      render(() => <Preview {...props({ html: doc("A") })} />, { container: scroller });
      await tick(0);
      const first = FakeIO.instances.at(-1)!;
      expect(first.rootMargin).toBe("200px 0px");
      expect(first.root).toBe(scroller);

      place(scroller, 0, 400);
      const ro = FakeRO.instances.find((item) => item.targets.has(scroller))!;
      expect(ro).toBeDefined();
      ro.emit();
      await tick(0);
      const second = FakeIO.instances.at(-1)!;
      expect(second).not.toBe(first);
      expect(first.disconnected).toBe(true);
      expect(second.rootMargin).toBe("400px 0px");
      expect(second.root).toBe(scroller);
    } finally {
      scroller.remove();
    }
  });

  it("F3: dispose cancela o timer da fila e não inicia o próximo render", async () => {
    const liveTimers = new Set<ReturnType<typeof setTimeout>>();
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) => {
      const id = nativeSetTimeout(fn, ms, ...args);
      if (ms === 0) liveTimers.add(id);
      return id;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(((id: ReturnType<typeof setTimeout>) => {
      liveTimers.delete(id);
      return nativeClearTimeout(id);
    }) as typeof clearTimeout);
    const calls: string[] = [];
    const blocks = [document.createElement("div"), document.createElement("div")];
    const renderer = createMermaidLazyRenderer({
      root: null,
      blocks,
      render: (block) => {
        calls.push(block === blocks[0] ? "A" : "B");
        return Promise.resolve();
      },
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(calls).toEqual(["A"]);
    expect(liveTimers.size).toBe(1);
    renderer.dispose();
    expect(liveTimers.size).toBe(0);
    await tick(20);
    expect(calls).toEqual(["A"]);
  });

  it("F3: trocar para um documento sem Mermaid remove a folha numa só passada", async () => {
    const [html, setHtml] = createSignal(doc("A", "B"));
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.appendChild(scroller);
    try {
      render(() => <Preview {...props({ html: html() })} />, { container: scroller });
      const blocks = Array.from(scroller.querySelectorAll<HTMLElement>(".mermaid"));
      place(scroller, 0, 200);
      place(blocks[0]!, 10, 50);
      place(blocks[1]!, 60, 100);
      await waitFor(() => expect(scroller.querySelectorAll("style[data-mermaid-css]")).toHaveLength(1));
      const style = scroller.querySelector<HTMLStyleElement>("style[data-mermaid-css]")!;
      expect(style.isConnected).toBe(true);
      setHtml("<p>sem diagramas</p>");
      flush();
      await waitFor(() => expect(scroller.querySelectorAll("style[data-mermaid-css]")).toHaveLength(0));
      expect(style.isConnected).toBe(false);
    } finally {
      scroller.remove();
    }
  });

  it("F3: editar sem mudar os diagramas preserva a folha compartilhada", async () => {
    const [html, setHtml] = createSignal(doc("A", "B"));
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.appendChild(scroller);
    try {
      render(() => <Preview {...props({ html: html() })} />, { container: scroller });
      const blocks = Array.from(scroller.querySelectorAll<HTMLElement>(".mermaid"));
      place(scroller, 0, 200);
      place(blocks[0]!, 10, 50);
      place(blocks[1]!, 60, 100);
      await waitFor(() => expect(scroller.querySelectorAll("style[data-mermaid-css]")).toHaveLength(1));
      const style = scroller.querySelector<HTMLStyleElement>("style[data-mermaid-css]")!;
      setHtml(doc("A", "B") + "<p>editado</p>");
      flush();
      await tick(40);
      expect(style.isConnected).toBe(true);
      expect(scroller.querySelectorAll("style[data-mermaid-css]")).toHaveLength(1);
    } finally {
      scroller.remove();
    }
  });

  it("F4: duas inserções do mesmo SVG em cache renomeiam também a raiz", async () => {
    const source = "cached-twice";
    mermaidCache.set(mermaidCacheKey(source, "default"),
      '<svg xmlns="http://www.w3.org/2000/svg" id="cached-root" viewBox="0 0 10 10"><defs><path id="cached-path"/></defs><use href="#cached-path"/></svg>');
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.appendChild(scroller);
    try {
      render(() => <Preview {...props({ html: doc(source, source) })} />, { container: scroller });
      await waitFor(() => expect(scroller.querySelectorAll("article .mermaid svg")).toHaveLength(2));
      const roots = Array.from(scroller.querySelectorAll("article .mermaid svg"));
      expect(ctl.calls).toEqual([]);
      const childIds = roots.map((root) => root.querySelector("defs path")!.id);
      expect(new Set(childIds).size).toBe(2);
      expect(roots.map((root) => root.querySelector("use")!.getAttribute("href"))).toEqual(childIds.map((id) => `#${id}`));
      expect(new Set(roots.map((root) => root.id)).size).toBe(2);
      expect(roots.every((root) => root.id.startsWith("cached-root-cached-"))).toBe(true);
    } finally {
      scroller.remove();
    }
  });

  it("F6: mede a posição depois do render, no momento da inserção", async () => {
    ctl.mode = "pending";
    let height = 20;
    const scroller = document.createElement("div");
    scroller.className = "content";
    scroller.scrollTop = 500;
    document.body.appendChild(scroller);
    try {
      render(() => <Preview {...props({ html: doc("A") })} />, { container: scroller });
      const block = scroller.querySelector<HTMLElement>(".mermaid")!;
      place(scroller, 100, 300);
      place(block, 0, 50);
      Object.defineProperty(block, "offsetHeight", { configurable: true, get: () => height });
      await waitFor(() => expect(ctl.calls).toEqual(["A"]));
      // Durante o await o bloco entrou na área visível: não deve compensar.
      place(block, 200, 250);
      height = 60;
      ctl.pending.shift()!();
      await waitFor(() => expect(block.querySelector("svg")).not.toBeNull());
      expect(scroller.scrollTop).toBe(500);
    } finally {
      scroller.remove();
    }
  });

  it("F7: o flush espera a geração pronta e acompanha a troca durante a espera", async () => {
    ctl.mode = "pending";
    const [html, setHtml] = createSignal(doc("A"));
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.appendChild(scroller);
    try {
      render(() => <Preview {...props({ html: html(), tocContainer: document.createElement("div") })} />, { container: scroller });
      await waitFor(() => expect(ctl.calls).toEqual(["A"]));
      let done = false;
      const flushed = flushPendingMermaid().then(() => { done = true; });
      await tick(10);
      expect(done).toBe(false);

      setHtml(doc("B"));
      flush();
      const resolveA = ctl.pending.shift()!;
      resolveA();
      await waitFor(() => expect(ctl.calls).toEqual(["A", "B"]));
      await tick(10);
      expect(done).toBe(false);
      ctl.pending.shift()!();
      await flushed;
      expect(done).toBe(true);
    } finally {
      scroller.remove();
    }
  });

  it("F7: o flush drena só o preview ativo", async () => {
    ctl.mode = "pending";
    const scroller = document.createElement("div");
    scroller.className = "content";
    const other = document.createElement("div");
    other.className = "content";
    document.body.append(scroller, other);
    try {
      render(() => <Preview {...props({ html: doc("A"), tocContainer: document.createElement("div") })} />, { container: scroller });
      render(() => <Preview {...props({ html: doc("Z") })} />, { container: other });
      place(scroller, 0, 200);
      place(other, 0, 200);
      const blocks = Array.from(other.querySelectorAll<HTMLElement>(".mermaid"));
      place(blocks[0]!, 1000, 1050);
      await waitFor(() => expect(ctl.calls).toEqual(["A"]));
      let done = false;
      const flushed = flushPendingMermaid().then(() => { done = true; });
      await tick(10);
      expect(done).toBe(false);
      ctl.pending.shift()!();
      await flushed;
      expect(done).toBe(true);
      expect(ctl.calls).toEqual(["A"]);
      expect(blocks[0]!.textContent).toContain("Rendering diagram...");
    } finally {
      scroller.remove();
      other.remove();
    }
  });
});

describe("Preview — Mermaid rodada 2", () => {
  it("F1: o render pelo preview preserva literais que casam com o id da raiz", async () => {
    ctl.fixture = `#mermaid-1 { fill: #333 }
#mermaid-1 text::before { content: "#mermaid-1" }`;
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.appendChild(scroller);
    try {
      render(() => <Preview {...props({ html: doc("literal-render") })} />, { container: scroller });
      const block = scroller.querySelector<HTMLElement>(".mermaid")!;
      place(scroller, 0, 200);
      place(block, 10, 60);
      await waitFor(() => expect(scroller.querySelector("style[data-mermaid-css]")).not.toBeNull());
      const css = scroller.querySelector("style[data-mermaid-css]")!.textContent ?? "";
      const originalId = ctl.ids[0]!;
      expect(css).toMatch(/\.mermaid-css-[a-f0-9]+ text::before/);
      expect(css).toContain(`content: "#${originalId}"`);
      expect(css).not.toContain("-cached-");
    } finally {
      scroller.remove();
    }
  });

  it("F1: a inserção em cache preserva literais que casam com o id da raiz", async () => {
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.appendChild(scroller);
    const source = "literal-cache";
    mermaidCache.set(mermaidCacheKey(source, "default"),
      '<svg xmlns="http://www.w3.org/2000/svg" id="review-root" viewBox="0 0 10 10"><style>#review-root text::before { content: "#review-root" }</style><text>demo</text></svg>');
    try {
      render(() => <Preview {...props({ html: doc(source) })} />, { container: scroller });
      await waitFor(() => expect(scroller.querySelector("style[data-mermaid-css]")).not.toBeNull());
      const css = scroller.querySelector("style[data-mermaid-css]")!.textContent ?? "";
      expect(css).toMatch(/\.mermaid-css-[a-f0-9]+ text::before/);
      expect(css).toContain('content: "#review-root"');
      expect(css).not.toContain("-cached-");
    } finally {
      scroller.remove();
    }
  });

  it("F2: a poda preserva a folha de um bloco pendente fora da margem", async () => {
    const [html, setHtml] = createSignal(doc("A"));
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.appendChild(scroller);
    let offscreen = false;
    const originalRect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this === scroller) return rect(0, 200);
      if (this.matches("div.mermaid")) return offscreen ? rect(900, 950) : rect(10, 60);
      return originalRect.call(this);
    });
    try {
      render(() => <Preview {...props({ html: html() })} />, { container: scroller });
      await waitFor(() => expect(scroller.querySelector("article .mermaid svg")).not.toBeNull());
      const style = scroller.querySelector<HTMLStyleElement>("style[data-mermaid-css]")!;
      expect(style).not.toBeNull();

      offscreen = true;
      setHtml(doc("A") + "<p>Unrelated edit</p>");
      flush();
      await tick(40);
      const pending = scroller.querySelector<HTMLElement>("article [data-mermaid-pending]")!;
      expect(pending).not.toBeNull();
      expect(ctl.calls).toEqual(["A"]);
      const connectedAfterEdit = style.isConnected;

      FakeIO.instances.at(-1)!.emit([pending], true);
      await waitFor(() => expect(scroller.querySelector("article .mermaid svg")).not.toBeNull());
      expect(connectedAfterEdit).toBe(true);
      expect(scroller.querySelector("style[data-mermaid-css]")).toBe(style);
    } finally {
      scroller.remove();
    }
  });

  it("F3: a espera da exportação resolve se o setup do observer lança", async () => {
    const [html, setHtml] = createSignal(doc("A"));
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.appendChild(scroller);
    vi.stubGlobal("ResizeObserver", class {
      constructor() { throw new Error("Synthetic setup failure"); }
    });
    try {
      render(() => <Preview {...props({ html: html(), tocContainer: document.createElement("div") })} />, { container: scroller });
      await waitFor(() => expect(scroller.querySelector("article .mermaid svg")).not.toBeNull());
      expect(FakeIO.instances.at(-1)!.disconnected).toBe(true);

      let resolved = false;
      const exportWait = flushPendingMermaid().then(() => { resolved = true; });
      await tick(30);
      const resolvedBeforeNextEdit = resolved;
      setHtml("<p>Recovered</p>");
      flush();
      await exportWait;
      expect(resolvedBeforeNextEdit).toBe(true);
    } finally {
      scroller.remove();
    }
  });

  it("F4: o observer só é recriado quando a margem muda e observa só pendentes", async () => {
    const root = document.createElement("div");
    const block = document.createElement("div");
    let width = 1200;
    root.getBoundingClientRect = () => ({ ...rect(0, 200), width, right: width } as DOMRect);
    place(block, 900, 950);
    const calls: string[] = [];
    const renderer = createMermaidLazyRenderer({
      root,
      blocks: [block],
      render: async () => { calls.push("A"); },
    });
    try {
      const first = FakeIO.instances.at(-1)!;
      const ro = FakeRO.instances.at(-1)!;
      expect(first.rootMargin).toBe("200px 0px");
      expect(first.targets.has(block)).toBe(true);

      for (const next of [1100, 950]) {
        width = next;
        ro.emit();
      }
      expect(FakeIO.instances.map((instance) => instance.rootMargin)).toEqual(["200px 0px"]);
      expect(first.disconnected).toBe(false);

      first.emit([block], true);
      await tick(10);
      expect(calls).toEqual(["A"]);
      expect(first.targets.has(block)).toBe(false);

      place(root, 0, 400);
      ro.emit();
      const second = FakeIO.instances.at(-1)!;
      expect(second).not.toBe(first);
      expect(second.rootMargin).toBe("400px 0px");
      expect(second.targets.has(block)).toBe(false);
    } finally {
      renderer.dispose();
    }
  });
});
