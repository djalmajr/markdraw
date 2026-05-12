import { Show, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import mermaid from "mermaid";
import Prism from "prismjs";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-css";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-java";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-python";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-ini";
import { SearchOverlay } from "./search-overlay.tsx";
import { DiagramViewer } from "./diagram-viewer.tsx";
import { FrontmatterPanel } from "./frontmatter-panel.tsx";
import { renderKroki } from "@asciimark/core/kroki.ts";
import type { Frontmatter } from "@asciimark/core/frontmatter.ts";
import "katex/dist/katex.min.css";
import "@mdit/plugin-alert/style";
import "../styles/asciidoc.css";

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait until the next paint frame. Mermaid's render measures
 *  bounding-rect / font geometry of a temp container in
 *  document.body; running it on the same tick the article was
 *  attached to the DOM lets it execute before layout has settled
 *  and trips `null is not an object (evaluating 'element.firstChild')`
 *  because the SVG root never got its initial measurements. One
 *  rAF after the swap is the cheapest way to guarantee layout. */
function nextPaintFrame(): Promise<void> {
  return new Promise((resolve) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(() => resolve())
      : setTimeout(resolve, 16),
  );
}

const BLOCKED_TAGS = new Set([
  "applet",
  "base",
  "embed",
  "frame",
  "frameset",
  "iframe",
  "link",
  "meta",
  "object",
  "script",
  "style",
]);

const URL_ATTRIBUTES = new Set(["action", "formaction", "href", "src", "xlink:href"]);

function isUnsafeUrl(rawValue: string): boolean {
  const normalized = rawValue.replace(/[\u0000-\u001F\u007F\s]+/g, "").toLowerCase();
  return normalized.startsWith("javascript:")
    || normalized.startsWith("vbscript:")
    || normalized.startsWith("data:text/html");
}

function sanitizeHtmlFragment(input: string): string {
  const doc = new DOMParser().parseFromString(input, "text/html");

  for (const el of Array.from(doc.querySelectorAll("*"))) {
    const tagName = el.tagName.toLowerCase();
    if (BLOCKED_TAGS.has(tagName)) {
      el.remove();
      continue;
    }

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc") {
        el.removeAttribute(attr.name);
        continue;
      }

      if (URL_ATTRIBUTES.has(name) && isUnsafeUrl(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }

  return doc.body.innerHTML;
}

let mermaidInitialized = false;
let mermaidWarmPromise: Promise<void> | null = null;

function initMermaid(force = false) {
  if (mermaidInitialized && !force) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
    securityLevel: "strict",
    fontFamily: "inherit",
  });
  mermaidInitialized = true;
}

/**
 * Pre-warm mermaid so the first user-facing render doesn't race
 * with internal lazy-init + font measurement. The very first
 * `mermaid.render()` after a fresh page load occasionally throws
 * `null is not an object (evaluating 'element.firstChild')` —
 * subsequent calls work because the lib is now warm. Running a
 * throwaway tiny diagram once per session pays the cost upfront.
 *
 * Memoized as a single shared promise: every Preview instance
 * (split panes, multiple files in sequence) shares the same warm
 * state, and the wait collapses to a no-op after the first
 * resolve. Errors are intentionally swallowed — pre-warm is
 * best-effort and the real render still has its own catch path.
 */
function ensureMermaidWarm(): Promise<void> {
  if (mermaidWarmPromise) return mermaidWarmPromise;
  mermaidWarmPromise = (async () => {
    initMermaid();
    // Wait for fonts before measurement-heavy rendering — mermaid
    // sizes nodes against text width and a missing font can give
    // a 0-width SVG that trips internal `firstChild` walks.
    if (typeof document !== "undefined" && document.fonts?.ready) {
      try { await document.fonts.ready; } catch { /* ignore */ }
    }
    // Kitchen-sink pre-warm: exercise the shape renderers we
    // typically see in user docs (box, rounded, diamond, cylinder,
    // labelled edges). Mermaid lazy-loads per-shape modules — a
    // trivial `A-->B` warm-up wasn't enough because the FIRST real
    // render with new shapes still tripped the firstChild race.
    try {
      await mermaid.render(
        "mermaid-prewarm",
        "graph LR\nA[box] --> B(rounded)\nB --> C{diamond}\nC -->|label| D[(cylinder)]\nD --> E([stadium])",
      );
    } catch (e) {
      console.warn("[mermaid] pre-warm failed", e);
    }
    // Clean up any temp dmermaid- divs the warm-up may have left.
    document.querySelectorAll('div[id^="dmermaid-"]').forEach((el) => el.remove());
  })();
  return mermaidWarmPromise;
}

/**
 * Per-render cancellation token. Each `Preview` instance owns its own
 * monotonic counter (see `renderGen` declared inside the component
 * body) — module-level state was shared across split panes, and a
 * file switch in pane 1 was incrementing the counter that pane 0's
 * in-flight microtasks were watching, causing them to abort stale
 * (and leaving pane 1 with an empty article when its own microtask
 * hit a stale check on the way back).
 *
 * The async post-processors (highlight / mermaid / kroki) take a
 * predicate they call between awaits to decide whether to bail out.
 */
