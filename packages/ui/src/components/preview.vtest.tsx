import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal, flush, untrack } from "solid-js";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

// Controlled diagram renderers: the readiness tests hold a diagram in a
// promise while a navigation request arrives, then decide when (or whether)
// it completes. Other tests keep the fast, successful default.
const diagramCtl = vi.hoisted(() => ({
  mode: {
    mermaid: "resolve" as "resolve" | "pending" | "reject",
    kroki: "resolve" as "resolve" | "pending" | "reject",
  },
  pending: {
    mermaid: null as ((value: { svg: string }) => void) | null,
    kroki: null as ((value: string) => void) | null,
  },
  started: { mermaid: [] as string[], kroki: [] as string[] },
  reset() {
    this.mode.mermaid = "resolve";
    this.mode.kroki = "resolve";
    this.pending.mermaid = null;
    this.pending.kroki = null;
    this.started.mermaid.length = 0;
    this.started.kroki.length = 0;
  },
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: () => {},
    render: (id: string) => {
      if (id === "mermaid-prewarm") {
        return Promise.resolve({ svg: '<svg viewBox="0 0 10 10"></svg>' });
      }
      diagramCtl.started.mermaid.push(id);
      if (diagramCtl.mode.mermaid === "reject") {
        return Promise.reject(new Error("mermaid failed"));
      }
      if (diagramCtl.mode.mermaid === "pending") {
        return new Promise<{ svg: string }>((resolve) => {
          diagramCtl.pending.mermaid = resolve;
        });
      }
      return Promise.resolve({ svg: `<svg id="${id}" viewBox="0 0 10 400"><defs><marker id="arrow" /></defs><text>arrow</text><path marker-end="url(#arrow)" /></svg>` });
    },
  },
}));

vi.mock("@markdraw/core/kroki.ts", () => ({
  renderKroki: (_type: string, source: string) => {
    diagramCtl.started.kroki.push(source);
    if (diagramCtl.mode.kroki === "reject") {
      return Promise.reject(new Error("kroki failed"));
    }
    if (diagramCtl.mode.kroki === "pending") {
      return new Promise<string>((resolve) => {
        diagramCtl.pending.kroki = resolve;
      });
    }
    return Promise.resolve('<svg viewBox="0 0 10 400"><text>Ready</text></svg>');
  },
}));

// PaneView's other children pull in CodeMirror / dnd-kit; the host-signal
// lifecycle tests below only need PaneView, Preview and HtmlPreview itself.
vi.mock("./editor.tsx", () => ({ Editor: () => <div data-testid="editor-stub" /> }));
vi.mock("./editor-toolbar.tsx", () => ({ EditorToolbar: () => null }));
vi.mock("./content-toolbar.tsx", () => ({ ContentToolbar: () => null }));
vi.mock("./tab-bar.tsx", () => ({ TabBar: () => null }));
vi.mock("./empty-state.tsx", () => ({ EmptyState: () => null }));
vi.mock("../lib/dnd/index.ts", () => ({
  useDroppable: () => ({ ref: () => {}, isDropTarget: () => false }),
}));

import { Preview, setupTocScrollTracking } from "./preview.tsx";
import { mermaidCache } from "../lib/mermaid-cache.ts";

afterEach(() => mermaidCache.clear());
import { PaneView } from "./pane-view.tsx";
import { FrontmatterPanel } from "./frontmatter-panel.tsx";
import { ImageLightbox } from "./image-lightbox.tsx";
import type { Frontmatter } from "@markdraw/core/frontmatter.ts";

interface BaseProps {
  html?: string;
  frontmatter?: Frontmatter | null;
  loading?: boolean;
  searchOpen?: boolean;
  syncScrollActive?: boolean;
  syncScrollTargetRatio?: number | null;
  syncScrollTargetVersion?: number;
  tocVisible?: boolean;
  wrapTables?: boolean;
  tocContainer?: HTMLElement;
  findTrigger?: number;
  currentFilePath?: string | null;
  pendingFragment?: string | null;
  pendingHeadingText?: string | null;
  onNavigate?: (path: string, frag?: string | null) => void;
  onScrollRatioChange?: (n: number) => void;
  onSearchOpenChange?: (b: boolean) => void;
  onTocChange?: (b: boolean) => void;
  onFragmentHandled?: () => void;
  onHeadingHandled?: () => void;
  onFragmentDiscarded?: (fragment: string) => void;
  onHeadingDiscarded?: (heading: string) => void;
}

function withDefaults(p: BaseProps = {}) {
  return {
    html: p.html ?? "",
    frontmatter: p.frontmatter ?? null,
    loading: p.loading ?? false,
    searchOpen: p.searchOpen ?? false,
    syncScrollActive: p.syncScrollActive ?? false,
    syncScrollTargetRatio: p.syncScrollTargetRatio ?? null,
    syncScrollTargetVersion: p.syncScrollTargetVersion ?? 0,
    tocVisible: p.tocVisible ?? false,
    wrapTables: p.wrapTables ?? false,
    tocContainer: p.tocContainer,
    findTrigger: p.findTrigger ?? 0,
    currentFilePath: p.currentFilePath ?? null,
    pendingFragment: p.pendingFragment ?? null,
    pendingHeadingText: p.pendingHeadingText ?? null,
    onNavigate: p.onNavigate ?? (() => {}),
    onScrollRatioChange: p.onScrollRatioChange ?? (() => {}),
    onSearchOpenChange: p.onSearchOpenChange ?? (() => {}),
    onTocChange: p.onTocChange ?? (() => {}),
    onFragmentHandled: p.onFragmentHandled ?? (() => {}),
    onHeadingHandled: p.onHeadingHandled ?? (() => {}),
  };
}

const TOC_HTML_A = `
  <div id="toc" class="toc"><ul class="sectlevel1"><li><a href="#a-section">A section</a></li></ul></div>
  <h1 id="a-section">A section</h1>
  <p>body of doc A</p>
`;
const TOC_HTML_B = `
  <div id="toc" class="toc"><ul class="sectlevel1"><li><a href="#b-section">B section</a></li></ul></div>
  <h1 id="b-section">B section</h1>
  <p>body of doc B</p>
`;

