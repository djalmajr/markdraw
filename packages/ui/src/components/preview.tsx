import { Show, createSignal, onSettled, onCleanup, createEffect, createMemo, untrack } from "solid-js";
import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";
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
import { ImageLightbox } from "./image-lightbox.tsx";
import IconScan from "~icons/lucide/scan";
import IconMinimize from "~icons/lucide/minimize-2";
import IconMaximize from "~icons/lucide/maximize-2";
import IconStretch from "~icons/lucide/move-horizontal";
import IconExpand from "~icons/lucide/expand";
import { Portal } from "@solidjs/web";
import { FrontmatterPanel } from "./frontmatter-panel.tsx";
import { renderKroki } from "@markdraw/core/kroki.ts";
import { mermaidCache, mermaidCacheKey } from "../lib/mermaid-cache.ts";
import { ensureMermaidWarm, renderInFrame, retainMermaidFrame, withMermaidLock } from "../lib/mermaid-frame.ts";
import { createMermaidLazyRenderer, type MermaidLazyRenderer } from "../lib/mermaid-lazy.ts";
import { MERMAID_CSS_CLASS_PREFIX, MermaidStyleRegistry, parseSvgMarkup, prepareMermaidSvg, renameMermaidInlineCss, svgWithMermaidStyles } from "../lib/mermaid-svg-css.ts";
import { registerMermaidFlush } from "../lib/mermaid-flush.ts";
import type { Frontmatter } from "@markdraw/core/frontmatter.ts";
import type { TabState, PreviewScrollAnchor } from "@markdraw/core/tabs.ts";
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

let mermaidId = 0;
const pendingMermaidSources = new WeakMap<HTMLElement, string>();
const pendingKrokiSources = new WeakMap<HTMLElement, string>();
const highlightedBlocks = new WeakSet<HTMLElement>();

function uniqueMermaidIds(svg: string, updateStyleText = true): string {
  const { root, serialize } = parseSvgMarkup(svg);
  if (!root) return svg;
  const ids = new Map<string, string>();
  const suffix = `-cached-${++mermaidId}`;
  // querySelectorAll visits descendants only: the cached SVG's own id must
  // be renamed too, or two insertions of the same SVG share a DOM id.
  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const el of elements) {
    const id = el.getAttribute("id");
    if (!id) continue;
    ids.set(id, `${id}${suffix}`);
    el.setAttribute("id", `${id}${suffix}`);
  }
  const replaceReferences = (value: string) => {
    for (const [id, replacement] of ids) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      value = value.replace(new RegExp(`#${escaped}(?![\\w-])`, "g"), `#${replacement}`);
    }
    return value;
  };
  // `content` is a literal: only local SVG references are renamed.
  const replaceInlineStyleReferences = (value: string) => value.split(";").map((declaration) => {
    const colon = declaration.indexOf(":");
    if (colon < 0 || declaration.slice(0, colon).trim().toLowerCase() === "content") {
      return declaration;
    }
    return replaceReferences(declaration);
  }).join(";");
  for (const el of elements) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name === "id") continue;
      if (attr.name === "aria-labelledby" || attr.name === "aria-describedby") {
        el.setAttribute(attr.name, attr.value.split(/\s+/).map((id) => ids.get(id) ?? id).join(" "));
      } else if (attr.name === "style") {
        el.setAttribute(attr.name, replaceInlineStyleReferences(attr.value));
      } else if (/^(?:href|xlink:href|fill|stroke|filter|clip-path|mask|marker-start|marker-mid|marker-end)$/.test(attr.name)) {
        el.setAttribute(attr.name, replaceReferences(attr.value));
      }
    }
    if (updateStyleText && el.localName === "style") {
      const css = el.textContent ?? "";
      el.textContent = renameMermaidInlineCss(css, ids) ?? replaceReferences(css);
    }
  }
  return serialize();
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
    if (!language || highlightedBlocks.has(codeEl)) continue;

    codeEl.classList.add(`language-${language}`);
    const preEl = codeEl.parentElement;
    if (preEl) {
      preEl.classList.add(`language-${language}`);
    }

    Prism.highlightElement(codeEl);
    highlightedBlocks.add(codeEl);
    await yieldToMain();
  }
}