type IsStaleFn = (gen: number) => boolean;

/** Placeholder for code-block post-processing (kept for render pipeline symmetry) */
const LANGUAGE_ALIASES: Record<string, string> = {
  "c++": "cpp",
  "c#": "csharp",
  conf: "ini",
  dockerfile: "docker",
  js: "javascript",
  shell: "bash",
  sh: "bash",
  ts: "typescript",
  yml: "yaml",
  zsh: "bash",
};

function detectCodeLanguage(codeEl: HTMLElement): string | null {
  const fromClass = codeEl.className.match(/\b(?:language|lang)-([a-z0-9+#._-]+)\b/i)?.[1];
  const fromData =
    codeEl.getAttribute("data-lang") ||
    codeEl.parentElement?.getAttribute("data-lang") ||
    codeEl.getAttribute("data-language");

  const rawLanguage = (fromClass || fromData || "").trim().toLowerCase();
  if (!rawLanguage) return null;

  const normalized = LANGUAGE_ALIASES[rawLanguage] || rawLanguage;
  return Object.prototype.hasOwnProperty.call(Prism.languages, normalized)
    ? normalized
    : null;
}

async function highlightCodeBlocks(
  container: HTMLElement,
  gen: number,
  isStale: IsStaleFn,
): Promise<void> {
  if (isStale(gen)) return;
  const blocks = container.querySelectorAll<HTMLElement>("pre code");
  for (const codeEl of blocks) {
    if (isStale(gen)) return;

    const language = detectCodeLanguage(codeEl);
    if (!language) continue;

    codeEl.classList.add(`language-${language}`);
    const preEl = codeEl.parentElement;
    if (preEl) {
      preEl.classList.add(`language-${language}`);
    }

    Prism.highlightElement(codeEl);
    await yieldToMain();
  }
}

async function renderMermaidBlocks(
  container: HTMLElement,
  gen: number,
  isStale: IsStaleFn,
): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>("div.mermaid");
  if (blocks.length === 0) return;

  // Pre-warm before the first user-facing render so the lib has
  // fonts + internals ready. After the first resolve this is a
  // no-op (memoized promise).
  await ensureMermaidWarm();
  if (isStale(gen)) return;
  // Theme refresh — re-init only if the dark/light theme switched
  // since the last warm-up (the MutationObserver in onMount flips
  // `mermaidInitialized` back to false on theme change). A
  // force-init on every render was throwing away the warm state
  // and reintroducing the firstChild race on block 0.
  initMermaid();

  let idx = 0;
  for (const block of blocks) {
    // Bail out if a newer render has started (navigation happened mid-render)
    if (isStale(gen)) return;

    if (block.getAttribute("data-processed")) continue;

    const source = block.textContent?.trim() ?? "";
    if (!source) continue;

    try {
      // Mermaid sometimes throws `null is not an object (evaluating
      // 'element.firstChild')` on the very first render of complex
      // shapes — internal lazy module loading + layout race that
      // pre-warm doesn't fully cover for every shape combination.
      // Real syntax errors fail every attempt and fall through to
      // the outer catch; transient races resolve within a couple
      // of frames. Three attempts with growing delays cover both
      // observed flake patterns without slowing valid renders
      // (success on attempt 1 short-circuits).
      const baseId = `mermaid-${gen}-${idx++}`;
      let svg: string | undefined;
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (isStale(gen)) return;
        const attemptId = attempt === 0 ? baseId : `${baseId}-retry`;
        try {
          const result = await mermaid.render(attemptId, source);
          if (result?.svg) {
            svg = result.svg;
            break;
          }
          lastErr = new Error("mermaid render returned empty svg");
        } catch (err) {
          lastErr = err;
        }
        // Layout-settling pause between attempts — most flakes
        // resolve within one paint frame.
        await nextPaintFrame();
      }
      if (!svg) throw lastErr ?? new Error("mermaid render produced no output");
      // Check again after await — DOM may have been replaced
      if (isStale(gen)) return;
      // mermaid.render returns sanitized SVG — safe to inject
      block.innerHTML = svg;
    } catch (e: any) {
      if (isStale(gen)) return;
      const errMsg = e?.message || "Unknown error";
      const escaped = source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      // Error message is escaped above — safe to inject
      block.innerHTML = `<pre class="mermaid-error">Mermaid error: ${errMsg.replace(/</g, "&lt;")}\n\n${escaped}</pre>`;
    }

    // Always mark as processed to prevent re-processing on effect re-runs
    block.setAttribute("data-processed", "true");

    // Clean up temporary render containers mermaid leaves in the body
    document.querySelectorAll('div[id^="dmermaid-"]').forEach((el) => el.remove());

    await yieldToMain();
  }
}

/**
 * Walk all `<img>` elements in `container` and rewrite their `src` using the
 * provided `resolve` callback. Used to make relative image paths in the
 * source document (markdown ![](path) or asciidoc image::path[]) loadable
 * inside the webview, by mapping them to a Tauri asset URL.
 *
 * The callback should return `null` for already-absolute URLs so the
 * original src is left intact.
 */
function rewriteImageSources(
  container: HTMLElement,
  resolve: (src: string) => string | null,
): void {
  const imgs = container.querySelectorAll<HTMLImageElement>("img");
  for (const img of imgs) {
    const src = img.getAttribute("src");
    if (!src) continue;
    const resolved = resolve(src);
    if (resolved) img.setAttribute("src", resolved);
  }
}

/**
 * Wrap every <table> in a `.table-wrapper` div so wide tables get a horizontal
 * scroll without breaking the table's native border-collapse behavior. The
 * markdown-it / asciidoctor renderers don't emit a wrapper, so we add it here.
 */
function wrapTablesForScroll(container: HTMLElement): void {
  const tables = container.querySelectorAll<HTMLTableElement>("table");
  for (const table of tables) {
    // Skip tables already wrapped (covers re-runs of the effect on the same DOM)
    if (table.parentElement?.classList.contains("table-wrapper")) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "table-wrapper";
    table.parentElement?.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  }
}

/** Render Kroki diagram blocks (plantuml, graphviz, ditaa, etc.) */
async function renderKrokiBlocks(
  container: HTMLElement,
  gen: number,
  isStale: IsStaleFn,
): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>("div.kroki");
  for (const block of blocks) {
    if (isStale(gen)) return;
    if (block.getAttribute("data-processed") === "true") continue;
    block.setAttribute("data-processed", "true");

    const type = block.getAttribute("data-type") || "plantuml";
      const source = block.textContent || "";
      if (!source.trim()) continue;

    block.textContent = "Rendering diagram...";
    block.style.color = "hsl(var(--muted-foreground))";
    block.style.fontStyle = "italic";

    try {
      const svg = await renderKroki(type, source);
      if (isStale(gen)) return;
      block.style.color = "";
      block.style.fontStyle = "";
      // renderKroki returns SVG from an external service, sanitize before inject
      block.innerHTML = sanitizeHtmlFragment(svg);
    } catch (e: any) {
      if (isStale(gen)) return;
      const escaped = source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      // Error message is escaped above
      block.innerHTML = `<pre class="mermaid-error">Kroki error (${type}): ${e?.message || "Unknown"}\n\n${escaped}</pre>`;
      block.style.color = "";
      block.style.fontStyle = "";
    }

    await yieldToMain();
  }
}

