import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal, flush } from "solid-js";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

const ctl = vi.hoisted(() => {
  const defaultFixture = `#mermaid-1 { fill: #333 }
  #mermaid-1 p { margin: 0 }
  :root { --mermaid-font-family: inherit }`;
  return {
    fixture: defaultFixture,
    svg: undefined as ((id: string) => string) | undefined,
    calls: [] as string[],
    ids: [] as string[],
    events: [] as string[],
    mode: "resolve" as "resolve" | "pending" | "error",
    pending: [] as Array<() => void>,
    reset() {
      this.fixture = defaultFixture;
      this.svg = undefined;
      this.calls.length = 0;
      this.ids.length = 0;
      this.events.length = 0;
      this.mode = "resolve";
      this.pending.length = 0;
    },
  };
});

vi.mock(import("../lib/mermaid-frame.ts"), async (original) => ({
  ...await original(),
  ensureMermaidWarm: async () => {},
  renderInFrame: (id: string, source: string) => {
    ctl.calls.push(source);
    ctl.ids.push(id);
    ctl.events.push(`render:${source}`);
    const css = ctl.fixture.replaceAll("#mermaid-1", `#${id}`);
    const svg = ctl.svg?.(id) ?? `<svg id="${id}" viewBox="0 0 10 20"><style>${css}</style><text>${source}</text></svg>`;
    if (ctl.mode === "error") return Promise.reject(new Error("invalid diagram"));
    if (ctl.mode === "pending") {
      return new Promise<{ svg: string }>((resolve) => {
        ctl.pending.push(() => resolve({ svg }));
      });
    }
    return Promise.resolve({ svg });
  },
}));

vi.mock("@markdraw/core/kroki.ts", () => ({ renderKroki: async () => '<svg viewBox="0 0 10 10"></svg>' }));

import { Preview } from "./preview.tsx";
import { mermaidCache, mermaidCacheKey } from "../lib/mermaid-cache.ts";
import { createMermaidLazyRenderer } from "../lib/mermaid-lazy.ts";
import { flushPendingMermaid } from "../lib/mermaid-flush.ts";
import { createAppState } from "../composables/create-app-state.ts";
import { setupAppMenu } from "../../../../apps/desktop/src/lib/menu.ts";

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

// Reduced from Mermaid 12.3.0's timeline output with look: neo and theme: redux.
function timelineSvg(id: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="100 -53 790 460.6000061035156">
    <style>#${id} { font-family: inherit }
#${id} .section--1 rect,#${id} .section--1 path,#${id} .section--1 circle{fill:#ffffff;stroke:#28253D;stroke-width:2;filter:url(#${id}-drop-shadow);}
#${id} .section--1 text{fill:#28253D;font-weight:600;}
#${id} text::before { content: "url(#${id}-drop-shadow)" }</style>
    <defs><filter id="${id}-drop-shadow" height="130%" width="130%"><feDropShadow dx="4" dy="4" stdDeviation="0" flood-opacity="0.06" flood-color="#000000"/></filter></defs>
    <g class="section--1"><rect width="10" height="10"/></g>
  </svg>`;
}

// Reduced from Mermaid 12.3.0's flowchart output with look: neo and theme: base.
function flowchartSvg(id: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="0 0 168 163">
    <style>#${id} .node rect,#${id} .node circle,#${id} .node ellipse,#${id} .node polygon,#${id} .node path{fill:#fff4dd;stroke:hsl(40.5882352941, 60%, 83.3333333333%);stroke-width:1px;}
#${id} [data-look="neo"].node rect,#${id} [data-look="neo"].cluster rect,#${id} [data-look="neo"].node polygon{stroke:url(#${id}-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}</style>
    <marker id="${id}_flowchart-v2-pointEnd-margin" class="marker flowchart-v2" viewBox="0 0 11.5 14" refX="11.5" refY="7" markerUnits="userSpaceOnUse" markerWidth="10.5" markerHeight="14" orient="auto"><path class="arrowMarkerPath" d="M 0 0 L 11.5 7 L 0 14 z"/></marker>
    <g class="node default" data-look="neo"><rect class="basic label-container" x="-76" y="-24" width="152" height="48"/></g>
    <path class="flowchart-link" marker-end="url(#${id}_flowchart-v2-pointEnd-margin)" d="M84,56L84,102"/>
    <linearGradient id="${id}-gradient" gradientUnits="objectBoundingBox" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="hsl(40.5882352941, 60%, 83.3333333333%)" stop-opacity="1"/><stop offset="100%" stop-color="hsl(-79.4117647059, 60%, 83.3333333333%)" stop-opacity="1"/></linearGradient>
  </svg>`;
}