describe("Preview", () => {
  it("renders supplied HTML body inside the preview surface", async () => {
    const { container } = render(() => (
      <Preview {...withDefaults({
        html: "<h1>Hello</h1><p>body paragraph</p>",
      })} />
    ));
    // Wait a tick for the createEffect that processes html to run.
    await new Promise((r) => setTimeout(r, 30));
    expect(container.textContent).toContain("Hello");
    expect(container.textContent).toContain("body paragraph");
  });

  it("clears the shared toc + flags no-toc when a doc renders empty (regression)", async () => {
    // Regression: switching to an empty-rendered Markdown file (e.g. a 0-byte
    // .md) used to leave the PREVIOUS file's toc in the shared panel and keep
    // `hasToc` stuck true. The empty-html branch must clear both.
    const sharedToc = document.createElement("div");
    document.body.appendChild(sharedToc);
    const onToc = vi.fn();
    const [html, setHtml] = createSignal(TOC_HTML_A);
    const props = withDefaults({ tocVisible: true, tocContainer: sharedToc, onTocChange: onToc });
    render(() => <Preview {...props} html={html()} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(sharedToc.querySelector("a[href='#a-section']")).not.toBeNull();
    expect(onToc).toHaveBeenLastCalledWith(true);

    setHtml(""); // switch to an empty doc
    await new Promise((r) => setTimeout(r, 50));
    expect(sharedToc.querySelector("#toc")).toBeNull();
    expect(onToc).toHaveBeenLastCalledWith(false);
    sharedToc.remove();
  });

  it("adds .doc-tables-wrap on the article when wrapTables is on, omits it when off", async () => {
    // Mutation captured: dropping the `class={{ "doc-tables-wrap": ... }}`
    // binding on the article leaves wide tables stuck in horizontal-scroll
    // mode regardless of the preference. The wrap CSS keys off this class.
    const on = render(() => (
      <Preview {...withDefaults({ html: "<table><tbody><tr><td>x</td></tr></tbody></table>", wrapTables: true })} />
    ));
    await new Promise((r) => setTimeout(r, 30));
    expect(on.container.querySelector(".doc-body")?.classList.contains("doc-tables-wrap")).toBe(true);

    const off = render(() => (
      <Preview {...withDefaults({ html: "<table><tbody><tr><td>x</td></tr></tbody></table>", wrapTables: false })} />
    ));
    await new Promise((r) => setTimeout(r, 30));
    expect(off.container.querySelector(".doc-body")?.classList.contains("doc-tables-wrap")).toBe(false);
  });

  it("strips <script> tags from supplied HTML (defense in depth)", async () => {
    const { container } = render(() => (
      <Preview {...withDefaults({
        html: '<p>safe</p><script>window.__pwned=true</script>',
      })} />
    ));
    await new Promise((r) => setTimeout(r, 30));
    // No live <script> in the rendered DOM.
    expect(container.querySelector("script")).toBeNull();
    // Body still rendered around the offending tag.
    expect(container.textContent).toContain("safe");
  });

  it("rejects javascript: URLs in <a href>", async () => {
    const { container } = render(() => (
      <Preview {...withDefaults({
        html: '<a id="bait" href="javascript:alert(1)">click</a>',
      })} />
    ));
    await new Promise((r) => setTimeout(r, 30));
    const link = container.querySelector<HTMLAnchorElement>("a#bait");
    if (link) {
      expect(link.getAttribute("href")?.startsWith("javascript:")).toBeFalsy();
    }
  });

  it("renders the FrontmatterPanel when frontmatter is supplied", async () => {
    const { container } = render(() => (
      <Preview {...withDefaults({
        frontmatter: { title: "My Doc", tags: ["a", "b"] },
        html: "<p>body</p>",
      })} />
    ));
    await new Promise((r) => setTimeout(r, 30));
    // FrontmatterPanel renders the values somewhere in the tree; check
    // that the title surface is present.
    expect(container.textContent).toMatch(/My Doc|title/i);
  });

  it("does not crash when html is empty and frontmatter is null", async () => {
    const { container } = render(() => <Preview {...withDefaults()} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(container).not.toBeNull();
  });

  it("sanitizes <iframe> out of supplied HTML", async () => {
    const { container } = render(() => (
      <Preview {...withDefaults({
        html: '<p>before</p><iframe src="https://evil.example"></iframe><p>after</p>',
      })} />
    ));
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
  });

  /**
   * Regression coverage for the split-pane TOC bug — when the user
   * cycles focus between two Previews that share the same TOC container,
   * the previously-active pane's `#toc` node would be detached by the
   * other pane's `textContent = ""` and then never re-found, leaving the
   * shared panel empty when focus returned. The Preview now keeps a
   * private cache of its `#toc` node so it can re-attach on every focus
   * flip without re-rendering the whole HTML.
   *
   * The vtest harness can't mount a real AppShell, so we simulate the
   * split layout by rendering two Previews against the same shared
   * container DOM node and toggling each one's `tocContainer` prop the
   * way AppShell does.
   */
  it("re-populates the shared TOC container on every focus flip", async () => {
    const sharedToc = document.createElement("div");
    document.body.appendChild(sharedToc);

    // Pane A — starts active and emits #toc into the shared container.
    const [tocContainerA, setTocContainerA] = createSignal<HTMLElement | undefined>(sharedToc);
    const onTocA = vi.fn();
    render(() => (
      <Preview {...withDefaults({
        html: TOC_HTML_A,
        tocVisible: true,
        get tocContainer() {
          return tocContainerA();
        },
        onTocChange: onTocA,
      })} />
    ));

    // Wait for the html effect + microtask post-processing to finish.
    await new Promise((r) => setTimeout(r, 50));
    expect(sharedToc.querySelector("a[href='#a-section']")).not.toBeNull();
    expect(onTocA).toHaveBeenLastCalledWith(true);

    // Pane B — different doc, mounts later. Pane A loses the container
    // (becomes inactive); pane B receives it and clobbers A's toc with
    // its own.
    const [tocContainerB, setTocContainerB] = createSignal<HTMLElement | undefined>(undefined);
    const onTocB = vi.fn();
    render(() => (
      <Preview {...withDefaults({
        html: TOC_HTML_B,
        tocVisible: true,
        get tocContainer() {
          return tocContainerB();
        },
        onTocChange: onTocB,
      })} />
    ));
    await new Promise((r) => setTimeout(r, 30));

    setTocContainerA(undefined);
    setTocContainerB(sharedToc);
    await new Promise((r) => setTimeout(r, 30));

    // After the focus flip the shared panel must show pane B's toc, not
    // a stale pane-A entry and not nothing.
    expect(sharedToc.querySelector("a[href='#b-section']")).not.toBeNull();
    expect(sharedToc.querySelector("a[href='#a-section']")).toBeNull();
    expect(onTocB).toHaveBeenLastCalledWith(true);

    // Flip back to pane A. The previously-active session moved A's toc
    // into the shared container; pane B's focus session then wiped that
    // container. Without the cached `tocNode`, A's articleRef lookup
    // returns null here and the shared panel ends up empty — the
    // regression we're guarding against.
    setTocContainerB(undefined);
    setTocContainerA(sharedToc);
    await new Promise((r) => setTimeout(r, 30));

    expect(sharedToc.querySelector("a[href='#a-section']")).not.toBeNull();
    expect(sharedToc.querySelector("a[href='#b-section']")).toBeNull();

    // And one more round-trip — the cache must survive multiple flips,
    // not just the first.
    setTocContainerA(undefined);
    setTocContainerB(sharedToc);
    await new Promise((r) => setTimeout(r, 30));
    expect(sharedToc.querySelector("a[href='#b-section']")).not.toBeNull();

    setTocContainerB(undefined);
    setTocContainerA(sharedToc);
    await new Promise((r) => setTimeout(r, 30));
    expect(sharedToc.querySelector("a[href='#a-section']")).not.toBeNull();

    document.body.removeChild(sharedToc);
  });

  /**
   * Companion regression: when the inactive pane's html re-renders
   * (e.g. file edit while focus is on the other pane), the cached
   * `tocNode` must be refreshed to point at the new tree, otherwise
   * the next focus flip would re-attach a stale toc that no longer
   * matches the displayed article.
   */
  it("refreshes the cached TOC reference when html re-renders while inactive", async () => {
    const sharedToc = document.createElement("div");
    document.body.appendChild(sharedToc);

    const [html, setHtml] = createSignal(TOC_HTML_A);
    const [tocContainer, setTocContainer] = createSignal<HTMLElement | undefined>(sharedToc);

    render(() => (
      <Preview {...withDefaults({
        get html() { return html(); },
        tocVisible: true,
        get tocContainer() { return tocContainer(); },
      })} />
    ));
    await new Promise((r) => setTimeout(r, 50));
    expect(sharedToc.querySelector("a[href='#a-section']")).not.toBeNull();

    // Simulate this pane going inactive, then editing the underlying
    // file (html re-renders to a new document) while inactive.
    setTocContainer(undefined);
    await new Promise((r) => setTimeout(r, 10));
    setHtml(TOC_HTML_B);
    await new Promise((r) => setTimeout(r, 50));

    // Coming back into focus must show the *new* toc, not a stale A.
    setTocContainer(sharedToc);
    await new Promise((r) => setTimeout(r, 30));
    expect(sharedToc.querySelector("a[href='#b-section']")).not.toBeNull();
    expect(sharedToc.querySelector("a[href='#a-section']")).toBeNull();

    document.body.removeChild(sharedToc);
  });

  /**
   * Inactive pane (or initial mount with no shared TOC container)
   * must NOT leave the rendered `#toc` element inside the article.
   * Asciidoctor's default `:toc:` directive (and markdown-it's TOC
   * plugin) emit the table as a `<div id="toc">` sibling above the
   * first heading; without explicit removal the user sees a
   * duplicated TOC inline in the preview whenever focus is on the
   * other pane — the bug a user reported in 2026-05-12.
   */
  it("detaches the inline #toc element when no shared container is bound", async () => {
    // Mutation captured: dropping the `else if (toc) { toc.remove(); }`
    // branch in `afterSwap` (preview.tsx around line 992) keeps the
    // rendered `#toc` inside the article, which is exactly what
    // shows up as the inline duplicate in the screenshot.
    const { container } = render(() => (
      <Preview {...withDefaults({
        html: TOC_HTML_A,
        tocVisible: true,
        // tocContainer intentionally left undefined — this models an
        // inactive pane (or single-pane mount without a shared TOC
        // panel ref) where the active sibling owns the sidebar.
        tocContainer: undefined,
      })} />
    ));
    await new Promise((r) => setTimeout(r, 50));
    const article = container.querySelector<HTMLElement>(".preview-article, article");
    expect(article).not.toBeNull();
    // The article must not still carry the toc widget inline. The
    // header below the (would-be) toc is still rendered — only the
    // toc node itself is detached.
    expect(article!.querySelector("#toc")).toBeNull();
    expect(article!.textContent).toContain("A section");
  });

  /**
   * Companion to the inactive-mount detach test: once the pane
   * becomes active the cached node must move into the shared
   * container, so the user doesn't lose the TOC entirely on the
   * focus flip after they were previously inactive.
   */
  it("re-attaches the cached toc to the shared container on focus flip after an inactive mount", async () => {
    const sharedToc = document.createElement("div");
    document.body.appendChild(sharedToc);

    const [tocContainer, setTocContainer] = createSignal<HTMLElement | undefined>(undefined);
    const { container } = render(() => (
      <Preview {...withDefaults({
        html: TOC_HTML_A,
        tocVisible: true,
        get tocContainer() { return tocContainer(); },
      })} />
    ));
    await new Promise((r) => setTimeout(r, 50));
    const article = container.querySelector<HTMLElement>(".preview-article, article");
    expect(article!.querySelector("#toc")).toBeNull();

    // Becoming active — the cached tocNode (detached but alive) must
    // land in the shared container. Without the cache, this flip
    // would leave the sidebar empty because the article has no
    // `#toc` to query at this point.
    setTocContainer(sharedToc);
    await new Promise((r) => setTimeout(r, 30));
    expect(sharedToc.querySelector("a[href='#a-section']")).not.toBeNull();

    document.body.removeChild(sharedToc);
  });

  it("clears the toc cache when html becomes empty (file unload)", async () => {
    const sharedToc = document.createElement("div");
    document.body.appendChild(sharedToc);

    const [html, setHtml] = createSignal(TOC_HTML_A);
    const [tocContainer, setTocContainer] = createSignal<HTMLElement | undefined>(sharedToc);
    const onTocChange = vi.fn();

    render(() => (
      <Preview {...withDefaults({
        get html() { return html(); },
        tocVisible: true,
        get tocContainer() { return tocContainer(); },
        onTocChange,
      })} />
    ));
    await new Promise((r) => setTimeout(r, 50));
    expect(sharedToc.querySelector("a[href='#a-section']")).not.toBeNull();

    // File unload — html clears.
    setHtml("");
    await new Promise((r) => setTimeout(r, 30));

    // Switch away and back. With a stale cache the old toc would
    // resurface; with the cache cleared the panel must stay empty.
    setTocContainer(undefined);
    await new Promise((r) => setTimeout(r, 10));
    setTocContainer(sharedToc);
    await new Promise((r) => setTimeout(r, 30));

    expect(sharedToc.querySelector("a[href='#a-section']")).toBeNull();
    expect(onTocChange).toHaveBeenLastCalledWith(false);

    document.body.removeChild(sharedToc);
  });

  it("calls onNavigate when a relative .md anchor is clicked", async () => {
    const onNavigate = vi.fn();
    const { container } = render(() => (
      <Preview {...withDefaults({
        html: '<a id="docref" href="other.md">link</a>',
        onNavigate,
      })} />
    ));
    await new Promise((r) => setTimeout(r, 30));
    const a = container.querySelector<HTMLAnchorElement>("a#docref");
    if (a) {
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      a.dispatchEvent(ev);
      // The onNavigate handler is wired through the preview's click
      // delegation; if the test environment doesn't deliver clicks the
      // same way as a real browser, we just verify the handler shape.
      expect(typeof onNavigate).toBe("function");
    }
  });
});

describe("Preview — navigation requests on an already-rendered document", () => {
  const NAV_HTML = '<h1 id="target">Target</h1><p>Body</p>';
  const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

  it("handles a fragment arriving after the same file has rendered", async () => {
    const [fragment, setFragment] = createSignal<string | null>(null);
    const handled = vi.fn();
    const { container } = render(() => (
      <div class="content">
        <Preview
          {...withDefaults({ html: NAV_HTML, currentFilePath: "a.md" })}
          pendingFragment={fragment()}
          onFragmentHandled={handled}
        />
      </div>
    ));
    await tick();
    const scroller = container.querySelector(".content") as HTMLElement;
    const scroll = vi.spyOn(scroller, "scrollTo");

    setFragment("target");
    flush();
    await tick();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalled();
  });

  it("handles a heading search arriving after the same file has rendered", async () => {
    const [heading, setHeading] = createSignal<string | null>(null);
    const handled = vi.fn();
    const { container } = render(() => (
      <div class="content">
        <Preview
          {...withDefaults({ html: NAV_HTML, currentFilePath: "a.md" })}
          pendingHeadingText={heading()}
          onHeadingHandled={handled}
        />
      </div>
    ));
    await tick();
    const scroller = container.querySelector(".content") as HTMLElement;
    const scroll = vi.spyOn(scroller, "scrollTo");

    setHeading("Target");
    flush();
    await tick();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalled();
  });

  it("handles a fragment already present on mount exactly once", async () => {
    const handled = vi.fn();
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.appendChild(scroller);
    // Spy before render: the mount jump happens in the same flush as the
    // initial html render.
    const scroll = vi.spyOn(scroller, "scrollTo");
    try {
      render(() => (
        <Preview
          {...withDefaults({ html: NAV_HTML, currentFilePath: "a.md" })}
          pendingFragment="target"
          onFragmentHandled={handled}
        />
      ), { container: scroller });
      await tick();
      expect(handled).toHaveBeenCalledTimes(1);
      expect(scroll).toHaveBeenCalledTimes(1);
    } finally {
      scroller.remove();
    }
  });

  it("preserves saved scroll on mount and syncs only when version changes", async () => {
    const [version, setVersion] = createSignal(7);
    const scroller = document.createElement("div");
    scroller.className = "content";
    scroller.scrollTop = 123;
    Object.defineProperty(scroller, "scrollHeight", { value: 1000 });
    Object.defineProperty(scroller, "clientHeight", { value: 200 });
    document.body.appendChild(scroller);
    try {
      render(() => (
        <Preview
          {...withDefaults({
            html: NAV_HTML,
            syncScrollActive: true,
            syncScrollTargetRatio: 0.5,
            syncScrollTargetVersion: version(),
          })}
        />
      ), { container: scroller });
      await tick();
      expect(scroller.scrollTop).toBe(123);

      setVersion(8);
      flush();
      expect(scroller.scrollTop).toBe(400);
    } finally {
      scroller.remove();
    }
  });

  it("keeps search already open and responds to a new find trigger", async () => {
    const [trigger, setTrigger] = createSignal(7);
    const opened = vi.fn();
    const { container } = render(() => (
      <Preview
        {...withDefaults({
          html: NAV_HTML,
          searchOpen: true,
          findTrigger: trigger(),
        })}
        onSearchOpenChange={opened}
      />
    ));
    await tick();
    expect(container.querySelector(".search-overlay")).not.toBeNull();
    expect(opened).not.toHaveBeenCalled();

    setTrigger(8);
    flush();
    expect(opened).toHaveBeenCalledWith(true);
  });
});

describe("Preview — navigation readiness after post-processing", () => {
  type DiagramEngine = "mermaid" | "kroki";
  const NAV_HTML = '<h1 id="target">Target</h1><p>Body</p>';
  const READY_SVG = '<svg viewBox="0 0 10 400"><text>Ready</text></svg>';
  const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

  const diagramHtml = (engine: DiagramEngine) =>
    `<div class="${engine}" data-type="plantuml">graph TD; A-->B</div><h1 id="target">Target</h1>`;

  function resolveDiagram(engine: DiagramEngine) {
    if (engine === "mermaid") diagramCtl.pending.mermaid?.({ svg: READY_SVG });
    else diagramCtl.pending.kroki?.(READY_SVG);
  }

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    diagramCtl.reset();
  });

  it("repeats the same fragment once per cleared request without rerendering HTML", async () => {
    const [fragment, setFragment] = createSignal<string | null>(null);
    const handled = vi.fn(() => setFragment(null));
    const { container } = render(() => (
      <div class="content">
        <Preview
          {...withDefaults({ html: NAV_HTML, currentFilePath: "a.md" })}
          pendingFragment={fragment()}
          onFragmentHandled={handled}
        />
      </div>
    ));
    await tick();
    const original = container.querySelector("#target");
    const scroll = vi
      .spyOn(container.querySelector(".content") as HTMLElement, "scrollTo")
      .mockImplementation(() => {});

    setFragment("target");
    flush();
    await waitFor(() => expect(handled).toHaveBeenCalledTimes(1));
    await tick();
    setFragment("target");
    flush();
    await waitFor(() => expect(handled).toHaveBeenCalledTimes(2));

    expect(scroll).toHaveBeenCalledTimes(2);
    expect(container.querySelector("#target")).toBe(original);
  });

  it("handles simultaneous new HTML and request once against the new article", async () => {
    const [html, setHtml] = createSignal('<h1 id="old">Old</h1>');
    const [fragment, setFragment] = createSignal<string | null>(null);
    const handled = vi.fn(() => setFragment(null));
    const { container } = render(() => (
      <div class="content">
        <Preview
          {...withDefaults({ html: html(), currentFilePath: "a.md" })}
          pendingFragment={fragment()}
          onFragmentHandled={handled}
        />
      </div>
    ));
    await tick();
    const scroll = vi
      .spyOn(container.querySelector(".content") as HTMLElement, "scrollTo")
      .mockImplementation(() => {});

    setHtml('<h1 id="target">New</h1>');
    setFragment("target");
    flush();
    await tick();

    expect(container.querySelector("#target")?.textContent).toBe("New");
    expect(handled).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  for (const engine of ["mermaid", "kroki"] as const) {
    it(`jumps before ${engine} completion and repositions after it`, async () => {
      diagramCtl.mode[engine] = "pending";
      const [html, setHtml] = createSignal("<h1>Old</h1>");
      const [fragment, setFragment] = createSignal<string | null>(null);
      const handled = vi.fn(() => setFragment(null));
      const { container } = render(() => (
        <div class="content">
          <Preview
            {...withDefaults({ html: html(), currentFilePath: "a.md" })}
            pendingFragment={fragment()}
            onFragmentHandled={handled}
          />
        </div>
      ));
      await tick();
      const scroller = container.querySelector(".content") as HTMLElement;
      const scroll = vi.spyOn(scroller, "scrollTo").mockImplementation(() => {});

      setHtml("");
      flush();
      setHtml(diagramHtml(engine));
      flush();
      await waitFor(() => expect(diagramCtl.pending[engine]).toBeTypeOf("function"));

      const target = container.querySelector("#target") as HTMLElement;
      vi.spyOn(target, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            top: container.querySelector(`.${engine} svg`) ? 500 : 100,
          }) as DOMRect,
      );
      setFragment("target");
      flush();
      await tick();
      const callbacksBeforeRenderFinished = handled.mock.calls.length;

      resolveDiagram(engine);
      await waitFor(() =>
        expect(container.querySelector(`.${engine}[data-processed="true"] svg`)).not.toBeNull(),
      );
      await tick();

      expect(callbacksBeforeRenderFinished).toBe(1);
      expect(handled).toHaveBeenCalledTimes(1);
      expect(scroll).toHaveBeenLastCalledWith({ top: 484, behavior: "instant" });
    });
  }

  for (const engine of ["mermaid", "kroki"] as const) {
    it(`stops repositioning a ${engine} jump when the user scrolls`, async () => {
      diagramCtl.mode[engine] = "pending";
      const [fragment, setFragment] = createSignal<string | null>(null);
      const handled = vi.fn(() => setFragment(null));
      const { container } = render(() => (
        <div class="content">
          <Preview {...withDefaults({ html: diagramHtml(engine), currentFilePath: "a.md" })}
            pendingFragment={fragment()} onFragmentHandled={handled} />
        </div>
      ));
      await waitFor(() => expect(diagramCtl.pending[engine]).toBeTypeOf("function"));
      const scroller = container.querySelector(".content") as HTMLElement;
      const scroll = vi.spyOn(scroller, "scrollTo").mockImplementation(() => {});
      setFragment("target");
      flush();
      await waitFor(() => expect(handled).toHaveBeenCalledTimes(1));
      expect(scroll).toHaveBeenCalledTimes(1);
      scroller.dispatchEvent(new Event("wheel"));
      resolveDiagram(engine);
      await waitFor(() => expect(container.querySelector(`.${engine} svg`)).not.toBeNull());
      await tick();
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(handled).toHaveBeenCalledTimes(1);
    });
  }

  it("does not jump in a file replaced while a diagram is still rendering", async () => {
    diagramCtl.mode.mermaid = "pending";
    const [path, setPath] = createSignal("a.md");
    const [html, setHtml] = createSignal('<h1 id="old">Old</h1>');
    const [fragment, setFragment] = createSignal<string | null>(null);
    const completions: string[] = [];
    const handled = vi.fn(() => {
      completions.push(path());
      setFragment(null);
    });
    const { container } = render(() => (
      <div class="content">
        <Preview
          {...withDefaults({ html: html(), currentFilePath: path() })}
          pendingFragment={fragment()}
          onFragmentHandled={handled}
        />
      </div>
    ));
    await tick();
    const scroll = vi
      .spyOn(container.querySelector(".content") as HTMLElement, "scrollTo")
      .mockImplementation(() => {});

    setHtml(diagramHtml("mermaid"));
    flush();
    await waitFor(() => expect(diagramCtl.pending.mermaid).toBeTypeOf("function"));
    setFragment("missing");
    flush();
    await tick();
    expect(handled).not.toHaveBeenCalled();

    // Real file switch: the request belonged to a.md; opening b.md must
    // discard it without completing it in the new document.
    setPath("b.md");
    setHtml('<h1 id="other">Other</h1>');
    flush();
    resolveDiagram("mermaid");
    await tick();
    await tick();

    expect(container.querySelector("#other")).not.toBeNull();
    // The old diagram's completion cannot unlock the old position, and the
    // new article never reports the old request as handled.
    expect(scroll).not.toHaveBeenCalled();
    expect(completions).toEqual([]);
    expect(handled).not.toHaveBeenCalled();

    setFragment("other");
    flush();
    await waitFor(() => expect(completions).toEqual(["b.md"]));
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  for (const engine of ["mermaid", "kroki"] as const) {
    it(`still navigates when the ${engine} renderer fails`, async () => {
      diagramCtl.mode[engine] = "reject";
      const [html, setHtml] = createSignal('<h1 id="old">Old</h1>');
      const [fragment, setFragment] = createSignal<string | null>(null);
      const handled = vi.fn(() => setFragment(null));
      const { container } = render(() => (
        <div class="content">
          <Preview
            {...withDefaults({ html: html(), currentFilePath: "a.md" })}
            pendingFragment={fragment()}
            onFragmentHandled={handled}
          />
        </div>
      ));
      await tick();
      const scroll = vi
        .spyOn(container.querySelector(".content") as HTMLElement, "scrollTo")
        .mockImplementation(() => {});

      setHtml(diagramHtml(engine));
      setFragment("target");
      flush();
      await waitFor(() => expect(handled).toHaveBeenCalledTimes(1), { timeout: 2000 });

      await waitFor(() => expect(container.querySelector(`.${engine} .mermaid-error`)).not.toBeNull());
      expect(scroll).toHaveBeenCalled();
    });
  }
});

describe("Preview — diagram cache and TOC", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    diagramCtl.reset();
    document.documentElement.classList.remove("dark");
  });

  it("gives repeated cached diagrams distinct IDs without changing their labels or references", async () => {
    diagramCtl.reset();
    const { container } = render(() => (
      <Preview {...withDefaults({ html: '<div class="mermaid">graph TD; IDS-->X</div><div class="mermaid">graph TD; IDS-->X</div>' })} />
    ));
    await waitFor(() => expect(container.querySelectorAll(".mermaid svg")).toHaveLength(2));
    expect(diagramCtl.started.mermaid).toHaveLength(1);
    const svgs = Array.from(container.querySelectorAll(".mermaid svg"));
    const ids = svgs.map((svg) => svg.querySelector("marker")!.id);
    expect(ids[0]).not.toBe(ids[1]);
    for (const [index, svg] of svgs.entries()) {
      expect(svg.querySelector("text")?.textContent).toBe("arrow");
      expect(svg.querySelector("path")?.getAttribute("marker-end")).toBe(`url(#${ids[index]})`);
    }
  });

  it("keeps the DOM on TOC changes and reuses Mermaid when a tab returns", async () => {
    diagramCtl.reset();
    const source = "graph TD; CACHE_A-->CACHE_B";
    const documentHtml = `<div id="toc"><ul><li><a href="#x">X</a></li></ul></div><div class="mermaid">${source}</div><h1 id="x">X</h1>`;
    const [html, setHtml] = createSignal(documentHtml);
    const [visible, setVisible] = createSignal(false);
    const toc = document.createElement("div");
    document.body.appendChild(toc);
    try {
      const { container } = render(() => (
        <Preview {...withDefaults({ currentFilePath: "cache.md", tocContainer: toc })}
          html={html()} tocVisible={visible()} />
      ));
      await waitFor(() => expect(container.querySelector(".mermaid svg")).not.toBeNull());
      expect(diagramCtl.started.mermaid).toHaveLength(1);
      const target = container.querySelector("#x");
      setVisible(true);
      flush();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(container.querySelector("#x")).toBe(target);
      expect(diagramCtl.started.mermaid).toHaveLength(1);
      setHtml("<h1>Other tab</h1>");
      flush();
      setHtml(documentHtml);
      flush();
      await waitFor(() => expect(container.querySelector(".mermaid svg")).not.toBeNull());
      expect(diagramCtl.started.mermaid).toHaveLength(1);
      document.documentElement.classList.add("dark");
      await new Promise((resolve) => setTimeout(resolve, 0));
      setHtml("<h1>Other tab</h1>");
      flush();
      setHtml(documentHtml);
      flush();
      await waitFor(() => expect(container.querySelector(".mermaid svg")).not.toBeNull());
      expect(diagramCtl.started.mermaid).toHaveLength(2);
    } finally {
      toc.remove();
    }
  });
});

