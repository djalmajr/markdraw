import { afterEach, expect, it, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

const state = vi.hoisted(() => ({ theme: "", pause: null as null | (() => void), calls: [] as string[], queue: Promise.resolve() }));
vi.mock("mermaid", () => ({
  default: {
    initialize: ({ theme }: { theme: string }) => { state.theme = theme; },
    render: (id: string, source: string) => {
      const result = state.queue.then(async () => {
        if (source === "hold") await new Promise<void>((resolve) => { state.pause = resolve; });
        const theme = state.theme;
        if (id !== "mermaid-prewarm") state.calls.push(`${theme}:${source}`);
        return { svg: `<svg id="${id}" viewBox="0 0 100 100"><text>${theme}:${source}</text></svg>` };
      });
      state.queue = result.then(() => {}, () => {});
      return result;
    },
  },
}));

import { Preview } from "./preview.tsx";
import { mermaidCache } from "../lib/mermaid-cache.ts";

const defaults = {
  frontmatter: null, loading: false, searchOpen: false, syncScrollActive: false,
  syncScrollTargetRatio: null, syncScrollTargetVersion: 0, wrapTables: false,
  findTrigger: 0, pendingFragment: null, tocVisible: false,
  onFragmentHandled: () => {}, onNavigate: () => {}, onScrollRatioChange: () => {},
  onSearchOpenChange: () => {}, onTocChange: () => {},
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 35));
const mermaid = (source: string) => `<div class="mermaid">${source}</div>`;
const kroki = (source: string) => `<div class="kroki" data-type="plantuml">${source}</div>`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
  state.calls.length = 0;
  state.pause = null;
  mermaidCache.clear();
});

it("removes and recreates one functional collapse control per nested TOC entry", async () => {
  const toc = document.createElement("div");
  document.body.appendChild(toc);
  try {
    const [visible, setVisible] = createSignal(false);
    const html = '<div id="toc"><ul><li><a href="#x">X</a><ul><li><a href="#y">Y</a></li></ul></li></ul></div><h1 id="x">X</h1><h2 id="y">Y</h2>';
    render(() => <Preview {...defaults} html={html} tocContainer={toc} tocVisible={visible()} />);
    const counts: number[] = [];
    for (const next of [true, false, true, false, true]) {
      setVisible(next);
      flush();
      await tick();
      counts.push(toc.querySelectorAll(".toc-toggle").length);
      if (next) {
        const toggle = toc.querySelector<HTMLElement>(".toc-toggle")!;
        toggle.click();
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
        expect(toggle.parentElement?.classList.contains("toc-collapsed")).toBe(true);
      } else {
        expect(toc.querySelector(".toc-collapsed, .toc-expanded, .toc-collapsible")).toBeNull();
      }
    }
    expect(counts).toEqual([1, 0, 1, 0, 1]);
  } finally { toc.remove(); }
});

it("starts the new tab before queued Kroki work from an abandoned document", async () => {
  const posts: string[] = [];
  const releases: Array<() => void> = [];
  let block = true;
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    const body = String(options.body);
    posts.push(body);
    if (block && body.startsWith("review-old-")) await new Promise<void>((resolve) => releases.push(resolve));
    return new Response('<svg viewBox="0 0 100 100"><text>ready</text></svg>');
  }));
  const [html, setHtml] = createSignal(Array.from({ length: 8 }, (_, i) => kroki(`review-old-${i}`)).join(""));
  const { container } = render(() => <Preview {...defaults} html={html()} />);
  try {
    await waitFor(() => expect(posts.length).toBe(4));
    setHtml(kroki("review-new-tab"));
    flush();
    await tick();
    block = false;
    for (const release of releases) release();
    await waitFor(() => expect(container.querySelector(".kroki svg")).not.toBeNull());
    expect(posts.slice(4)).toEqual(["review-new-tab"]);
  } finally {
    block = false;
    for (const release of releases) release();
  }
});

for (const action of ["close", "switch"] as const) {
  it(`aborts four pending Kroki POSTs on ${action} and renders the current document`, async () => {
    const posts: string[] = [];
    const aborted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, options: RequestInit) => {
      const source = String(options.body);
      posts.push(source);
      if (source.startsWith(`held-${action}-old-`)) {
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            aborted.push(source);
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }
      return new Response(`<svg viewBox="0 0 100 100"><text>${source}</text></svg>`);
    }));
    const [html, setHtml] = createSignal(Array.from({ length: 4 }, (_, i) => kroki(`held-${action}-old-${i}`)).join(""));
    const old = render(() => <Preview {...defaults} html={html()} />);
    try {
      await waitFor(() => expect(posts).toHaveLength(4));
      if (action === "close") old.unmount();
      else { setHtml(kroki(`held-${action}-current`)); flush(); }
      const current = action === "close"
        ? render(() => <Preview {...defaults} html={kroki(`held-${action}-current`)} />)
        : old;
      await waitFor(() => expect(current.container.querySelector(".kroki svg text")?.textContent).toBe(`held-${action}-current`));
      expect(aborted).toHaveLength(4);
      expect(posts).toEqual([...Array.from({ length: 4 }, (_, i) => `held-${action}-old-${i}`), `held-${action}-current`]);
      expect(current.container.querySelector(".mermaid-error")).toBeNull();
    } finally { old.unmount(); }
  });
}