function mermaidSvgLooksRenderable(svg: string): boolean {
  if (!/<svg\b/i.test(svg)) return false;
  if (/\bNaN\b/.test(svg)) return false;
  if (/viewBox=["']\s*0\s+0\s+0\s+0\s*["']/i.test(svg)) return false;
  return true;
}

function anchorAtViewportTop(
  block: HTMLElement,
  article: HTMLElement,
  top: number,
  bottom: number,
): { element: Element; top: number } | undefined {
  if (typeof document.elementFromPoint !== "function") return;
  const area = article.getBoundingClientRect();
  const y = Math.max(top, area.top) + 1;
  if (y >= bottom || area.width <= 0) return;
  let element = document.elementFromPoint(area.left + area.width / 2, y);
  // Climb to the nearest element of the article with a box of its own.
  while (element && element !== article && element.getBoundingClientRect().height === 0) {
    element = element.parentElement;
  }
  // An overlay, something outside the article or the block being replaced
  // leaves the anchor to the walk below.
  if (!element || element === article || !article.contains(element) || block.contains(element)) return;
  return { element, top: element.getBoundingClientRect().top };
}

function visibleMermaidAnchor(
  block: HTMLElement,
  article: HTMLElement,
  root: HTMLElement,
): { element: Element; top: number } | undefined {
  const { top, bottom } = root.getBoundingClientRect();
  if (block.getBoundingClientRect().bottom > top + 1) return;

  // The element under the top edge of the viewport is the natural anchor:
  // one hit test instead of measuring the article's elements one by one.
  const atTop = anchorAtViewportTop(block, article, top, bottom);
  if (atTop) return atTop;

  let crossing: { element: Element; top: number; depth: number } | undefined;
  function findVisibleTop(parent: Element, depth: number): { element: Element; top: number } | undefined {
    for (let element = parent.firstElementChild; element; element = element.nextElementSibling) {
      if (element === block) continue;
      const rect = element.getBoundingClientRect();
      // Siblings in a block flow come in vertical order: once one starts below
      // the viewport, none after it can be visible.
      if (rect.top >= bottom) break;
      const startsVisible = rect.top >= top && rect.top < bottom;
      const crossesTop = rect.top < top && rect.bottom > top;
      if (!startsVisible && !crossesTop) continue;
      if (startsVisible && rect.bottom > rect.top) return { element, top: rect.top };
      if (crossesTop && (!crossing || depth > crossing.depth)) {
        crossing = { element, top: rect.top, depth };
      }
      const visible = findVisibleTop(element, depth + 1);
      if (visible) return visible;
    }
  }

  // A tall block can fill the viewport without any element starting inside it.
  return findVisibleTop(article, 0) ?? crossing;
}

function replaceMermaidPlaceholder(
  block: HTMLElement,
  html: string,
  article: HTMLElement,
  root: HTMLElement | null,
  onDiagram: (block: HTMLElement) => void,
  isAnchorTracking: () => boolean,
): void {
  const anchor = root && !isAnchorTracking() ? visibleMermaidAnchor(block, article, root) : undefined;
  block.innerHTML = html;
  block.style.color = "";
  block.style.fontStyle = "";
  block.style.minHeight = "";
  block.removeAttribute("data-mermaid-pending");
  block.removeAttribute("data-processing");
  block.setAttribute("data-processed", "true");

  // Reading the new position forces layout, including native scroll anchoring.
  if (root && anchor) {
    const remaining = anchor.element.getBoundingClientRect().top - anchor.top;
    if (remaining !== 0) root.scrollTop += remaining;
  }
  onDiagram(block);
}

function insertMermaidSvg(
  block: HTMLElement,
  svg: string,
  article: HTMLElement,
  root: HTMLElement | null,
  styles: MermaidStyleRegistry,
  onDiagram: (block: HTMLElement) => void,
  isAnchorTracking: () => boolean,
): string | undefined {
  const prepared = prepareMermaidSvg(svg);
  const html = uniqueMermaidIds(prepared?.html ?? svg, prepared?.hasLocalCss ?? true);
  if (prepared) styles.add(prepared.className, prepared.css);
  replaceMermaidPlaceholder(block, html, article, root, onDiagram, isAnchorTracking);
  return prepared?.className;
}

async function renderOneMermaidBlock(
  block: HTMLElement,
  article: HTMLElement,
  gen: number,
  isStale: IsStaleFn,
  root: HTMLElement | null,
  styles: MermaidStyleRegistry,
  onDiagram: (block: HTMLElement) => void,
  isAnchorTracking: () => boolean,
): Promise<void> {
  if (isStale(gen)) return;
  const source = pendingMermaidSources.get(block) ?? "";
  if (!source) return;
  block.setAttribute("data-processing", "true");

  try {
    // Pre-warm before the first user-facing render so the lib has
    // fonts + internals ready. After the first resolve this is a no-op.
    await ensureMermaidWarm(article);
    if (isStale(gen)) return;

    const theme = document.documentElement.classList.contains("dark") ? "dark" : "default";
    const key = mermaidCacheKey(source, theme);
    let svg: string | undefined = mermaidCache.get(key);
    let lastErr: unknown;
    for (let attempt = 0; !svg && attempt < 3; attempt++) {
      if (isStale(gen)) return;
      const baseId = `mermaid-${++mermaidId}`;
      const attemptId = attempt === 0 ? baseId : `${baseId}-retry-${attempt}`;
      try {
        // Mermaid sometimes throws `null is not an object (evaluating
        // 'element.firstChild')` on the first render of complex shapes.
        // Transient layout races resolve within a couple of frames.
        const result = await withMermaidLock(async () => {
          if (isStale(gen)) return null;
          return renderInFrame(attemptId, source, theme, article, () => isStale(gen));
        });
        if (isStale(gen)) return;
        if (result?.svg && mermaidSvgLooksRenderable(result.svg)) {
          svg = result.svg;
          break;
        }
        lastErr = new Error("mermaid render returned an empty or invalid svg");
      } catch (err) {
        lastErr = err;
      }
      await nextPaintFrame();
    }
    if (!svg) throw lastErr ?? new Error("mermaid render produced no output");
    if (isStale(gen)) return;
    const className = insertMermaidSvg(block, svg, article, root, styles, onDiagram, isAnchorTracking);
    mermaidCache.set(key, svg, className);
  } catch (e: any) {
    if (isStale(gen)) return;
    const errMsg = e?.message || "Unknown error";
    const escaped = source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = `<pre class="mermaid-error">Mermaid error: ${errMsg.replace(/</g, "&lt;")}\n\n${escaped}</pre>`;
    replaceMermaidPlaceholder(block, html, article, root, onDiagram, isAnchorTracking);
  }
}

function setupMermaidBlocks(
  container: HTMLElement,
  gen: number,
  isStale: IsStaleFn,
  styles: MermaidStyleRegistry,
  onDiagram: (block: HTMLElement) => void,
  isAnchorTracking: () => boolean,
): { renderer: MermaidLazyRenderer; ready: Promise<void> } | null {
  const candidates = Array.from(container.querySelectorAll<HTMLElement>("div.mermaid"));
  const blocks: HTMLElement[] = [];
  for (const block of candidates) {
    if (isStale(gen)) return null;
    if (block.getAttribute("data-processed")) {
      if (block.querySelector("svg, .mermaid-error")) continue;
      block.removeAttribute("data-processed");
    }
    const source = pendingMermaidSources.get(block) ?? block.textContent?.trim() ?? "";
    if (!source) continue;
    if (block.hasAttribute("data-mermaid-pending")) {
      block.removeAttribute("data-processing");
      blocks.push(block);
      continue;
    }
    pendingMermaidSources.set(block, source);
    block.textContent = "Rendering diagram...";
    block.style.color = "hsl(var(--muted-foreground))";
    block.style.fontStyle = "italic";
    block.style.minHeight = "160px";
    block.setAttribute("data-mermaid-pending", "true");
    blocks.push(block);
  }
  if (blocks.length === 0) return null;

  void ensureMermaidWarm(container);
  const root = container.closest<HTMLElement>(".content");
  const renderer = createMermaidLazyRenderer({
    root,
    blocks,
    tryImmediate: (block) => {
      if (isStale(gen)) return true;
      const source = pendingMermaidSources.get(block) ?? "";
      const theme = document.documentElement.classList.contains("dark") ? "dark" : "default";
      const key = mermaidCacheKey(source, theme);
      const cached = mermaidCache.get(key);
      if (!cached) return false;
      const className = insertMermaidSvg(block, cached, container, root, styles, onDiagram, isAnchorTracking);
      if (className && mermaidCache.classNameFor(key) !== className) {
        mermaidCache.set(key, cached, className);
      }
      return true;
    },
    render: (block) => renderOneMermaidBlock(block, container, gen, isStale, root, styles, onDiagram, isAnchorTracking),
  });
  return { renderer, ready: renderer.whenInitialDone() };
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
    // An admonition's own table only lays out the icon and the content: the
    // wrapper's bottom margin would show inside the box. Data tables inside
    // the admonition's content are still wrapped.
    if (table.parentElement?.classList.contains("admonitionblock")) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "table-wrapper";
    table.parentElement?.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  }
}

/**
 * Wrap every inline <img> in a `.doc-img-scroll` div so an image shown at original
 * size (wider than the content column) gets a horizontal scroll instead of being
 * clipped — the same treatment wide tables get. Linked images are left alone.
 */
function wrapImagesForScroll(container: HTMLElement): void {
  // The kind of the image's nearest non-whitespace neighbor on one side.
  const neighbor = (img: HTMLImageElement, dir: "prev" | "next"): "text" | "other" | null => {
    let n: Node | null = dir === "prev" ? img.previousSibling : img.nextSibling;
    while (n && n.nodeType === Node.TEXT_NODE && !n.textContent?.trim()) {
      n = dir === "prev" ? n.previousSibling : n.nextSibling;
    }
    if (!n) return null;
    return n.nodeType === Node.TEXT_NODE ? "text" : "other";
  };
  const imgs = container.querySelectorAll<HTMLImageElement>("img");
  for (const img of imgs) {
    if (img.parentElement?.classList.contains("doc-img-scroll")) continue;
    if (img.closest("a")) continue;
    // Skip only a TRUE inline icon — real text immediately on BOTH sides (an image
    // mid-sentence). An image that's alone, at the start/end of its block, or set
    // off by <br>s is block-level → it gets the centered, scrollable wrapper.
    if (neighbor(img, "prev") === "text" && neighbor(img, "next") === "text") continue;
    const parent = img.parentElement;
    if (!parent) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "doc-img-scroll";
    parent.insertBefore(wrapper, img);
    wrapper.appendChild(img);
  }
}

/** Render Kroki diagram blocks (plantuml, graphviz, ditaa, etc.) */
async function renderKrokiBlocks(
  container: HTMLElement,
  gen: number,
  isStale: IsStaleFn,
  signal: AbortSignal,
  onDiagram: (block: HTMLElement) => void,
): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>("div.kroki");
  await Promise.all(Array.from(blocks, async (block) => {
    if (isStale(gen)) return;
    if (block.getAttribute("data-processed") === "true") return;
    const type = block.getAttribute("data-type") || "plantuml";
    const source = pendingKrokiSources.get(block) ?? block.textContent ?? "";
    if (!source.trim()) return;
    pendingKrokiSources.set(block, source);

    block.textContent = "Rendering diagram...";
    block.style.color = "hsl(var(--muted-foreground))";
    block.style.fontStyle = "italic";

    try {
      const svg = await renderKroki(type, source, signal);
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

    pendingKrokiSources.delete(block);
    block.setAttribute("data-processed", "true");
    onDiagram(block);
  }));
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
      el.parentElement?.classList.remove("toc-collapsible", "toc-expanded", "toc-collapsed");
      el.remove();
    }
  };
}