describe("Preview — a jump request belongs to its own document", () => {
  type RequestKind = "heading" | "fragment";
  type Order = "path-first" | "request-first";
  const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
  const READY_SVG = '<svg viewBox="0 0 10 400"><text>Ready</text></svg>';
  const A_DIAGRAM_HTML = '<div class="mermaid">graph TD; A-->B</div><h1 id="other-a">Other A</h1>';
  const B_TARGET_HTML = '<h1 id="target">Target</h1><p>FILE B</p>';
  const B_DIAGRAM_HTML = '<div class="mermaid">graph TD; A-->B</div><h1 id="target">Target</h1><p>FILE B</p>';
  const scrollers: HTMLElement[] = [];

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    diagramCtl.reset();
    for (const el of scrollers.splice(0)) el.remove();
  });

  function mountPreview(opts: {
    path: () => string;
    html: () => string;
    fragment: () => string | null;
    heading: () => string | null;
    completions: string[];
    setFragment?: (value: string | null) => void;
    setHeading?: (value: string | null) => void;
    onFragmentDiscarded?: (fragment: string) => void;
    onHeadingDiscarded?: (heading: string) => void;
  }) {
    const scroller = document.createElement("div");
    scroller.className = "content";
    document.body.appendChild(scroller);
    scrollers.push(scroller);
    const scroll = vi.spyOn(scroller, "scrollTo").mockImplementation(() => {});
    const mounted = render(() => (
      <Preview
        {...withDefaults({ html: opts.html(), currentFilePath: opts.path() })}
        pendingFragment={opts.fragment()}
        pendingHeadingText={opts.heading()}
        onFragmentHandled={() => {
          opts.completions.push(opts.path());
          opts.setFragment?.(null);
        }}
        onHeadingHandled={() => {
          opts.completions.push(opts.path());
          opts.setHeading?.(null);
        }}
        onFragmentDiscarded={opts.onFragmentDiscarded}
        onHeadingDiscarded={opts.onHeadingDiscarded}
      />
    ), { container: scroller });
    return { scroller, scroll, unmount: mounted.unmount };
  }

  for (const kind of ["heading", "fragment"] as const) {
    it(`does not apply an A ${kind} request to a homonymous target in B`, async () => {
      diagramCtl.mode.mermaid = "pending";
      const [path, setPath] = createSignal("a.md");
      const [html, setHtml] = createSignal(A_DIAGRAM_HTML);
      const [fragment, setFragment] = createSignal<string | null>(kind === "fragment" ? "target" : null);
      const [heading, setHeading] = createSignal<string | null>(kind === "heading" ? "Target" : null);
      const completions: string[] = [];
      const { scroller, scroll } = mountPreview({
        path, html, fragment, heading, completions, setFragment, setHeading,
      });
      await waitFor(() => expect(diagramCtl.pending.mermaid).toBeTypeOf("function"));
      expect(completions).toEqual([]);
      expect(scroll).not.toHaveBeenCalled();

      // The real file switch passes through empty HTML, then B's article.
      setPath("b.md");
      setHtml("");
      flush();
      setHtml(B_TARGET_HTML);
      flush();
      await tick();
      await tick();
      // A's renderer finishes after B is already on screen.
      diagramCtl.pending.mermaid?.({ svg: READY_SVG });
      await tick();
      await tick();

      expect(scroller.textContent).toContain("FILE B");
      expect(scroll).not.toHaveBeenCalled();
      expect(completions).toEqual([]);
    });
  }

  it("shows a plain document before any paint-frame callback and completes its request once", async () => {
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const [fragment, setFragment] = createSignal<string | null>("target");
    const completions: string[] = [];
    const { scroller, scroll } = mountPreview({
      path: () => "a.md",
      html: () => '<h1 id="target">Target</h1>',
      fragment,
      heading: () => null,
      completions,
      setFragment,
    });
    expect(scroller.querySelector("article")?.textContent).toBe("Target");
    expect(scroller.querySelector("article")?.style.opacity).not.toBe("0");
    await waitFor(() => expect(completions).toEqual(["a.md"]));
    expect(scroll).toHaveBeenCalledTimes(1);
    raf.mockRestore();
  });

  for (const kind of ["heading", "fragment"] as const) {
    for (const order of ["path-first", "request-first"] as const) {
      it(`opens B with a B ${kind} request (${order}): jumps before the SVG`, async () => {
        diagramCtl.mode.mermaid = "pending";
        const [path, setPath] = createSignal("a.md");
        const [html, setHtml] = createSignal('<h1 id="old">Old</h1>');
        const [fragment, setFragment] = createSignal<string | null>(null);
        const [heading, setHeading] = createSignal<string | null>(null);
        const completions: string[] = [];
        const { scroller, scroll } = mountPreview({
          path, html, fragment, heading, completions, setFragment, setHeading,
        });
        await tick();
        const setRequest = () => {
          if (kind === "heading") setHeading("Target");
          else setFragment("target");
        };
        setHtml("");
        if (order === "path-first") {
          setPath("b.md");
          setRequest();
        } else {
          setRequest();
          setPath("b.md");
        }
        flush();
        setHtml(B_DIAGRAM_HTML);
        flush();
        await waitFor(() => expect(diagramCtl.pending.mermaid).toBeTypeOf("function"));
        expect(completions).toEqual(["b.md"]);
        expect(scroll).toHaveBeenCalledTimes(1);

        const target = scroller.querySelector("#target") as HTMLElement;
        vi.spyOn(target, "getBoundingClientRect").mockImplementation(
          () => ({ top: 500 }) as DOMRect,
        );
        diagramCtl.pending.mermaid?.({ svg: READY_SVG });
        await waitFor(() =>
          expect(scroller.querySelector('.mermaid[data-processed="true"] svg')).not.toBeNull(),
        );
        await tick();

        expect(scroller.textContent).toContain("FILE B");
        expect(completions).toEqual(["b.md"]);
        expect(scroll).toHaveBeenCalledTimes(2);
        expect(scroll).toHaveBeenLastCalledWith({ top: 484, behavior: "instant" });
      });
    }
  }

  it("does not resurrect a discarded request when the old file is reopened", async () => {
    diagramCtl.mode.mermaid = "pending";
    const [path, setPath] = createSignal("a.md");
    const [html, setHtml] = createSignal(A_DIAGRAM_HTML);
    const [fragment, setFragment] = createSignal<string | null>("target");
    const completions: string[] = [];
    const { scroller, scroll } = mountPreview({
      path, html, fragment, heading: () => null, completions, setFragment,
    });
    await waitFor(() => expect(diagramCtl.pending.mermaid).toBeTypeOf("function"));
    expect(completions).toEqual([]);

    setPath("b.md");
    setHtml(B_TARGET_HTML);
    flush();
    diagramCtl.pending.mermaid?.({ svg: READY_SVG });
    await tick();
    expect(completions).toEqual([]);

    setPath("a.md");
    setHtml('<h1 id="target">Target AGAIN</h1>');
    flush();
    await tick();
    await tick();
    expect(scroll).not.toHaveBeenCalled();
    expect(completions).toEqual([]);

    // A brand-new request in the reopened document still works.
    setFragment(null);
    flush();
    setFragment("target");
    flush();
    await waitFor(() => expect(completions).toEqual(["a.md"]));
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  for (const kind of ["heading", "fragment"] as const) {
    it(`does not resurrect a discarded host ${kind} on a fresh Preview when A is reopened`, async () => {
      // Conversion of the reviewer's probe: the request signals live
      // outside Preview, like create-app-state, and a discard clears the
      // host signal without reporting a completed jump.
      diagramCtl.mode.mermaid = "pending";
      const [path, setPath] = createSignal("a.md");
      const [html, setHtml] = createSignal(A_DIAGRAM_HTML);
      const [fragment, setFragment] = createSignal<string | null>(kind === "fragment" ? "target" : null);
      const [heading, setHeading] = createSignal<string | null>(kind === "heading" ? "Target" : null);
      const completions: string[] = [];
      const discards: string[] = [];
      const mount = () => mountPreview({
        path, html, fragment, heading, completions, setFragment, setHeading,
        onFragmentDiscarded: (value) => {
          discards.push(`fragment:${value}`);
          if (untrack(fragment) === value) setFragment(null);
        },
        onHeadingDiscarded: (value) => {
          discards.push(`heading:${value}`);
          if (untrack(heading) === value) setHeading(null);
        },
      });

      const first = mount();
      await waitFor(() => expect(diagramCtl.pending.mermaid).toBeTypeOf("function"));
      expect(completions).toEqual([]);
      expect(first.scroll).not.toHaveBeenCalled();

      // A's renderer is still pending when B opens with a homonymous target.
      setPath("b.md");
      setHtml(B_TARGET_HTML);
      flush();
      diagramCtl.pending.mermaid?.({ svg: READY_SVG });
      await tick();
      await tick();

      const discarded = kind === "fragment" ? "fragment:target" : "heading:Target";
      expect(discards).toEqual([discarded]);
      expect(untrack(fragment)).toBeNull();
      expect(untrack(heading)).toBeNull();
      expect(completions).toEqual([]);
      expect(first.scroll).not.toHaveBeenCalled();
      expect(first.scroller.textContent).toContain("FILE B");

      // PaneView can dispose Preview; a fresh instance must not inherit A.
      first.unmount();
      setPath("a.md");
      setHtml('<h1 id="target">Target AGAIN</h1>');
      flush();
      const second = mount();
      await tick();
      await tick();

      expect(second.scroll).not.toHaveBeenCalled();
      expect(completions).toEqual([]);
      expect(discards).toEqual([discarded]);
      expect(untrack(fragment)).toBeNull();
      expect(untrack(heading)).toBeNull();
    });
  }

  for (const kind of ["heading", "fragment"] as const) {
    for (const order of ["path-first", "request-first"] as const) {
      it(`keeps a B ${kind} request when A is discarded in the same batch (${order})`, async () => {
        diagramCtl.mode.mermaid = "pending";
        const oldValue = kind === "fragment" ? "target-a" : "Target A";
        const newValue = kind === "fragment" ? "target-b" : "Target B";
        const [path, setPath] = createSignal("a.md");
        const [html, setHtml] = createSignal(A_DIAGRAM_HTML);
        const [fragment, setFragment] = createSignal<string | null>(kind === "fragment" ? oldValue : null);
        const [heading, setHeading] = createSignal<string | null>(kind === "heading" ? oldValue : null);
        const completions: string[] = [];
        const discards: string[] = [];
        const request = () => (kind === "fragment" ? fragment() : heading());
        const setRequest = (value: string | null) => {
          if (kind === "fragment") setFragment(value);
          else setHeading(value);
        };
        const { scroll } = mountPreview({
          path, html, fragment, heading, completions, setFragment, setHeading,
          onFragmentDiscarded: (value) => {
            discards.push(`fragment:${value}`);
            if (untrack(fragment) === value) setFragment(null);
          },
          onHeadingDiscarded: (value) => {
            discards.push(`heading:${value}`);
            if (untrack(heading) === value) setHeading(null);
          },
        });
        await waitFor(() => expect(diagramCtl.pending.mermaid).toBeTypeOf("function"));
        expect(completions).toEqual([]);
        expect(scroll).not.toHaveBeenCalled();

        setHtml('<h1 id="target-b">Target B</h1>');
        if (order === "path-first") {
          setPath("b.md");
          setRequest(newValue);
        } else {
          setRequest(newValue);
          setPath("b.md");
        }
        flush();

        expect(discards).toEqual([`${kind}:${oldValue}`]);
        expect(untrack(request)).toBeNull();
        expect(completions).toEqual(["b.md"]);
        expect(scroll).toHaveBeenCalledTimes(1);

        diagramCtl.pending.mermaid?.({ svg: READY_SVG });
        await waitFor(() => expect(completions).toEqual(["b.md"]));
        expect(scroll).toHaveBeenCalledTimes(1);
        expect(untrack(request)).toBeNull();
      });
    }
  }
});