function readSvgInsertion(block: HTMLElement) {
  // happy-dom's HTML parser drops the SVG style and its following nodes.
  vi.spyOn(block, "innerHTML", "set").mockImplementation((markup) => {
    const svg = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
    block.replaceChildren(document.importNode(svg, true));
  });
}

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

  it.each([
    ["observer", "svg", false], ["observer", "svg", true],
    ["observer", "erro", false], ["observer", "erro", true],
    ["flush", "svg", false], ["flush", "svg", true],
    ["flush", "erro", false], ["flush", "erro", true],
  ] as const)("preserva o elemento visível via %s, com %s e ancoragem nativa=%s", async (trigger, result, anchored) => {
    ctl.mode = result === "erro" ? "error" : "resolve";
    const scroller = document.createElement("div");
    const discarded = vi.fn();
    scroller.className = "content";
    document.body.append(scroller);
    try {
      const html = doc("A") + '<section><h2>Visible anchor</h2></section>';
      render(() => <Preview {...props({
        html, tocContainer: document.createElement("div"),
        pendingFragment: "missing", onFragmentDiscarded: discarded,
      })} />, { container: scroller });
      const block = scroller.querySelector<HTMLElement>(".mermaid")!;
      const section = scroller.querySelector("section")!;
      const heading = scroller.querySelector("h2")!;
      place(scroller, 100, 300);
      place(block, -500, -340);
      place(section, 90, 300);

      const selector = result === "erro" ? ".mermaid-error" : "svg";
      const delta = result === "erro" ? -120 : 40;
      let scrollTop = 500;
      let layoutApplied = false;
      const heightChange = () => {
        if (!block.querySelector(selector)) return 0;
        if (!layoutApplied && anchored) scrollTop += delta;
        layoutApplied = true;
        return delta;
      };
      const setScrollTop = vi.fn((value: number) => { scrollTop = value; });
      Object.defineProperty(scroller, "scrollTop", {
        get: () => {
          heightChange();
          return scrollTop;
        },
        set: setScrollTop,
      });
      Object.defineProperty(block, "offsetHeight", { get: () => 160 + heightChange() });
      heading.getBoundingClientRect = () => {
        const top = 121 + heightChange() - (scrollTop - 500);
        return rect(top, top + 20);
      };

      await waitFor(() => expect(discarded).toHaveBeenCalledWith("missing"));
      expect(block.hasAttribute("data-mermaid-pending")).toBe(true);
      expect(ctl.calls).toEqual([]);
      const before = heading.getBoundingClientRect().top;

      if (trigger === "flush") await flushPendingMermaid();
      else FakeIO.instances.at(-1)!.emit([block], true);
      await waitFor(() => expect(block.querySelector(selector)).not.toBeNull());
      expect(heading.getBoundingClientRect().top).toBe(before);
      expect(scroller.scrollTop).toBe(500 + delta);
      expect(setScrollTop.mock.calls).toEqual(anchored ? [] : [[500 + delta]]);
    } finally {
      scroller.remove();
    }
  });

  it.each([
    ["observer", "cache", false], ["observer", "cache", true],
    ["observer", "render", false], ["observer", "render", true],
    ["observer", "erro", false], ["observer", "erro", true],
    ["flush", "cache", false], ["flush", "cache", true],
    ["flush", "render", false], ["flush", "render", true],
    ["flush", "erro", false], ["flush", "erro", true],
  ] as const)("mantém o código alto parado via %s, com %s e ancoragem nativa=%s", async (trigger, result, anchored) => {
    const source = "A";
    const failed = result === "erro";
    ctl.mode = failed ? "error" : "resolve";
    if (result === "cache") {
      mermaidCache.set(mermaidCacheKey(source, "default"), '<svg id="cached" viewBox="0 0 10 10"><path /></svg>');
    }

    const scroller = document.createElement("div");
    const discarded = vi.fn();
    scroller.className = "content";
    document.body.append(scroller);
    try {
      const offscreen = `<section>${"<p><em>Fora da tela</em></p>".repeat(40)}</section>`;
      const lines = Array.from({ length: 100 }, (_, i) => `Linha ${i}`).join("\n");
      const html = offscreen + doc(source) + `<pre><code>${lines}</code></pre>` + offscreen;
      render(() => <Preview {...props({
        html, tocContainer: document.createElement("div"),
        pendingFragment: "missing", onFragmentDiscarded: discarded,
      })} />, { container: scroller });
      const block = scroller.querySelector<HTMLElement>(".mermaid")!;
      const pre = scroller.querySelector("pre")!;
      const code = pre.querySelector("code")!;
      const [above, below] = scroller.querySelectorAll("section");
      place(scroller, 100, 300);
      place(block, -500, -340);
      place(above!, -2500, -500);
      place(below!, 1900, 3900);
      const offscreenRects = vi.fn(() => rect(0, 0));
      for (const descendant of scroller.querySelectorAll("section *")) {
        descendant.getBoundingClientRect = offscreenRects;
      }
      const aboveRect = vi.spyOn(above!, "getBoundingClientRect");
      const belowRect = vi.spyOn(below!, "getBoundingClientRect");

      const selector = failed ? ".mermaid-error" : "svg";
      const delta = failed ? -120 : 40;
      let scrollTop = 500;
      let layoutApplied = false;
      const setScrollTop = vi.fn((value: number) => { scrollTop = value; });
      Object.defineProperty(scroller, "scrollTop", { get: () => scrollTop, set: setScrollTop });
      const laidOutRect = (top: number, height: number) => () => {
        const inserted = !!block.querySelector(selector);
        if (inserted && !layoutApplied) {
          if (anchored) scrollTop += delta;
          layoutApplied = true;
        }
        const position = top + (inserted ? delta : 0) - (scrollTop - 500);
        return rect(position, position + height);
      };
      const preRect = vi.fn(laidOutRect(-30, 1930));
      const codeRect = vi.fn(laidOutRect(-5, 1880));
      pre.getBoundingClientRect = preRect;
      code.getBoundingClientRect = codeRect;

      await waitFor(() => expect(discarded).toHaveBeenCalledWith("missing"));
      expect(block.hasAttribute("data-mermaid-pending")).toBe(true);
      expect(ctl.calls).toEqual([]);
      const before = code.getBoundingClientRect().top;
      codeRect.mockClear();

      if (trigger === "flush") await flushPendingMermaid();
      else FakeIO.instances.at(-1)!.emit([block], true);
      await waitFor(() => expect(block.querySelector(selector)).not.toBeNull());
      expect(code.getBoundingClientRect().top).toBe(before);
      expect(scroller.scrollTop).toBe(500 + delta);
      expect(setScrollTop.mock.calls).toEqual(anchored ? [] : [[500 + delta]]);
      expect(ctl.calls).toEqual(result === "cache" ? [] : failed ? [source, source, source] : [source]);
      expect(offscreenRects).not.toHaveBeenCalled();
      expect([aboveRect, preRect, belowRect].map((measure) => measure.mock.calls.length)).toEqual([1, 1, 1]);
      // Search, post-insertion compensation, and the assertion above.
      expect(codeRect).toHaveBeenCalledTimes(3);
    } finally {
      scroller.remove();
    }
  });

  it.each([["varredura", false], ["ponto na borda de cima", true]] as const)(
    "mede só os arredores da área visível para achar a âncora (%s)",
    async (_label, hitTest) => {
      const source = "A";
      mermaidCache.set(mermaidCacheKey(source, "default"), '<svg id="cached" viewBox="0 0 10 10"><path /></svg>');
      const scroller = document.createElement("div");
      const discarded = vi.fn();
      scroller.className = "content";
      document.body.append(scroller);
      const originalHitTest = document.elementFromPoint;
      try {
        const before = "<p>Antes</p>".repeat(200);
        const after = "<p>Depois</p>".repeat(200);
        const lines = Array.from({ length: 100 }, (_, i) => `Linha ${i}`).join("\n");
        render(() => <Preview {...props({
          html: before + doc(source) + `<pre><code>${lines}</code></pre>` + after,
          tocContainer: document.createElement("div"),
          pendingFragment: "missing", onFragmentDiscarded: discarded,
        })} />, { container: scroller });
        const block = scroller.querySelector<HTMLElement>(".mermaid")!;
        const pre = scroller.querySelector("pre")!;
        const code = pre.querySelector("code")!;
        const paragraphs = Array.from(scroller.querySelectorAll("p"));
        const beforeParagraphs = paragraphs.filter((p) => p.textContent === "Antes");
        const afterParagraphs = paragraphs.filter((p) => p.textContent === "Depois");
        place(scroller, 100, 300);
        place(scroller.querySelector(".doc-body")!, -9000, 12000);
        place(block, -500, -340);
        beforeParagraphs.forEach((p, i) => place(p, -9000 + i * 40, -8980 + i * 40));
        afterParagraphs.forEach((p, i) => place(p, 1900 + i * 40, 1920 + i * 40));
        const beforeRects = beforeParagraphs.map((p) => vi.spyOn(p, "getBoundingClientRect"));
        const afterRects = afterParagraphs.map((p) => vi.spyOn(p, "getBoundingClientRect"));
        let inserted = () => !!block.querySelector("svg");
        let scrollTop = 500;
        Object.defineProperty(scroller, "scrollTop", { get: () => scrollTop, set: (v: number) => { scrollTop = v; } });
        const laidOut = (top: number, height: number) => () => {
          const position = top + (inserted() ? 40 : 0) - (scrollTop - 500);
          return rect(position, position + height);
        };
        pre.getBoundingClientRect = vi.fn(laidOut(-30, 1930));
        code.getBoundingClientRect = vi.fn(laidOut(-5, 1880));
        document.elementFromPoint = (hitTest ? () => code : () => null) as typeof document.elementFromPoint;

        await waitFor(() => expect(discarded).toHaveBeenCalledWith("missing"));
        const top = code.getBoundingClientRect().top;
        for (const spy of [...beforeRects, ...afterRects]) spy.mockClear();
        FakeIO.instances.at(-1)!.emit([block], true);
        await waitFor(() => expect(inserted()).toBe(true));

        expect(code.getBoundingClientRect().top).toBe(top);
        const measured = (spies: typeof beforeRects) => spies.filter((spy) => spy.mock.calls.length > 0).length;
        // The walk stops at the first sibling below the viewport; the hit test
        // measures none of the far siblings at all.
        expect(measured(afterRects)).toBeLessThanOrEqual(hitTest ? 0 : 1);
        if (hitTest) expect(measured(beforeRects)).toBe(0);
      } finally {
        document.elementFromPoint = originalHitTest;
        scroller.remove();
      }
    },
  );

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