/** Set up IntersectionObserver to highlight the current TOC link based on scroll position */
export function setupTocScrollTracking(container: HTMLElement, tocEl?: HTMLElement): (() => void) | undefined {
  const toc = tocEl || container.querySelector("#toc");
  if (!toc) return;

  // A re-attached toc (notably after split→unsplit, where a pane's toc
  // node is cached, detached by the other pane's wipe, then put back) can
  // still carry a `.toc-active` from its previous tracking session. The
  // fresh closure below starts with `currentActive = null`, so on the next
  // scroll it would ADD a second active link without clearing the stale
  // one — two highlights, out of sync. Wipe leftover active state so this
  // session starts from a clean slate.
  for (const stale of Array.from(toc.querySelectorAll<HTMLElement>(".toc-active"))) {
    stale.classList.remove("toc-active");
  }

  const tocLinks = Array.from(toc.querySelectorAll<HTMLAnchorElement>("a[href^='#']"));
  if (tocLinks.length === 0) return;

  const headingIds = tocLinks.map((a) => a.getAttribute("href")!.slice(1));
  const headings = headingIds
    .map((id) => container.querySelector(`[id="${id}"]`))
    .filter(Boolean) as HTMLElement[];

  if (headings.length === 0) return;

  let currentActive: HTMLAnchorElement | null = null;
  let disposed = false;

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
    if (disposed || !scrollContainer) return;

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
    disposed = true;
    if (scrollContainer) {
      scrollContainer.removeEventListener("scroll", updateActiveFromScroll);
    }
  };
}

import { isSupportedFile, isAdocFile } from "@markdraw/core/utils.ts";

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

/** A non-collapsed DOM selection inside the rendered article, with the screen
 *  coords of its end for anchoring the selection popover. `source: "preview"`
 *  lets the host's shared popover state tell it apart from an editor
 *  selection (which carries CodeMirror offsets instead). */
export interface PreviewSelectionInfo {
  bottom: number;
  left: number;
  source: "preview";
  text: string;
}

interface TabScrollRestore {
  tabId: string;
  path: string;
  scrollTop: number;
  anchor: PreviewScrollAnchor | null;
}

interface PendingTabScrollTarget {
  gen: number;
  content: HTMLElement;
  block: Element;
  offset: number;
  diagramsAbove: Set<HTMLElement>;
  expectedTop: number;
  cleanup: () => void;
}

function maxScrollTopOf(content: HTMLElement): number {
  return Math.max(0, content.scrollHeight - content.clientHeight);
}

function tabScrollAnchorBlock(article: HTMLElement, anchor: PreviewScrollAnchor): Element | undefined {
  if (Number.isInteger(anchor.blockIndex) && anchor.blockIndex >= 0 && Number.isFinite(anchor.offset)) {
    return article.children[anchor.blockIndex];
  }
}

function blockOffsetInViewport(block: Element, content: HTMLElement): number {
  return block.getBoundingClientRect().top - content.getBoundingClientRect().top;
}

function setClampedScrollTop(content: HTMLElement, top: number): void {
  content.scrollTop = Math.max(0, Math.min(maxScrollTopOf(content), top));
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
  /** When true, wide tables wrap to fit the width instead of scrolling
   *  horizontally (adds `.doc-tables-wrap` on the article). */
  wrapTables: boolean;
  /** External container element where #toc will be moved to (flex sibling of .content) */
  tocContainer?: HTMLElement;
  /** Current file path (relative to root), used to resolve xref links */
  currentFilePath: string | null;
  /** The tab bound to this pane, so a restore never lands in another tab. */
  currentTabId?: string | null;
  /** Tab-store selection version; a rename only changes currentTabId. */
  tabActivationVersion?: number;
  cacheTabs?: readonly Pick<TabState, "id" | "diskChange">[];
  darkMode?: boolean;
  /** Read at swap time: the scroll position saved when this tab was left. */
  getTabScrollRestore?: () => TabScrollRestore | null;
  /** Fragment ID to scroll to after content loads (from cross-file xref navigation) */
  pendingFragment: string | null;
  /** Called after the pending fragment has been scrolled to (to clear the signal) */
  onFragmentHandled: () => void;
  /** Called with the fragment that lost its document. Separate from
   *  `onFragmentHandled` so the host can clear the signal without claiming
   *  the jump happened in the newly opened file. */
  onFragmentDiscarded?: (fragment: string) => void;
  /** Heading text to scroll to after content loads — used by the
   *  Workspace Symbol search and any cross-file jump that knows the
   *  heading by its rendered text rather than a fragment id. */
  pendingHeadingText?: string | null;
  /** Called after the pending heading has been resolved (to clear the signal) */
  onHeadingHandled?: () => void;
  /** Called with the heading that lost its document. Separate from
   *  `onHeadingHandled` so the host can clear the signal without claiming
   *  the jump happened in the newly opened file. */
  onHeadingDiscarded?: (heading: string) => void;
  /** Called when user clicks a document link (.adoc/.md); receives the resolved path and optional fragment */
  onNavigate: (path: string, fragment?: string | null) => void;
  /** Called for a `#fragment` link whose target is not in this document. */
  onUnresolvedFragment?: (id: string) => void;
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
  /** Fired after a mouseup over a non-collapsed DOM selection anchored inside
   *  the rendered article (`.doc-body`), and with `null` when that selection
   *  collapses (click elsewhere / Escape). Mirrors the editor's
   *  onSelectionPopover contract; only wired by hosts with a chat panel. */
  onSelectionPopover?: (info: PreviewSelectionInfo | null) => void;
  /** Called after content swap to report whether the new content has a TOC */
  onTocChange: (hasToc: boolean) => void;
}