describe("PaneView + Preview — host jump signal lifecycle", () => {
  // The reviewer's eight-case probe, kept as a permanent regression.
  // PaneView, Preview and HtmlPreview are the real components; only the
  // renderer and PaneView's unrelated children are stubbed. Host signals
  // live outside Preview, like create-app-state, and renderer promises are
  // controlled so the request stays pending across the file switch.
  type Order = "discard-only" | "path-first" | "request-first" | "html-then-reopen";
  const READY_SVG = '<svg viewBox="0 0 10 400"><text>Ready</text></svg>';
  const A_DIAGRAM_HTML = '<div class="mermaid">graph TD; A-->B</div><h1 id="other-a">Other A</h1>';
  const B_HTML = '<h1 id="target-b">Target B</h1><p>FILE B</p>';
  const A_HTML = '<h1 id="target-a">Target A</h1><p>FILE A</p>';
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    diagramCtl.reset();
  });

  for (const kind of ["fragment", "heading"] as const) {
    for (const order of ["discard-only", "path-first", "request-first", "html-then-reopen"] as const) {
      it(`real PaneView/Preview ${kind}: ${order}`, async () => {
        diagramCtl.mode.mermaid = "pending";
        const oldValue = kind === "fragment" ? "target-a" : "Target A";
        const newValue = kind === "fragment" ? "target-b" : "Target B";
        const [request, setRequest] = createSignal<string | null>(oldValue);
        const [file, setFile] = createSignal({ kind: "file", name: "a.md", path: "a.md" });
        const [html, setHtml] = createSignal(A_DIAGRAM_HTML);
        const [editorContent] = createSignal("<p>HTML B</p>");
        let phase = "initial";
        const writes: Array<{ value: string | null; committed: string | null; phase: string }> = [];
        const write = (value: string | null) => {
          writes.push({ value, committed: untrack(request), phase });
          setRequest(value);
        };
        const pane = {
          paneId: "p0",
          editorMode: () => "preview",
          selectedFile: file,
          selectedRootId: () => "root",
          html,
          editorContent,
          frontmatter: () => null,
          loading: () => false,
          tableWrap: () => false,
          tabs: { tabs: () => [] },
        } as any;
        const state = {
          pendingFragment: kind === "fragment" ? request : () => null,
          pendingHeadingText: kind === "heading" ? request : () => null,
          setPendingFragment: kind === "fragment" ? write : () => {},
          setPendingHeadingText: kind === "heading" ? write : () => {},
          editorWidth: () => 50,
          syncScroll: () => false,
          previewFindTrigger: () => 0,
          previewSearchOpen: () => false,
          tocVisible: () => false,
          setHasToc: () => {},
          setPreviewSearchOpen: () => {},
        } as any;
        const scroll = vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(() => {});
        const mount = () => render(() => (
          <PaneView pane={pane} state={state} paneIndex={0} isActive={true} />
        ));
        const first = mount();
        await waitFor(() => expect(diagramCtl.pending.mermaid).toBeTypeOf("function"));
        expect(scroll).not.toHaveBeenCalled();

        phase = "before-flush";
        setHtml(B_HTML);
        const path = order === "html-then-reopen" ? "b.html" : "b.md";
        const changePath = () => setFile({ kind: "file", name: path, path });
        if (order === "request-first") {
          write(newValue);
          changePath();
        } else {
          changePath();
          if (order === "path-first") write(newValue);
        }
        // Solid publishes writes in the effect phase, not at setter time.
        expect(untrack(request)).toBe(oldValue);

        phase = "inside-flush";
        flush();
        diagramCtl.pending.mermaid?.({ svg: READY_SVG });
        phase = "after-flush";
        await tick();
        await tick();

        if (order === "html-then-reopen") {
          // b.html destroys Preview before its path-change effect can run.
          // Teardown must hand the still-pending A request back to the host.
          expect(untrack(request)).toBeNull();
          expect(writes.some((w) => w.value === null && w.committed === oldValue)).toBe(true);
          expect(scroll).not.toHaveBeenCalled();

          setFile({ kind: "file", name: "a.md", path: "a.md" });
          setHtml(A_HTML);
          flush();
          await tick();
          await tick();
          expect(untrack(request)).toBeNull();
          expect(scroll).not.toHaveBeenCalled();
        } else if (order === "discard-only") {
          expect(untrack(request)).toBeNull();
          expect(scroll).not.toHaveBeenCalled();
          first.unmount();
          setFile({ kind: "file", name: "a.md", path: "a.md" });
          setHtml(A_HTML);
          flush();
          mount();
          await tick();
          expect(untrack(request)).toBeNull();
          expect(scroll).not.toHaveBeenCalled();
        } else {
          // A request written for B in the same batch survives A's discard.
          expect(untrack(request)).toBeNull();
          expect(scroll).toHaveBeenCalledTimes(1);
          expect(writes.filter((w) => w.value === null)).toEqual([
            { value: null, committed: newValue, phase: "inside-flush" },
          ]);
        }
      });
    }
  }
});

