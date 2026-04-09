import { Show, createSignal, createEffect, onMount, onCleanup } from "solid-js";
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

/** Monotonically increasing render generation — used to cancel stale renders */
let renderGen = 0;

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

async function highlightCodeBlocks(container: HTMLElement, gen: number): Promise<void> {
  if (gen !== renderGen) return;
  const blocks = container.querySelectorAll<HTMLElement>("pre code");
  for (const codeEl of blocks) {
    if (gen !== renderGen) return;

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

async function renderMermaidBlocks(container: HTMLElement, gen: number): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>("div.mermaid");
  if (blocks.length === 0) return;

  // Force re-init to reset mermaid's internal parser/registry state
  initMermaid(true);

  let idx = 0;
  for (const block of blocks) {
    // Bail out if a newer render has started (navigation happened mid-render)
    if (gen !== renderGen) return;

    if (block.getAttribute("data-processed")) continue;

    const source = block.textContent?.trim() ?? "";
    if (!source) continue;

    try {
      const id = `mermaid-${gen}-${idx++}`;
      const { svg } = await mermaid.render(id, source);
      // Check again after await — DOM may have been replaced
      if (gen !== renderGen) return;
      // mermaid.render returns sanitized SVG — safe to inject
      block.innerHTML = svg;
    } catch (e: any) {
      if (gen !== renderGen) return;
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
async function renderKrokiBlocks(container: HTMLElement, gen: number): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>("div.kroki");
  for (const block of blocks) {
    if (gen !== renderGen) return;
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
      if (gen !== renderGen) return;
      block.style.color = "";
      block.style.fontStyle = "";
      // renderKroki returns SVG from an external service, sanitize before inject
      block.innerHTML = sanitizeHtmlFragment(svg);
    } catch (e: any) {
      if (gen !== renderGen) return;
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
  /** Called when user clicks a document link (.adoc/.md); receives the resolved path and optional fragment */
  onNavigate: (path: string, fragment?: string | null) => void;
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

    // Skip mailto links
    if (href.startsWith("mailto:")) return;

    // Skip truly external links (http/https) but NOT file:// links
    if (/^https?:\/\//i.test(href)) return;

    // Handle file:// links — extract path and navigate
    if (href.startsWith("file://")) {
      if (isSupportedHref(href.replace(/^file:\/\//, ""))) {
        e.preventDefault();
        e.stopPropagation();
        props.onNavigate(href);
      }
      return;
    }

    // Check if it's a supported file link (.adoc, .md, .html, etc.)
    if (!isSupportedHref(href)) return;

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

      // Move #toc from article to external panel container
      const tocContainer = props.tocContainer;
      const toc = container.querySelector<HTMLElement>("#toc");
      if (tocContainer) {
        tocContainer.textContent = "";
        if (toc) tocContainer.appendChild(toc);
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
        await highlightCodeBlocks(buffer, gen);
        if (gen !== renderGen) return;

        await renderMermaidBlocks(buffer, gen);
        if (gen !== renderGen) return;

        await renderKrokiBlocks(buffer, gen);
        if (gen !== renderGen) return;

        const scrollContainer = articleRef!.closest(".content");
        const prevScrollTop = scrollContainer?.scrollTop ?? 0;
        articleRef!.replaceChildren(...Array.from(buffer.childNodes));
        if (scrollContainer) scrollContainer.scrollTop = prevScrollTop;

        afterSwap(articleRef!, true, tocVis);
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
        await highlightCodeBlocks(articleRef!, gen);
        if (gen !== renderGen) return;

        await renderMermaidBlocks(articleRef!, gen);
        if (gen !== renderGen) return;

        await renderKrokiBlocks(articleRef!, gen);
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
          <div class="preview-loading">Converting...</div>
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