it("keeps a shared Kroki POST running after the other preview closes", async () => {
  let signal: AbortSignal | null | undefined;
  let respond!: (response: Response) => void;
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, options: RequestInit) => {
    posts.push(String(options.body));
    signal = options.signal;
    return await new Promise<Response>((resolve, reject) => {
      respond = resolve;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  }));
  const old = render(() => <Preview {...defaults} html={kroki("held-shared-ui")} />);
  const current = render(() => <Preview {...defaults} html={kroki("held-shared-ui")} />);
  try {
    await waitFor(() => expect(posts).toEqual(["held-shared-ui"]));
    await waitFor(() => expect(current.container.querySelector(".kroki")?.textContent).toContain("Rendering diagram"));
    old.unmount();
    expect(signal?.aborted).toBe(false);
    respond(new Response('<svg viewBox="0 0 100 100"><text>shared</text></svg>'));
    await waitFor(() => expect(current.container.querySelector(".kroki svg text")?.textContent).toBe("shared"));
    expect(posts).toEqual(["held-shared-ui"]);
    expect(current.container.querySelector(".mermaid-error")).toBeNull();
  } finally { old.unmount(); current.unmount(); respond?.(new Response("<svg />")); }
});

it("keeps the effective Mermaid theme with its cache key across concurrent panes", async () => {
  const [htmlA, setHtmlA] = createSignal(mermaid("hold") + mermaid("mixed"));
  const [htmlB, setHtmlB] = createSignal("<h1>Pane B</h1>");
  const { container } = render(() => <><section id="pane-a"><Preview {...defaults} html={htmlA()} /></section><section id="pane-b"><Preview {...defaults} html={htmlB()} /></section></>);
  const paneA = container.querySelector("#pane-a")!;
  const paneB = container.querySelector("#pane-b")!;
  try {
    await waitFor(() => expect(state.pause).toBeTypeOf("function"));
    document.documentElement.classList.add("dark");
    await tick();
    setHtmlB(mermaid("pane-b-dark"));
    flush();
    await tick();
    state.pause!();
    await waitFor(() => expect(paneB.querySelector(".mermaid svg")?.textContent).toBe("dark:pane-b-dark"));
    await waitFor(() => expect(paneA.querySelectorAll(".mermaid svg")).toHaveLength(2));
    expect(paneA.querySelector(".mermaid svg")?.textContent).toBe("default:hold");
    document.documentElement.classList.remove("dark");
    await tick();
    setHtmlA(mermaid("mixed"));
    flush();
    await waitFor(() => expect(paneA.querySelectorAll(".mermaid svg")).toHaveLength(1));
    expect(paneA.querySelector(".mermaid svg")?.textContent).toBe("default:mixed");
  } finally { state.pause?.(); }
});

for (const kind of ["fragment", "heading"] as const) {
  it(`clears a missing ${kind} so a later edit cannot trigger a jump`, async () => {
    const [html, setHtml] = createSignal("<h1>Initial</h1>");
    const [request, setRequest] = createSignal<string | null>(null);
    const handled = vi.fn(() => setRequest(null));
    const discarded = vi.fn(() => setRequest(null));
    const { container } = render(() => (
      <div class="content"><Preview {...defaults} currentFilePath="file.md" html={html()}
        pendingFragment={kind === "fragment" ? request() : null}
        pendingHeadingText={kind === "heading" ? request() : null}
        onFragmentHandled={handled} onFragmentDiscarded={discarded}
        onHeadingHandled={handled} onHeadingDiscarded={discarded} /></div>
    ));
    const scroll = vi.spyOn(container.querySelector<HTMLElement>(".content")!, "scrollTo");
    setRequest(kind === "fragment" ? "missing" : "Missing");
    flush();
    await tick();
    expect(handled.mock.calls.length + discarded.mock.calls.length).toBe(1);
    setHtml('<h1 id="missing">Missing</h1>');
    flush();
    await tick();
    expect(scroll).not.toHaveBeenCalled();
    expect(handled.mock.calls.length + discarded.mock.calls.length).toBe(1);
  });
}