describe("Preview — Mermaid no iframe e exportação", () => {
  it("espera o diagrama fora da margem antes de imprimir pelo menu nativo", async () => {
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.append(scroller);
    const discarded = vi.fn();
    const print = vi.fn<() => boolean>();
    const [state, disposeState] = createRoot((dispose) => [
      createAppState({
        printPage: () => { print(); },
        applyTheme: () => {},
        convertAdoc: async () => ({ html: "", frontmatter: null }),
        convertMarkdown: async () => ({ html: "", frontmatter: null }),
        getStoredTheme: () => "system",
      }),
      dispose,
    ] as const);
    let activateExport: (() => void) | undefined;
    let nextCallback = 0;
    vi.stubGlobal("__TAURI_INTERNALS__", {
      transformCallback: () => ++nextCallback,
      invoke: async (command: string, args: {
        options?: { id?: string };
        handler?: { onmessage: (id: string) => void };
      }) => {
        switch (command) {
          case "plugin:menu|new":
            if (args.options?.id === "export-pdf") {
              const handler = args.handler!;
              activateExport = () => handler.onmessage("export-pdf");
            }
            return [nextCallback, args.options?.id ?? String(nextCallback)];
          case "plugin:app|version":
            return "0.0.0";
          case "plugin:menu|set_as_app_menu":
            return null;
          case "print_webview":
            return print();
          default:
            throw new Error(`Unexpected IPC: ${command}`);
        }
      },
    });
    try {
      render(() => <Preview {...props({
        html: doc("A", "B"), tocContainer: document.createElement("div"),
        pendingFragment: "missing", onFragmentDiscarded: discarded,
      })} />, { container: scroller });
      place(scroller, 0, 200);
      const [visible, offscreen] = scroller.querySelectorAll<HTMLElement>("article .mermaid");
      place(visible!, 10, 50);
      place(offscreen!, 1000, 1050);

      await waitFor(() => expect(discarded).toHaveBeenCalledWith("missing"));
      expect(visible!.querySelector("svg")).not.toBeNull();
      expect(offscreen!.hasAttribute("data-mermaid-pending")).toBe(true);
      expect(ctl.calls).toEqual(["A"]);

      await setupAppMenu({
        exportPdfState: state,
        onOpenFolder: () => {},
        onCheckForUpdates: () => {},
        onEditorMode: () => {},
        onToggleSidebar: () => {},
        onToggleToc: () => {},
        onThemeChange: () => {},
        onFind: () => {},
      });
      ctl.mode = "pending";
      print.mockImplementation(() => !!offscreen!.querySelector("svg"));
      activateExport!();
      await waitFor(() => expect(ctl.calls).toEqual(["A", "B"]));
      expect(print).not.toHaveBeenCalled();
      expect(offscreen!.hasAttribute("data-mermaid-pending")).toBe(true);
      ctl.pending.shift()!();
      await waitFor(() => expect(print).toHaveBeenCalledOnce());
      expect(print).toHaveReturnedWith(true);
    } finally {
      ctl.pending.splice(0).forEach((resolve) => resolve());
      disposeState();
      scroller.remove();
    }
  });

  for (const path of ["render", "cache"] as const) {
    it(`compartilha parte do CSS do timeline neo e mantém o filtro local no caminho de ${path}`, async () => {
      const scroller = document.createElement("div");
      scroller.className = "content";
      document.body.append(scroller);
      const source = "---\nconfig:\n  look: neo\n  theme: redux\n---\ntimeline\n  2025 : First milestone";
      const cachedId = "review-timeline";
      ctl.svg = timelineSvg;
      if (path === "cache") {
        mermaidCache.set(mermaidCacheKey(source, "default"), timelineSvg(cachedId));
      }
      try {
        render(() => <Preview {...props({ html: doc(source) })} />, { container: scroller });
        const block = scroller.querySelector<HTMLElement>("article .mermaid")!;
        readSvgInsertion(block);
        await waitFor(() => expect(scroller.querySelector("article .mermaid svg")).not.toBeNull());
        const svg = scroller.querySelector("article .mermaid svg")!;
        const originalId = path === "render" ? ctl.ids[0]! : cachedId;
        expect(ctl.calls).toEqual(path === "render" ? [source] : []);
        const shared = scroller.querySelector("style[data-mermaid-css]")!;
        const className = shared.getAttribute("data-mermaid-css")!;
        expect(svg.classList.contains(className)).toBe(true);
        expect(shared.textContent).toContain(`.${className} { font-family: inherit }`);
        expect(shared.textContent).not.toMatch(/filter:\s*url\(/);
        expect(shared.textContent).not.toContain(".section--1 text");

        const filter = svg.querySelector("filter")!;
        expect(svg.id).not.toBe(originalId);
        expect(filter.id).not.toBe(`${originalId}-drop-shadow`);
        const css = svg.querySelector("style")?.textContent;
        expect(css).toContain(`.${className}:where(#${svg.id}) .section--1 rect`);
        expect(css).toContain(`filter:url(#${filter.id})`);
        expect(css).toContain(`.${className}:where(#${svg.id}) .section--1 text`);
        expect(css).toContain(`content: "url(#${originalId}-drop-shadow)"`);
        expect(mermaidCache.classNameFor(mermaidCacheKey(source, "default"))).toBe(className);
      } finally {
        scroller.remove();
      }
    });
  }

  it("compartilha o CSS de dois flowcharts com o mesmo tema e isola gradientes e marcadores em render e cache", async () => {
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.append(scroller);
    const config = "---\nconfig:\n  look: neo\n  theme: base\n---\nflowchart TD\n";
    const renderedSource = config + " A[one] --> B[two]";
    const cachedSource = config + " C[three] --> D[four]";
    mermaidCache.set(mermaidCacheKey(cachedSource, "default"), flowchartSvg("cached-flowchart"));
    ctl.svg = flowchartSvg;
    try {
      const html = doc(...[renderedSource, cachedSource].map((source) => source.replaceAll(">", "&gt;")));
      render(() => <Preview {...props({ html })} />, { container: scroller });
      scroller.querySelectorAll<HTMLElement>("article .mermaid").forEach(readSvgInsertion);
      await waitFor(() => expect(scroller.querySelectorAll("article .mermaid svg")).toHaveLength(2));

      expect(ctl.calls).toEqual([renderedSource]);
      const sharedStyles = scroller.querySelectorAll("style[data-mermaid-css]");
      expect(sharedStyles).toHaveLength(1);
      const className = sharedStyles[0]!.getAttribute("data-mermaid-css")!;
      expect(sharedStyles[0]!.textContent).toContain(`.${className} .node rect`);
      expect(sharedStyles[0]!.textContent).not.toContain("url(");
      for (const [index, svg] of Array.from(scroller.querySelectorAll("article .mermaid svg")).entries()) {
        const originalId = index === 0 ? ctl.ids[0]! : "cached-flowchart";
        const gradient = svg.querySelector("linearGradient")!;
        const marker = svg.querySelector("marker")!;
        const css = svg.querySelector("style")?.textContent;
        expect(svg.classList.contains(className)).toBe(true);
        expect(svg.id).not.toBe(originalId);
        expect(gradient.id).not.toBe(`${originalId}-gradient`);
        expect(marker.id).not.toBe(`${originalId}_flowchart-v2-pointEnd-margin`);
        expect(css).toContain(`.${className}:where(#${svg.id}) [data-look="neo"].node rect`);
        expect(css).toContain(`stroke:url(#${gradient.id})`);
        expect(css).not.toContain("fill:#fff4dd");
        expect(svg.querySelector(".flowchart-link")?.getAttribute("marker-end")).toBe(`url(#${marker.id})`);
      }
    } finally {
      scroller.remove();
    }
  });
});