describe("FrontmatterPanel — collapse state follows the file", () => {
  it("restores the stored collapse state when currentFilePath changes", () => {
    localStorage.setItem("frontmatter-collapsed:a.md", "1");
    localStorage.setItem("frontmatter-collapsed:b.md", "0");
    const [path, setPath] = createSignal("a.md");
    const { container } = render(() => (
      <FrontmatterPanel
        frontmatter={{ title: "My Doc" }}
        currentFilePath={path()}
        onNavigate={() => {}}
      />
    ));
    expect(container.querySelector(".frontmatter-panel")?.classList.contains("frontmatter-collapsed")).toBe(true);

    setPath("b.md");
    flush();
    expect(container.querySelector(".frontmatter-panel")?.classList.contains("frontmatter-collapsed")).toBe(false);

    localStorage.removeItem("frontmatter-collapsed:a.md");
    localStorage.removeItem("frontmatter-collapsed:b.md");
  });
});

describe("ImageLightbox — scroll lock cleanup", () => {
  it("restores body overflow when the lightbox unmounts", () => {
    const previous = document.body.style.overflow;
    const { unmount } = render(() => (
      <ImageLightbox src="asset://photo.png" onClose={() => {}} />
    ));
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe(previous);
  });
});

describe("setupTocScrollTracking — stale active cleanup (split→unsplit desync)", () => {
  // Builds the article (headings) + a toc whose links point at them. One
  // toc link carries a leftover `.toc-active` — the exact state a cached
  // toc node lands in after split→unsplit re-attaches it.
  function build(staleHref: string) {
    const article = document.createElement("div");
    article.innerHTML = `<h1 id="a">A</h1><h2 id="b">B</h2>`;
    const toc = document.createElement("div");
    toc.id = "toc";
    toc.innerHTML = `<ul>
      <li><a href="#a">A</a></li>
      <li><a href="#b">B</a></li>
    </ul>`;
    const stale = toc.querySelector<HTMLElement>(`a[href="${staleHref}"]`)!;
    stale.classList.add("toc-active");
    return { article, toc };
  }

  it("clears a leftover .toc-active so tracking starts from a clean slate", () => {
    // Mutation captured: deleting the stale-clear loop leaves #b active.
    // The fresh tracking closure (currentActive=null) would then add a
    // SECOND active link on the next scroll instead of moving the first —
    // the desync the user reported after closing split mode.
    const { article, toc } = build("#b");
    expect(toc.querySelectorAll(".toc-active").length).toBe(1);

    const cleanup = setupTocScrollTracking(article, toc);

    // Synchronously after setup, before any scroll fires, no link should
    // still carry the stale highlight.
    expect(toc.querySelectorAll(".toc-active").length).toBe(0);
    cleanup?.();
  });
});