/** Add collapse/expand toggles to TOC items that have children */
function setupTocCollapse(tocEl: HTMLElement): () => void {
  const toggleHandlers: { el: HTMLElement; handler: EventListener; keyHandler: EventListener }[] = [];

  for (const li of tocEl.querySelectorAll<HTMLLIElement>("li")) {
    const childUl = li.querySelector(":scope > ul");
    if (!childUl) continue;

    const toggle = document.createElement("span");
    toggle.className = "toc-toggle";
    toggle.setAttribute("role", "button");
    toggle.setAttribute("tabindex", "0");
    toggle.setAttribute("aria-label", "Toggle section");
    toggle.setAttribute("aria-expanded", "true");

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "12");
    svg.setAttribute("height", "12");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.setAttribute("points", "9 18 15 12 9 6");
    svg.appendChild(polyline);
    toggle.appendChild(svg);

    li.classList.add("toc-collapsible", "toc-expanded");
    li.insertBefore(toggle, li.firstChild);

    const doToggle = () => {
      li.classList.toggle("toc-expanded");
      li.classList.toggle("toc-collapsed");
      toggle.setAttribute("aria-expanded", String(li.classList.contains("toc-expanded")));
    };

    const handler = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      doToggle();
    };

    const keyHandler = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" || ke.key === " ") {
        ke.preventDefault();
        doToggle();
      }
    };

    toggle.addEventListener("click", handler);
    toggle.addEventListener("keydown", keyHandler);
    toggleHandlers.push({ el: toggle, handler, keyHandler });
  }

  return () => {
    for (const { el, handler, keyHandler } of toggleHandlers) {
      el.removeEventListener("click", handler);
      el.removeEventListener("keydown", keyHandler);
    }
  };
}