interface RenderedPreview {
  tabId: string | null;
  html: string;
  article: HTMLElement;
  toc: HTMLElement | undefined;
  highlighted: boolean;
}

const RECENT_PREVIEW_LIMIT = 3;

export function Preview(props: PreviewProps) {
  const [activeArticle, setActiveArticle] = createSignal<HTMLElement>();
  const hasArticle = () => !!activeArticle();
  const parkedPreviews = new Map<string, RenderedPreview>();
  const cacheTabs = createMemo(() => props.cacheTabs);
  let renderedPreview: RenderedPreview | undefined;
  let lastTheme: boolean | undefined;
  const [overlayHost, setOverlayHost] = createSignal<HTMLElement | undefined>(undefined);
  const [viewerSvg, setViewerSvg] = createSignal<string | null>(null);
  const [viewerImage, setViewerImage] = createSignal<string | null>(null);
  // HTML currently attached to the article, not the previous document.
  const [renderedHtml, setRenderedHtml] = createSignal<string | null>(null);

  // Per-image display menu for inline preview images. Opened by CLICKING the
  // image (hover put the menu too far to reach before it dismissed); it floats at
  // the click point and offers size presets (set via a `data-size` attr — the
  // images are innerHTML, not Solid nodes) plus a Zoom action that opens the
  // lightbox.
  const [sizeMenuImg, setSizeMenuImg] = createSignal<HTMLImageElement | null>(null);
  const [sizeMenuPos, setSizeMenuPos] = createSignal<{ top: number; left: number }>({ top: 0, left: 0 });

  function applyImageSize(size: "small" | "fit" | "wide" | "original") {
    const img = sizeMenuImg();
    if (!img) return;
    if (size === "fit") delete img.dataset.size;
    else img.dataset.size = size;
  }
  function openImageZoom() {
    const img = sizeMenuImg();
    setSizeMenuImg(null);
    if (img) setViewerImage(img.currentSrc || img.src);
  }

  // Dismiss the image menu on outside-click / Escape / scroll. Deferred so the
  // click that opened it doesn't immediately close it.
  createEffect(
    () => !!sizeMenuImg(),
    (isOpen) => {
      if (!isOpen) return;
      const close = () => setSizeMenuImg(null);
      const onDown = (ev: MouseEvent) => {
        if (!(ev.target as HTMLElement).closest(".img-size-menu")) close();
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") close();
      };
      const t = setTimeout(() => {
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey);
        window.addEventListener("scroll", close, { capture: true, passive: true });
      }, 0);
      return () => {
        clearTimeout(t);
        document.removeEventListener("mousedown", onDown, true);
        document.removeEventListener("keydown", onKey);
        window.removeEventListener("scroll", close, { capture: true } as EventListenerOptions);
      };
    },
  );
  let lastFindTrigger: number | undefined;
  let lastSyncScrollTargetVersion: number | undefined;
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

  let stopAnchorTracking: (() => void) | undefined;
  let repositionAnchor: (() => void) | undefined;
  let processingGen: number | null = null;
  let mermaidRenderer: MermaidLazyRenderer | undefined;
  let krokiController: AbortController | undefined;
  let mermaidStyles: MermaidStyleRegistry | undefined;
  let generationWait: { gen: number; ready: Promise<void>; resolve: () => void } | undefined;
  const [settledGen, setSettledGen] = createSignal(-1);

  // The flush used by PDF export is registered before any asynchronous step
  // of a generation. Its readiness promise stays available after initial work
  // settles so export can still drain diagrams outside the observer margin.
  function invalidateGenerationWait() {
    const wait = generationWait;
    generationWait = undefined;
    wait?.resolve();
  }

  function beginGenerationWait(gen: number) {
    let resolve!: () => void;
    const ready = new Promise<void>((r) => { resolve = r; });
    generationWait = { gen, ready, resolve };
  }

  async function flushCurrentMermaid(): Promise<void> {
    for (;;) {
      const wait = generationWait;
      if (!wait) return;
      await wait.ready;
      // The generation may have changed while waiting (including inside
      // flushAll): follow the new one instead of reporting stale work done.
      if (generationWait !== wait) continue;
      const renderer = mermaidRenderer;
      if (renderer) await renderer.flushAll();
      if (generationWait !== wait) continue;
      return;
    }
  }

  const unregisterMermaidFlush = registerMermaidFlush(
    () => flushCurrentMermaid(),
    // AppShell gives `tocContainer` only to the active pane; this is the same
    // signal that decides which pane's TOC is shared.
    () => !!untrack(() => props.tocContainer),
  );

  function disposeMermaidGeneration() {
    mermaidRenderer?.dispose();
    mermaidRenderer = undefined;
  }

  function scheduleMermaidStylePrune(gen: number) {
    setTimeout(() => {
      if (isStale(gen) || !articleRef || !mermaidStyles) return;
      const used = new Set<string>();
      for (const article of [articleRef, ...Array.from(parkedPreviews.values(), (preview) => preview.article)]) {
        for (const svg of article.querySelectorAll("svg")) {
          for (const name of svg.classList) {
            if (name.startsWith(MERMAID_CSS_CLASS_PREFIX)) used.add(name);
          }
        }
      }
      // An unchanged diagram may be outside the margin in the new generation:
      // its placeholder has no SVG, but its known sheet must stay for revisits.
      for (const block of articleRef.querySelectorAll<HTMLElement>("[data-mermaid-pending]")) {
        const source = pendingMermaidSources.get(block);
        if (!source) continue;
        const theme = document.documentElement.classList.contains("dark") ? "dark" : "default";
        const className = mermaidCache.classNameFor(mermaidCacheKey(source, theme));
        if (className) used.add(className);
      }
      // One macrotask, one removal pass: editing a diagram must not pay the
      // WebKit cost of removing and re-adding sheets on every generation.
      mermaidStyles.prune(used);
    }, 0);
  }

  function ensureMermaidStyles(): MermaidStyleRegistry {
    if (!mermaidStyles) {
      mermaidStyles = new MermaidStyleRegistry(articleRef!.parentElement!);
    }
    return mermaidStyles;
  }

  function stopTrackingAnchor() {
    stopAnchorTracking?.();
    stopAnchorTracking = undefined;
    repositionAnchor = undefined;
  }

  function clearPendingScrollTarget() {
    pendingScrollTarget?.cleanup();
    pendingScrollTarget = null;
  }

  function trackPendingScrollTarget(
    gen: number,
    content: HTMLElement,
    article: HTMLElement,
    block: Element,
    offset: number,
  ) {
    const diagramsAbove = new Set<HTMLElement>();
    for (const diagram of article.querySelectorAll<HTMLElement>("div.mermaid, div.kroki")) {
      if (!(block.compareDocumentPosition(diagram) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
      if (!diagram.textContent?.trim()) continue;
      if (diagram.dataset.processed && (
        diagram.matches(".kroki") ? diagram.dataset.processed === "true" : diagram.querySelector("svg, .mermaid-error")
      )) continue;
      diagramsAbove.add(diagram);
    }

    const cancel = () => clearPendingScrollTarget();
    const onScroll = () => {
      const target = pendingScrollTarget;
      if (target && Math.abs(content.scrollTop - target.expectedTop) > 1) cancel();
    };
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) cancel();
    };
    content.addEventListener("wheel", cancel, { passive: true });
    content.addEventListener("touchstart", cancel, { passive: true });
    content.addEventListener("touchmove", cancel, { passive: true });
    content.addEventListener("pointerdown", cancel, { passive: true });
    content.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKey);
    pendingScrollTarget = {
      gen,
      content,
      block,
      offset,
      diagramsAbove,
      expectedTop: content.scrollTop,
      cleanup: () => {
        content.removeEventListener("wheel", cancel);
        content.removeEventListener("touchstart", cancel);
        content.removeEventListener("touchmove", cancel);
        content.removeEventListener("pointerdown", cancel);
        content.removeEventListener("scroll", onScroll);
        window.removeEventListener("keydown", onKey);
      },
    };
    retryPendingScrollTarget();
  }

  function retryPendingScrollTarget(drawnDiagram?: HTMLElement) {
    const target = pendingScrollTarget;
    if (!target) return;
    if (isStale(target.gen) || !target.block.isConnected) {
      clearPendingScrollTarget();
      return;
    }
    const { content, block, offset, diagramsAbove } = target;
    if (drawnDiagram) diagramsAbove.delete(drawnDiagram);
    const delta = blockOffsetInViewport(block, content) - offset;
    setClampedScrollTop(content, content.scrollTop + delta);
    target.expectedTop = content.scrollTop;
    if (diagramsAbove.size === 0 && Math.abs(blockOffsetInViewport(block, content) - offset) <= 1) {
      clearPendingScrollTarget();
    }
  }

  onCleanup(clearPendingScrollTarget);
  onCleanup(stopTrackingAnchor);
  onCleanup(retainMermaidFrame());
  onCleanup(() => {
    ++renderGen;
    krokiController?.abort();
    unregisterMermaidFlush();
    invalidateGenerationWait();
    disposeMermaidGeneration();
    mermaidStyles?.dispose();
    articleRef?.removeEventListener("click", handleClick);
    parkedPreviews.clear();
  });

  // A superseded generation must not mutate the live article.
  async function finishPostProcessing(
    gen: number,
    steps: Array<() => Promise<void>>,
  ) {
    try {
      for (const step of steps) {
        if (isStale(gen)) return;
        try {
          await step();
        } catch {
          // Highlighting/diagram rendering is best-effort; keep going.
        }
      }
    } finally {
      if (!isStale(gen)) {
        processingGen = null;
        setSettledGen(gen);
        stopTrackingAnchor();
      }
    }
  }

  function computeScrollRatio(scrollTop: number, scrollHeight: number, clientHeight: number): number {
    const maxScrollTop = scrollHeight - clientHeight;
    if (maxScrollTop <= 0) return 0;
    const ratio = scrollTop / maxScrollTop;
    return Math.max(0, Math.min(1, ratio));
  }

  // Ctrl+F to open search overlay
  onSettled(() => {
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
    return () => window.removeEventListener("keydown", handleCtrlF);
  });

  // ── Preview selection → "Add to chat" popover ─────────────────────────
  // Mirrors the editor's selection tracking for the rendered article: a
  // mouseup with a non-collapsed DOM selection anchored inside `.doc-body`
  // shows the popover at the selection end; collapsing that selection
  // (clicking elsewhere, Escape) hides it. `props.onSelectionPopover` is read
  // per-event so the active-pane wiring in PaneView stays reactive, and the
  // handlers early-return when no consumer is wired.
  onSettled(() => {
    let popoverShown = false;

    const readSelectionInfo = (): PreviewSelectionInfo | null => {
      if (!articleRef) return null;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
      if (!sel.anchorNode || !articleRef.contains(sel.anchorNode)) return null;
      const text = sel.toString();
      if (!text.trim()) return null;
      // Coords are best-effort: jsdom zeroes Range.getBoundingClientRect(),
      // so fall back to the article's own rect — zeroed coords must not
      // suppress the popover (it clamps into the viewport anyway).
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const fallback = articleRef.getBoundingClientRect();
      return {
        bottom: rect.bottom || fallback.bottom,
        left: rect.left || fallback.left,
        source: "preview",
        text,
      };
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (!props.onSelectionPopover) return;
      if (!(e.target instanceof Node) || !articleRef?.contains(e.target)) return;
      const info = readSelectionInfo();
      if (!info) return;
      popoverShown = true;
      props.onSelectionPopover(info);
    };

    const handleSelectionChange = () => {
      if (!popoverShown || readSelectionInfo()) return;
      popoverShown = false;
      props.onSelectionPopover?.(null);
    };

    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("selectionchange", handleSelectionChange);
      if (popoverShown) props.onSelectionPopover?.(null);
    };
  });

  createEffect(
    () => props.findTrigger,
    (findTrigger) => {
      if (findTrigger === lastFindTrigger) return;
      lastFindTrigger = findTrigger;
      props.onSearchOpenChange(true);
    },
    { defer: true },
  );

  createEffect(
    () => hasArticle(),
    (has) => {
      if (!has) return;
      setOverlayHost(articleRef?.closest(".preview-panel") as HTMLElement | undefined);
    },
  );

  createEffect(
    () => hasArticle(),
    (has) => {
      if (!has || !articleRef) return;

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
      return () => {
        cancelAnimationFrame(scrollRaf);
        scrollContainer.removeEventListener("scroll", onScroll);
      };
    },
  );

  createEffect(
    () => props.syncScrollTargetVersion,
    (targetVersion) => {
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
    },
    { defer: true },
  );

  onCleanup(() => cleanupToc?.());

  /**
   * Intercept clicks on links inside the rendered AsciiDoc:
   * - #anchor links: scroll manually within .content container (prevent hash corruption)
   * - .adoc file links: navigate via SPA routing
   */
  function scrollToTarget(target: HTMLElement, track = false) {
    clearPendingScrollTarget();
    stopTrackingAnchor();
    const contentEl = articleRef?.closest<HTMLElement>(".content");
    let expectedTop = contentEl?.scrollTop ?? 0;
    const scroll = () => {
      if (!target.isConnected) return;
      if (contentEl) {
        const offset = target.getBoundingClientRect().top - contentEl.getBoundingClientRect().top + contentEl.scrollTop - 16;
        contentEl.scrollTo({ top: offset, behavior: "instant" });
        expectedTop = contentEl.scrollTop;
      } else {
        target.scrollIntoView({ behavior: "instant" });
      }
    };
    scroll();
    if (!track || processingGen === null || !contentEl) return;
    const cancelOnScroll = () => {
      if (Math.abs(contentEl.scrollTop - expectedTop) > 1) stopTrackingAnchor();
    };
    const cancelOnInput = () => stopTrackingAnchor();
    const cancelOnKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) stopTrackingAnchor();
    };
    contentEl.addEventListener("scroll", cancelOnScroll, { passive: true });
    contentEl.addEventListener("wheel", cancelOnInput, { passive: true });
    contentEl.addEventListener("touchmove", cancelOnInput, { passive: true });
    window.addEventListener("keydown", cancelOnKey);
    repositionAnchor = scroll;
    stopAnchorTracking = () => {
      contentEl.removeEventListener("scroll", cancelOnScroll);
      contentEl.removeEventListener("wheel", cancelOnInput);
      contentEl.removeEventListener("touchmove", cancelOnInput);
      window.removeEventListener("keydown", cancelOnKey);
    };
  }

  function scrollToFragment(fragmentId: string, track = false): boolean {
    const target = articleRef?.querySelector<HTMLElement>(`[id="${CSS.escape(fragmentId)}"]`);
    if (!target) return false;
    scrollToTarget(target, track);
    return true;
  }

  function scrollToHeading(headingText: string, track = false): boolean {
    const hs = articleRef?.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6") ?? [];
    const target = Array.from(hs).find((h) => h.textContent?.trim() === headingText);
    if (!target) return false;
    scrollToTarget(target, track);
    return true;
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
        setViewerSvg(svgWithMermaidStyles(svgEl, mermaidStyles));
        return;
      }
    }

    // Click an inline image (not a linked one) → open its menu centered at the top
    // of the image (size presets + a Zoom action that opens the lightbox). Top is
    // clamped so the menu stays on-screen if the image top is scrolled out of view.
    const clickedImg = (e.target as HTMLElement).closest<HTMLImageElement>("img");
    if (clickedImg && !clickedImg.closest("a")) {
      e.preventDefault();
      e.stopPropagation();
      const r = clickedImg.getBoundingClientRect();
      // Centered at the image's top; clamp the center X so the menu (centered via
      // translateX(-50%)) stays on-screen for very wide / scrolled images.
      const centerX = Math.min(Math.max(r.left + r.width / 2, 100), window.innerWidth - 100);
      setSizeMenuPos({ top: Math.max(r.top + 8, 8), left: centerX });
      setSizeMenuImg(clickedImg);
      return;
    }

    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor) return;

    const href = anchor.getAttribute("href");
    if (!href) return;

    // Handle #anchor links (TOC items, section links)
    if (href.startsWith("#")) {
      e.preventDefault();
      const targetId = decodeURIComponent(href.slice(1));
      if (targetId && !scrollToFragment(targetId)) props.onUnresolvedFragment?.(targetId);
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

  // Highlight new documents in a detached buffer, then attach them before
  // diagram rendering so Mermaid can measure the live layout.
  //
  // When html becomes empty (file switch), old content stays hidden (opacity:0)
  // to preserve layout dimensions and prevent content shrink/grow shift.
  //
  // Note: props.html can come from local or remote documents.
  // Always sanitize before injecting into the DOM.
  let pendingNewDocument = false;
  let lastSeenActivationVersion: number | undefined;
  let pendingRestoreTabId: string | null = null;
  let pendingScrollTarget: PendingTabScrollTarget | null = null;

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
  createEffect(
    () => ({ container: props.tocContainer, tocVis: props.tocVisible }),
    ({ container, tocVis }) => {
    // Always cleanup first — this also covers the deactivation path,
    // where `container` becomes undefined. Without this, the previous
    // session's scroll listener would keep firing against `articleRef`
    // and toggling `.toc-active` on a now-detached toc tree (the one we
    // moved into the shared container, then the other pane wiped).
    cleanupToc?.();
    cleanupToc = undefined;
    if (!container) return;
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
    return () => {
      cleanupToc?.();
      cleanupToc = undefined;
    };
    },
  );

  function replaceArticle(next: HTMLElement) {
    articleRef!.removeEventListener("click", handleClick);
    articleRef!.replaceWith(next);
    articleRef = next;
    next.classList.add("doc-body");
    next.classList.toggle("doc-tables-wrap", untrack(() => props.wrapTables));
    next.addEventListener("click", handleClick);
    setActiveArticle(next);
  }

  createEffect(() => props.wrapTables, (wrap) => {
    articleRef?.classList.toggle("doc-tables-wrap", wrap);
  });

  createEffect(cacheTabs, (tabs) => {
    const reusable = new Set(tabs?.filter((tab) => !tab.diskChange).map((tab) => tab.id));
    let removed = false;
    for (const id of parkedPreviews.keys()) {
      if (!reusable.has(id)) removed = parkedPreviews.delete(id) || removed;
    }
    if (removed) scheduleMermaidStylePrune(renderGen);
  });

  createEffect(
    () => ({
      html: props.html,
      tabId: props.currentTabId ?? null,
      activationVersion: props.tabActivationVersion,
      theme: props.darkMode,
      tabs: untrack(cacheTabs),
    }),
    ({ html: _html, tabId, activationVersion, theme, tabs }) => {
    if (!articleRef) return;
    const activated = activationVersion !== lastSeenActivationVersion;
    const themeChanged = theme !== lastTheme;
    lastSeenActivationVersion = activationVersion;
    lastTheme = theme;
    if (activated) pendingRestoreTabId = tabId;
    else if (pendingRestoreTabId !== tabId) pendingRestoreTabId = null;

    if (themeChanged) parkedPreviews.clear();

    const gen = ++renderGen;
    krokiController?.abort();
    clearPendingScrollTarget();
    stopTrackingAnchor();
    disposeMermaidGeneration();
    invalidateGenerationWait();
    processingGen = null;
    articleRef.dataset.previewTabId = "";

    const reusable = (id: string) => tabs?.some((tab) => tab.id === id && !tab.diskChange);
    let cached: RenderedPreview | undefined;
    if (tabs && tabId !== null && _html) {
      const candidate = parkedPreviews.get(tabId);
      parkedPreviews.delete(tabId);
      if (candidate && candidate.html === _html && reusable(tabId)) cached = candidate;
    }
    if (tabs && activated && renderedPreview?.tabId !== tabId) {
      const leavingId = renderedPreview?.tabId;
      if (!themeChanged && renderedPreview && leavingId && reusable(leavingId)) {
        parkedPreviews.set(leavingId, renderedPreview);
        if (parkedPreviews.size >= RECENT_PREVIEW_LIMIT) {
          parkedPreviews.delete(parkedPreviews.keys().next().value!);
        }
      }
      replaceArticle(cached?.article ?? document.createElement("article"));
      setSizeMenuImg(null);
    } else if (cached) {
      replaceArticle(cached.article);
    }
    renderedPreview = undefined;

    if (!_html) {
      setRenderedHtml(null);
      articleRef.style.opacity = "0";
      cleanupToc?.();
      cleanupToc = undefined;
      tocNode = undefined;
      pendingNewDocument = true;
      const emptyTocContainer = untrack(() => props.tocContainer);
      if (emptyTocContainer) {
        emptyTocContainer.textContent = "";
        props.onTocChange(false);
      }
      scheduleMermaidStylePrune(gen);
      return;
    }

    beginGenerationWait(gen);
    const controller = new AbortController();
    krokiController = controller;
    processingGen = gen;
    setRenderedHtml(null);
    const isNewDocument = pendingNewDocument;
    pendingNewDocument = false;
    const preview = cached ?? { tabId, html: _html, article: articleRef, toc: undefined, highlighted: false };
    const highlight = async (article: HTMLElement) => {
      if (preview.highlighted) return;
      await highlightCodeBlocks(article, gen, isStale);
      if (!isStale(gen)) preview.highlighted = true;
    };

    const onDiagramDrawn = (block: HTMLElement) => {
      if (isStale(gen)) return;
      retryPendingScrollTarget(block);
      repositionAnchor?.();
    };
    const isAnchorTracking = () => !!pendingScrollTarget || !!repositionAnchor;

    function prepareMermaidGeneration(currentGen: number): Promise<void> {
      const wait = generationWait;
      const settle = () => {
        wait?.resolve();
        scheduleMermaidStylePrune(currentGen);
      };
      let renderer: MermaidLazyRenderer | undefined;
      try {
        const setup = setupMermaidBlocks(
          articleRef!, currentGen, isStale, ensureMermaidStyles(),
          onDiagramDrawn, isAnchorTracking,
        );
        // Adding the Mermaid placeholders can change the layout before any SVG draws.
        if (!isStale(currentGen)) retryPendingScrollTarget();
        if (!setup || isStale(currentGen)) {
          settle();
          return Promise.resolve();
        }
        renderer = setup.renderer;
        mermaidRenderer = renderer;
        return setup.ready.then(settle, () => {
          renderer?.dispose();
          if (mermaidRenderer === renderer) mermaidRenderer = undefined;
          settle();
        });
      } catch {
        renderer?.dispose();
        if (mermaidRenderer === renderer) mermaidRenderer = undefined;
        settle();
        return Promise.resolve();
      }
    }

    // Shared post-swap logic: TOC handling, collapse toggles, reveal, fragment scroll
    function afterSwap(container: HTMLElement, scrollToTop: boolean) {
      const scrollContainer = articleRef!.closest<HTMLElement>(".content");
      const hasPendingJump = !!untrack(() => props.pendingFragment ?? props.pendingHeadingText);
      const currentTabId = untrack(() => props.currentTabId) ?? null;
      const currentActivationVersion = untrack(() => props.tabActivationVersion);
      const restore = pendingRestoreTabId !== null
        && pendingRestoreTabId === tabId
        && currentTabId === tabId
        && currentActivationVersion === activationVersion
        && !hasPendingJump
          ? untrack(() => props.getTabScrollRestore?.())
          : null;
      const validRestore = restore && restore.tabId === tabId
        && restore.path === (untrack(() => props.currentFilePath) ?? null)
        ? restore
        : null;
      if (currentTabId === tabId && currentActivationVersion === activationVersion) pendingRestoreTabId = null;

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
      const tocContainer = untrack(() => props.tocContainer);
      const toc = cached ? cached.toc : container.querySelector<HTMLElement>("#toc") ?? undefined;
      tocNode = toc;
      preview.toc = toc;
      renderedPreview = preview;
      if (tocContainer) {
        tocContainer.textContent = "";
        if (toc) tocContainer.appendChild(toc);
      } else if (toc) {
        toc.remove();
      }

      props.onTocChange(!!toc);

      // Set up collapse toggles and scroll tracking
      cleanupToc?.();
      if (untrack(() => props.tocVisible)) {
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

      // The capture measured the article with the toc already detached.
      // Apply the saved index only after this swap did the same, otherwise
      // the index points at the preceding sibling.
      if (validRestore && scrollContainer) {
        const anchor = validRestore.anchor;
        const block = anchor && tabScrollAnchorBlock(container, anchor);
        if (cached || !block) setClampedScrollTop(scrollContainer, validRestore.scrollTop);
        if (anchor && block && (!cached || Math.abs(blockOffsetInViewport(block, scrollContainer) - anchor.offset) > 1)) {
          trackPendingScrollTarget(gen, scrollContainer, container, block, anchor.offset);
        }
      } else if (scrollToTop && scrollContainer) {
        scrollContainer.scrollTop = 0;
      }
      articleRef!.dataset.previewTabId = tabId ?? "";
      articleRef!.style.opacity = "";
      setRenderedHtml(_html);
    }

    const renderDiagrams = [
      () => prepareMermaidGeneration(gen),
      () => renderKrokiBlocks(preview.article, gen, isStale, controller.signal, onDiagramDrawn),
    ];
    const run = (steps: Array<() => Promise<void>>) => {
      queueMicrotask(() => finishPostProcessing(gen, steps));
    };

    if (cached) {
      afterSwap(preview.article, false);
      run([() => highlight(preview.article), ...renderDiagrams]);
      return;
    }

    const sanitizedHtml = sanitizeHtmlFragment(_html);
    const container = isNewDocument ? document.createElement("div") : preview.article;
    const scrollContainer = articleRef.closest(".content");
    const prevScrollTop = scrollContainer?.scrollTop ?? 0;
    container.innerHTML = sanitizedHtml;
    if (scrollContainer) scrollContainer.scrollTop = prevScrollTop;
    wrapTablesForScroll(container);
    wrapImagesForScroll(container);
    const resolveImageSrc = untrack(() => props.resolveImageSrc);
    if (resolveImageSrc) rewriteImageSources(container, resolveImageSrc);

    if (isNewDocument) {
      // A detached buffer keeps unhighlighted code out of the first paint.
      run([
        () => highlight(container),
        async () => {
          preview.article.replaceChildren(...Array.from(container.childNodes));
          afterSwap(preview.article, true);
        },
        () => nextPaintFrame(),
        ...renderDiagrams,
      ]);
    } else {
      afterSwap(preview.article, false);
      run([() => highlight(preview.article), ...renderDiagrams]);
    }
    },
  );

  // A jump request belongs to the document that was current when the
  // request was made. The host keeps pendingFragment/pendingHeadingText in
  // global signals, and the readiness wait can keep them alive while a
  // diagram from the previous file is still rendering. Track the owner in
  // the same computation as the path: when the path and a new request
  // arrive together (either order), the new file owns the request; when
  // only the path changes, the old request is discarded here. The host's
  // completion callback is deliberately NOT called for the new document.
  const [requestOwner, setRequestOwner] = createSignal<string | null>(null);
  let lastRequestPath: string | null = null;
  let lastFragment: string | null = null;
  let lastHeading: string | null = null;
  let completedFragment: string | null = null;
  let completedHeading: string | null = null;
  createEffect(
    () => ({
      path: props.currentFilePath ?? null,
      fragment: props.pendingFragment,
      heading: props.pendingHeadingText ?? null,
    }),
    ({ path, fragment, heading }) => {
      const droppedFragment = lastFragment;
      const droppedHeading = lastHeading;
      const requestChanged = fragment !== droppedFragment || heading !== droppedHeading;
      const pathChanged = path !== lastRequestPath;
      if (pathChanged || fragment !== droppedFragment) completedFragment = null;
      if (pathChanged || heading !== droppedHeading) completedHeading = null;
      lastFragment = fragment;
      lastHeading = heading;
      lastRequestPath = path;
      if (requestChanged) {
        setRequestOwner(fragment || heading ? path : null);
      } else if (pathChanged) {
        setRequestOwner(null);
      }
      if (pathChanged) {
        // The old request belongs to the previous document. Report it as
        // dropped — never as handled — so the host can clear its signal.
        // A new request for the new document may already be in the host
        // signal; the host decides by comparing the value before clearing.
        if (droppedFragment) props.onFragmentDiscarded?.(droppedFragment);
        if (droppedHeading) props.onHeadingDiscarded?.(droppedHeading);
      }
    },
  );

  // A host can destroy this Preview before the path-change effect above
  // runs — switching from a Markdown file to an HTML file replaces the
  // component with HtmlPreview. If a request still belongs to this
  // instance, hand it back as discarded from teardown so it cannot jump
  // when the Markdown file is reopened. The host clears only when the
  // value still matches, so a newer request survives; a handled request
  // already made `requestOwner` null and is never reported here.
  onCleanup(() => {
    if (untrack(requestOwner) === null) return;
    if (lastFragment) props.onFragmentDiscarded?.(lastFragment);
    if (lastHeading) props.onHeadingDiscarded?.(lastHeading);
  });

  // Navigation requests can arrive while the document is already on
  // screen — choosing a symbol in the current file writes
  // `pendingHeadingText`, and a #fragment on the current file writes
  // `pendingFragment` without changing `html`. Both must be tracked in
  // the compute; reading them from the html effect's apply phase missed
  // those requests entirely. This effect only performs the jump: html
  // still renders in its own effect, so a request change never re-renders
  // the document.
  createEffect(
    () => ({
      fragment: props.pendingFragment,
      heading: props.pendingHeadingText,
      // Only the attached generation can receive a request.
      ready: !!props.html && renderedHtml() === props.html,
      settled: settledGen() === renderGen,
      owner: requestOwner(),
    }),
    ({ fragment, heading, ready, settled, owner }) => {
      if (!ready || !articleRef) return;
      // A request left over from another file must never be consumed
      // against this article, even when its fragment/heading also exists
      // here (homonymous targets). Ownership is null once dropped.
      if (owner === null || owner !== (props.currentFilePath ?? null)) return;
      if (fragment && completedFragment !== fragment) {
        if (scrollToFragment(fragment, true)) {
          completedFragment = fragment;
          props.onFragmentHandled();
        } else if (settled) {
          completedFragment = fragment;
          if (props.onFragmentDiscarded) props.onFragmentDiscarded(fragment);
          else props.onFragmentHandled();
        }
      }
      if (heading && completedHeading !== heading) {
        if (scrollToHeading(heading, true)) {
          completedHeading = heading;
          props.onHeadingHandled?.();
        } else if (settled) {
          completedHeading = heading;
          if (props.onHeadingDiscarded) props.onHeadingDiscarded(heading);
          else props.onHeadingHandled?.();
        }
      }
    },
  );

  return (
    <div class="preview-scope">
      <Show when={hasArticle()}>
        <SearchOverlay
          container={renderedHtml() ? activeArticle() : undefined}
          class="search-overlay-preview"
          portalHost={props.previewOverlayHost ?? overlayHost()}
          visible={props.searchOpen}
          onClose={() => props.onSearchOpenChange(false)}
        />
      </Show>
      <DiagramViewer svg={viewerSvg()} onClose={() => setViewerSvg(null)} />
      <ImageLightbox src={viewerImage()} onClose={() => setViewerImage(null)} />
      <Show when={sizeMenuImg()}>
        <Portal>
        <div
          class="img-size-menu"
          style={`top:${sizeMenuPos().top}px; left:${sizeMenuPos().left}px`}
        >
          <button class="img-size-btn" title="Small" onClick={() => applyImageSize("small")}>
            <IconMinimize width={13} height={13} />
          </button>
          <button class="img-size-btn" title="Fit (default)" onClick={() => applyImageSize("fit")}>
            <IconScan width={13} height={13} />
          </button>
          <button class="img-size-btn" title="Full width" onClick={() => applyImageSize("wide")}>
            <IconStretch width={13} height={13} />
          </button>
          <button class="img-size-btn" title="Original size" onClick={() => applyImageSize("original")}>
            <IconMaximize width={13} height={13} />
          </button>
          <span class="img-size-sep" />
          <button class="img-size-btn" title="Zoom (open viewer)" onClick={openImageZoom}>
            <IconExpand width={13} height={13} />
          </button>
        </div>
        </Portal>
      </Show>
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
            el.classList.toggle("doc-tables-wrap", untrack(() => props.wrapTables));
            el.addEventListener("click", handleClick);
            setActiveArticle(el);
          }}
          class="doc-body"
        />
      </div>
    </div>
  );
}