/** Set up IntersectionObserver to highlight the current TOC link based on scroll position */
function setupTocScrollTracking(container: HTMLElement, tocEl?: HTMLElement): (() => void) | undefined {
  const toc = tocEl || container.querySelector("#toc");
  if (!toc) return;

  const tocLinks = Array.from(toc.querySelectorAll<HTMLAnchorElement>("a[href^='#']"));
  if (tocLinks.length === 0) return;

  const headingIds = tocLinks.map((a) => a.getAttribute("href")!.slice(1));
  const headings = headingIds
    .map((id) => container.querySelector(`[id="${id}"]`))
    .filter(Boolean) as HTMLElement[];

  if (headings.length === 0) return;

  let currentActive: HTMLAnchorElement | null = null;

  function setActive(id: string) {
    if (currentActive) {
      if (currentActive.getAttribute("href") === `#${id}`) return;
      currentActive.classList.remove("toc-active");
    }
    let link = toc!.querySelector<HTMLAnchorElement>(`a[href="#${id}"]`);

    // If the link is hidden (e.g. filtered by toc-levels), find the closest visible ancestor link
    if (link && !link.offsetParent) {
      let parent = link.closest("ul")?.closest("li");
      while (parent && parent !== toc) {
        const parentLink = parent.querySelector<HTMLAnchorElement>(":scope > a[href^='#']");
        if (parentLink && parentLink.offsetParent) {
          link = parentLink;
          break;
        }
        parent = parent.closest("ul")?.closest("li") ?? null;
      }
    }

    if (link) {
      link.classList.add("toc-active");
      currentActive = link;

      // Auto-expand collapsed parent sections so the active link is visible
      let parent = link.parentElement;
      while (parent && parent !== toc) {
        if (parent.tagName === "LI" && parent.classList.contains("toc-collapsed")) {
          parent.classList.remove("toc-collapsed");
          parent.classList.add("toc-expanded");
          const toggle = parent.querySelector(":scope > .toc-toggle");
          toggle?.setAttribute("aria-expanded", "true");
        }
        parent = parent.parentElement;
      }

      // Auto-scroll TOC so active item is visible
      link.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  // Find the scrollable container (.content element)
  const scrollContainer = container.closest(".content");

  /**
   * Scroll-based tracking: find the last heading that has scrolled past the top.
   * Also handles bottom-of-page: if scrolled to the end, activate the last heading.
   */
  function updateActiveFromScroll() {
    if (!scrollContainer) return;

    const scrollTop = scrollContainer.scrollTop;
    const scrollHeight = scrollContainer.scrollHeight;
    const clientHeight = scrollContainer.clientHeight;

    // If at the bottom of the page, activate the last heading
    if (scrollTop + clientHeight >= scrollHeight - 2) {
      setActive(headings[headings.length - 1].id);
      return;
    }

    // Find the last heading that has scrolled past the top of the container
    // (accounting for toolbar height offset)
    const offset = 60;
    let activeId: string | null = null;

    for (const heading of headings) {
      const rect = heading.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      const relativeTop = rect.top - containerRect.top;

      if (relativeTop <= offset) {
        activeId = heading.id;
      } else {
        break;
      }
    }

    if (activeId) {
      setActive(activeId);
    }
  }

  // Use scroll event on the .content container
  if (scrollContainer) {
    scrollContainer.addEventListener("scroll", updateActiveFromScroll, { passive: true });
  }

  // Set initial active heading
  if (headings.length > 0) {
    // Delay to let layout settle
    queueMicrotask(updateActiveFromScroll);
  }

  return () => {
    if (scrollContainer) {
      scrollContainer.removeEventListener("scroll", updateActiveFromScroll);
    }
  };
}

import { isSupportedFile, isAdocFile } from "@asciimark/core/utils.ts";

/**
 * Check if a link href points to a supported document file.
 * Handles:
 * - Direct references: other.adoc, docs/readme.md
 * - AsciiDoc xref with .html extension: other.html (converted from .adoc by asciidoctor)
 * - Links with fragments: other.adoc#section
 */
function isSupportedHref(href: string): boolean {
  const path = href.split("#")[0]!;
  if (isSupportedFile(path)) return true;
  // AsciiDoc xref converts .adoc to .html — treat .html links as navigable
  if (path.endsWith(".html")) return true;
  // Relative path where the last segment has no extension — could be a directory
  if (!path.includes("://")) {
    const lastSegment = path.split("/").pop() ?? "";
    if (!lastSegment.includes(".")) return true;
  }
  return false;
}

/**
 * Normalize href for navigation:
 * - Extract fragment (#section) separately
 * - Convert .html back to .adoc if applicable (AsciiDoc xref)
 */
function normalizeHref(href: string): { path: string; fragment: string | null } {
  const hashIdx = href.indexOf("#");
  let path = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const fragment = hashIdx >= 0 ? decodeURIComponent(href.slice(hashIdx + 1)) : null;
  // AsciiDoc xref: convert .html back to .adoc
  if (path.endsWith(".html")) {
    path = path.slice(0, -5) + ".adoc";
  }
  return { path, fragment: fragment || null };
}

/**
 * Resolve a relative link target against the current file's directory.
 */
function resolveRelativePath(currentFilePath: string, target: string): string {
  const dirParts = currentFilePath.includes("/")
    ? currentFilePath.substring(0, currentFilePath.lastIndexOf("/")).split("/")
    : [];

  const targetParts = target.split("/");

  for (const part of targetParts) {
    if (part === "..") {
      dirParts.pop();
    } else if (part !== "." && part !== "") {
      dirParts.push(part);
    }
  }

  return dirParts.join("/");
}

interface PreviewProps {
  findTrigger: number;
  html: string;
  frontmatter: Frontmatter | null;
  loading: boolean;
  previewOverlayHost?: HTMLElement;
  searchOpen: boolean;
  syncScrollActive: boolean;
  syncScrollTargetRatio: number | null;
  syncScrollTargetVersion: number;
  tocVisible: boolean;
  /** External container element where #toc will be moved to (flex sibling of .content) */
  tocContainer?: HTMLElement;
  /** Current file path (relative to root), used to resolve xref links */
  currentFilePath: string | null;
  /** Fragment ID to scroll to after content loads (from cross-file xref navigation) */
  pendingFragment: string | null;
  /** Called after the pending fragment has been scrolled to (to clear the signal) */
  onFragmentHandled: () => void;
  /** Heading text to scroll to after content loads — used by the
   *  Workspace Symbol search and any cross-file jump that knows the
   *  heading by its rendered text rather than a fragment id. */
  pendingHeadingText?: string | null;
  /** Called after the pending heading has been resolved (to clear the signal) */
  onHeadingHandled?: () => void;
  /** Called when user clicks a document link (.adoc/.md); receives the resolved path and optional fragment */
  onNavigate: (path: string, fragment?: string | null) => void;
  /** Open an external URL (http/https) in the system browser. Desktop-only. */
  onOpenExternal?: (url: string) => void;
  /**
   * Resolve an `<img>` src that appears in the document into a URL the
   * webview can fetch (e.g. via Tauri's asset protocol). Should return
   * `null` for already-absolute URLs (`http://`, `data:`, etc.) so the
   * original src is left untouched. Only platforms with filesystem access
   * (desktop) need to provide this.
   */
  resolveImageSrc?: (src: string) => string | null;
  onScrollRatioChange: (ratio: number) => void;
  onSearchOpenChange: (open: boolean) => void;
  /** Called after content swap to report whether the new content has a TOC */
  onTocChange: (hasToc: boolean) => void;
}

export function Preview(props: PreviewProps) {
  const [hasArticle, setHasArticle] = createSignal(false);
  const [overlayHost, setOverlayHost] = createSignal<HTMLElement | undefined>(undefined);
  const [viewerSvg, setViewerSvg] = createSignal<string | null>(null);
  let lastFindTrigger = props.findTrigger;
  let lastSyncScrollTargetVersion = props.syncScrollTargetVersion;
  let articleRef: HTMLElement | undefined;
  let cleanupToc: (() => void) | undefined;
  let suppressScrollCallback = false;
  // Private handle to THIS Preview's `#toc` node. The shared
  // `props.tocContainer` is owned by AppShell and re-bound to whichever
  // pane becomes active; when the OTHER pane gains focus, its effect
  // calls `container.textContent = ""` and detaches our toc. Without
  // this reference we'd lose the node forever (it's no longer inside
  // `articleRef` either, because we moved it into the shared container
  // when this pane was previously active). Keeping the handle lets us
  // re-append on every focus flip without re-rendering the whole HTML.
  let tocNode: HTMLElement | undefined;

  // Per-instance render-cancellation token. Two `Preview` components
  // coexist in split-pane mode — they MUST NOT share state, otherwise
  // a file switch in pane 1 cancels pane 0's still-in-flight microtask
  // (or vice versa) and the article ends up empty. Bumped on every new
  // render attempt; the predicate is what async post-processors call
  // to decide whether to bail.
  let renderGen = 0;
  const isStale: IsStaleFn = (gen) => gen !== renderGen;

  function computeScrollRatio(scrollTop: number, scrollHeight: number, clientHeight: number): number {
    const maxScrollTop = scrollHeight - clientHeight;
    if (maxScrollTop <= 0) return 0;
    const ratio = scrollTop / maxScrollTop;
    return Math.max(0, Math.min(1, ratio));
  }

  // Ctrl+F to open search overlay
  onMount(() => {
    const handleCtrlF = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        const activeElement = document.activeElement as HTMLElement | null;
        if (activeElement?.closest(".editor-panel")) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        props.onSearchOpenChange(!props.searchOpen);
      }
    };
    window.addEventListener("keydown", handleCtrlF);
    onCleanup(() => window.removeEventListener("keydown", handleCtrlF));
  });

  createEffect(() => {
    const findTrigger = props.findTrigger;
    if (findTrigger === lastFindTrigger) return;
    lastFindTrigger = findTrigger;
    props.onSearchOpenChange(true);
  });

  createEffect(() => {
    if (!hasArticle()) return;
    setOverlayHost(articleRef?.closest(".preview-panel") as HTMLElement | undefined);
  });

  createEffect(() => {
    if (!articleRef) return;

    const scrollContainer = articleRef.closest(".content") as HTMLElement | null;
    if (!scrollContainer) return;

    let scrollRaf = 0;
    const onScroll = () => {
      if (suppressScrollCallback || !props.syncScrollActive) return;
      cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(() => {
        props.onScrollRatioChange(computeScrollRatio(
          scrollContainer.scrollTop,
          scrollContainer.scrollHeight,
          scrollContainer.clientHeight,
        ));
      });
    };

    scrollContainer.addEventListener("scroll", onScroll, { passive: true });
    onCleanup(() => {
      cancelAnimationFrame(scrollRaf);
      scrollContainer.removeEventListener("scroll", onScroll);
    });
  });

  createEffect(() => {
    const targetVersion = props.syncScrollTargetVersion;
    if (targetVersion === lastSyncScrollTargetVersion) return;
    lastSyncScrollTargetVersion = targetVersion;

    if (!props.syncScrollActive || !articleRef) return;

    const targetRatio = props.syncScrollTargetRatio;
    if (targetRatio === null) return;

    const scrollContainer = articleRef.closest(".content") as HTMLElement | null;
    if (!scrollContainer) return;

    const maxScrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight;
    const targetTop = maxScrollTop <= 0 ? 0 : Math.max(0, Math.min(1, targetRatio)) * maxScrollTop;

    suppressScrollCallback = true;
    scrollContainer.scrollTop = targetTop;
    requestAnimationFrame(() => {
      suppressScrollCallback = false;
    });
  });

  // Listen for theme changes to re-init mermaid
  onMount(() => {
    const observer = new MutationObserver(() => {
      mermaidInitialized = false;
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    onCleanup(() => observer.disconnect());
  });

  onCleanup(() => cleanupToc?.());

  /**
   * Intercept clicks on links inside the rendered AsciiDoc:
   * - #anchor links: scroll manually within .content container (prevent hash corruption)
   * - .adoc file links: navigate via SPA routing
   */
  function scrollToFragment(fragmentId: string) {
    if (!articleRef) return;
    const target = articleRef.querySelector(`[id="${CSS.escape(fragmentId)}"]`) as HTMLElement | null;
    if (!target) return;
    const contentEl = articleRef.closest(".content");
    if (contentEl) {
      const targetRect = target.getBoundingClientRect();
      const contentRect = contentEl.getBoundingClientRect();
      const offset = targetRect.top - contentRect.top + contentEl.scrollTop - 16;
      contentEl.scrollTo({ top: offset, behavior: "smooth" });
    } else {
      target.scrollIntoView({ behavior: "smooth" });
    }
  }

  function handleClick(e: MouseEvent) {
    // Open the diagram viewer when clicking a rendered Mermaid or Kroki block.
    const diagram = (e.target as HTMLElement).closest<HTMLElement>(
      ".mermaid[data-processed], .kroki[data-processed]",
    );
    if (diagram) {
      const svgEl = diagram.querySelector("svg");
      if (svgEl) {
        e.preventDefault();
        e.stopPropagation();
        setViewerSvg(svgEl.outerHTML);
        return;
      }
    }

    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor) return;

    const href = anchor.getAttribute("href");
    if (!href) return;

    // Handle #anchor links (TOC items, section links)
    if (href.startsWith("#")) {
      e.preventDefault();
      const targetId = decodeURIComponent(href.slice(1));
      if (targetId) scrollToFragment(targetId);
      return;
    }

    // Mailto, tel, and other non-http schemes → open externally
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      e.preventDefault();
      // http/https and other openable schemes → system browser
      if (/^https?:\/\//i.test(href) || href.startsWith("mailto:")) {
        props.onOpenExternal?.(href);
      }
      // file:// → navigate if supported document
      if (href.startsWith("file://") && isSupportedHref(href.replace(/^file:\/\//, ""))) {
        props.onNavigate(href);
      }
      // All other schemes (ftp, tel, slack, etc.) → blocked silently
      return;
    }

    // Check if it's a supported file link (.adoc, .md, .html, etc.)
    if (!isSupportedHref(href)) {
      e.preventDefault();
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    // Normalize href (e.g., .html → .adoc for xref links)
    const { path: normalizedPath, fragment } = normalizeHref(href);

    // Resolve relative to current file
    const currentPath = props.currentFilePath;
    const targetPath = currentPath ? resolveRelativePath(currentPath, normalizedPath) : normalizedPath;

    // If there's a fragment, check if it exists in the current document
    // (handles both same-file xrefs and xrefs to included files)
    if (fragment && articleRef) {
      const existingEl = articleRef.querySelector(`[id="${CSS.escape(fragment)}"]`);
      if (existingEl) {
        scrollToFragment(fragment);
        return;
      }
    }

    props.onNavigate(targetPath, fragment);
  }

  // Post-process and render HTML into the article element.
  // Uses double-buffering to prevent FOUC: HTML is processed in a detached
  // element (highlight, mermaid, kroki), then swapped into the visible article
  // only after processing completes. Raw/unprocessed HTML never appears on screen.
  //
  // When html becomes empty (file switch), old content stays hidden (opacity:0)
  // to preserve layout dimensions and prevent content shrink/grow shift.
  //
  // Note: props.html can come from local or remote documents.
  // Always sanitize before injecting into the DOM.
  let pendingNewDocument = false;

  // Re-populate the shared TOC panel when this Preview becomes the
  // pane that owns it. AppShell hands the `tocContainerRef` to whichever
  // pane is `paneManager.activePane()`, so when the user clicks the
  // other pane, this effect fires for both Previews — the newly-active
  // one copies its `#toc` block into the shared container, the
  // newly-inactive one's `tocContainer` becomes undefined and we skip.
  //
  // Lookup precedence is articleRef first, then `tocNode` cache: the
  // first time this fires after a render, the toc still lives inside
  // the article. After a previous focus session moved it into the
  // shared container, the OTHER pane's focus flip will have called
  // `textContent = ""` on that shared container — detaching our toc
  // from the DOM but leaving the node alive in `tocNode`. So we re-use
  // the cached node to put it back into the (now emptied) container.
  createEffect(() => {
    const container = props.tocContainer;
    // Always cleanup first — this also covers the deactivation path,
    // where `container` becomes undefined. Without this, the previous
    // session's scroll listener would keep firing against `articleRef`
    // and toggling `.toc-active` on a now-detached toc tree (the one we
    // moved into the shared container, then the other pane wiped).
    cleanupToc?.();
    cleanupToc = undefined;
    if (!container) return;
    const tocVis = props.tocVisible;
    const fresh = articleRef?.querySelector<HTMLElement>("#toc") ?? null;
    if (fresh) tocNode = fresh;
    const toc = tocNode;
    container.textContent = "";
    if (toc) container.appendChild(toc);
    props.onTocChange(!!toc);
    if (tocVis && toc && articleRef) {
      const cleanupCollapse = setupTocCollapse(toc);
      const cleanupScroll = setupTocScrollTracking(articleRef, toc);
      cleanupToc = () => {
        cleanupCollapse();
        cleanupScroll?.();
      };
    }
  });

  createEffect(() => {
    const _html = props.html;
    // Also track tocVisible so this re-runs when it changes
    const tocVis = props.tocVisible;

    if (!articleRef) return;

    // Empty HTML (file switch): hide old content but keep it for layout stability.
    // Cancel any in-flight pipeline so stale renders don't swap in.
    if (!_html) {
      ++renderGen;
      articleRef.style.opacity = "0";
      // Drop the cached toc handle: the next render will produce a
      // fresh one. Holding on to the old one across a file switch
      // would risk re-attaching a stale tree if the user flipped
      // panes during the transition.
      tocNode = undefined;
      pendingNewDocument = true;
      return;
    }

    const gen = ++renderGen;
    const isNewDocument = pendingNewDocument;
    pendingNewDocument = false;
    const sanitizedHtml = sanitizeHtmlFragment(_html);

    // Shared post-swap logic: TOC handling, collapse toggles, reveal, fragment scroll
    function afterSwap(container: HTMLElement, scrollToTop: boolean, tocVis: boolean) {
      const scrollContainer = articleRef!.closest(".content");
      if (scrollToTop && scrollContainer) {
        scrollContainer.scrollTop = 0;
      }

      // Move #toc from article to external panel container. Always
      // update `tocNode` (even when this pane is inactive) so the next
      // focus flip can re-attach the freshly rendered toc — without
      // this, a re-render that happens while inactive would leave the
      // pane stuck on the previous render's stale toc.
      //
      // When this pane is inactive (`tocContainer` is undefined), the
      // toc node still has to leave the article body — otherwise the
      // asciidoctor / markdown-toc-rendered list shows up inline above
      // the actual content and the user sees a duplicated table of
      // contents the moment focus leaves this pane. Detaching keeps
      // `tocNode` valid as a cache so the next focus flip can move
      // the same node into the now-bound shared container.
      const tocContainer = props.tocContainer;
      const toc = container.querySelector<HTMLElement>("#toc");
      tocNode = toc ?? undefined;
      if (tocContainer) {
        tocContainer.textContent = "";
        if (toc) tocContainer.appendChild(toc);
      } else if (toc) {
        toc.remove();
      }

      props.onTocChange(!!toc);

      // Set up collapse toggles and scroll tracking
      cleanupToc?.();
      if (tocVis) {
        const tocEl = tocContainer?.querySelector<HTMLElement>("#toc") ?? undefined;
        if (tocEl) {
          const cleanupCollapse = setupTocCollapse(tocEl);
          const cleanupScroll = setupTocScrollTracking(articleRef!, tocEl);
          cleanupToc = () => {
            cleanupCollapse();
            cleanupScroll?.();
          };
        } else {
          cleanupToc = undefined;
        }
      } else {
        cleanupToc = undefined;
      }

      articleRef!.style.opacity = "";

      const frag = props.pendingFragment;
      if (frag) {
        scrollToFragment(frag);
        props.onFragmentHandled();
      }

      // Heading-text jump (Workspace Symbol search / programmatic
      // navigation that doesn't know the rendered fragment id). Walk
      // the visible article for h1-h6 nodes, match by trimmed
      // textContent, scroll into view. Falling back to text rather
      // than computing a slug ahead of time keeps the matcher
      // resilient to renderer differences (asciidoctor vs markdown-it
      // produce different id schemes).
      const headingText = props.pendingHeadingText;
      if (headingText && articleRef) {
        const hs = articleRef.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6");
        const target = Array.from(hs).find(
          (h) => h.textContent?.trim() === headingText,
        );
        if (target) {
          const contentEl = articleRef.closest(".content");
          if (contentEl) {
            const targetRect = target.getBoundingClientRect();
            const contentRect = contentEl.getBoundingClientRect();
            const offset = targetRect.top - contentRect.top + contentEl.scrollTop - 16;
            contentEl.scrollTo({ top: offset, behavior: "smooth" });
          } else {
            target.scrollIntoView({ behavior: "smooth" });
          }
        }
        props.onHeadingHandled?.();
      }
    }

    // New document (file switch): double-buffer to avoid FOUC — process in
    // detached element, then swap only after highlight/mermaid/kroki finish.
    // Editing (live preview): swap immediately for instant feedback, then
    // run highlight/mermaid/kroki in-place progressively.
    if (isNewDocument) {
      const buffer = document.createElement("div");
      buffer.innerHTML = sanitizedHtml;
      wrapTablesForScroll(buffer);
      if (props.resolveImageSrc) rewriteImageSources(buffer, props.resolveImageSrc);

      queueMicrotask(async () => {
        // Syntax highlighting can run against the detached buffer —
        // it's pure DOM mutation with no document-level
        // dependencies, and finishing it before the swap eliminates
        // the FOUC of unhighlighted code.
        await highlightCodeBlocks(buffer, gen, isStale);
        if (isStale(gen)) return;

        // Swap to the live article BEFORE running mermaid / kroki —
        // both libraries create temp elements in `document.body`
        // and read layout / fonts off the surrounding document. On
        // a detached buffer the very first call randomly throws
        // `null is not an object (evaluating 'element.firstChild')`
        // because mermaid couldn't measure the temp container's
        // size. Swap first → live measurement → reliable renders.
        const scrollContainer = articleRef!.closest(".content");
        const prevScrollTop = scrollContainer?.scrollTop ?? 0;
        articleRef!.replaceChildren(...Array.from(buffer.childNodes));
        if (scrollContainer) scrollContainer.scrollTop = prevScrollTop;

        afterSwap(articleRef!, true, tocVis);

        // Wait one paint frame so the freshly-attached article has
        // been laid out before mermaid measures. Without this, the
        // first block races with layout and throws `firstChild`.
        await nextPaintFrame();
        if (isStale(gen)) return;

        await renderMermaidBlocks(articleRef!, gen, isStale);
        if (isStale(gen)) return;

        await renderKrokiBlocks(articleRef!, gen, isStale);
      });
    } else {
      const scrollContainer = articleRef!.closest(".content");
      const prevScrollTop = scrollContainer?.scrollTop ?? 0;
      articleRef!.innerHTML = sanitizedHtml;
      if (scrollContainer) scrollContainer.scrollTop = prevScrollTop;
      wrapTablesForScroll(articleRef!);
      if (props.resolveImageSrc) rewriteImageSources(articleRef!, props.resolveImageSrc);

      afterSwap(articleRef!, false, tocVis);

      queueMicrotask(async () => {
        await highlightCodeBlocks(articleRef!, gen, isStale);
        if (isStale(gen)) return;

        await renderMermaidBlocks(articleRef!, gen, isStale);
        if (isStale(gen)) return;

        await renderKrokiBlocks(articleRef!, gen, isStale);
      });
    }
  });

  return (
    <div class="preview-scope">
      <Show when={hasArticle()}>
        <SearchOverlay
          container={articleRef!}
          class="search-overlay-preview"
          portalHost={props.previewOverlayHost ?? overlayHost()}
          visible={props.searchOpen}
          onClose={() => props.onSearchOpenChange(false)}
        />
      </Show>
      <DiagramViewer svg={viewerSvg()} onClose={() => setViewerSvg(null)} />
      <div class="preview">
        <Show when={props.loading}>
          <div class="preview-loading">{(useLocale(), m.preview_loading())}</div>
        </Show>
        <Show when={props.frontmatter && Object.keys(props.frontmatter).length > 0}>
          <FrontmatterPanel
            frontmatter={props.frontmatter!}
            currentFilePath={props.currentFilePath}
            onNavigate={props.onNavigate}
          />
        </Show>
        <article
          ref={(el) => {
            articleRef = el;
            setHasArticle(true);
          }}
          class="doc-body"
          onClick={handleClick}
        />
      </div>
    </div>
  );
}
