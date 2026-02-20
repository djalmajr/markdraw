import { Show, createEffect, onMount, onCleanup } from "solid-js";
import mermaid from "mermaid";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github.css";
import "katex/dist/katex.min.css";
import "@mdit/plugin-alert/style";
import "../styles/asciidoc.css";

let mermaidInitialized = false;

function initMermaid(force = false) {
  if (mermaidInitialized && !force) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
    securityLevel: "loose",
    fontFamily: "inherit",
  });
  mermaidInitialized = true;
}

/** Monotonically increasing render generation — used to cancel stale renders */
let mermaidRenderGen = 0;

/** Apply syntax highlighting to code blocks that haven't been highlighted yet */
function highlightCodeBlocks(container: HTMLElement) {
  container.querySelectorAll<HTMLElement>("pre code").forEach((el) => {
    // Asciidoctor adds "hljs" class when source-highlighter is highlight.js,
    // but doesn't actually run highlight.js. Check for real highlighting
    // by looking for hljs-* child spans instead.
    const alreadyHighlighted = el.querySelector("span[class^='hljs-']") !== null;
    if (!alreadyHighlighted) {
      hljs.highlightElement(el);
    }
  });
}

async function renderMermaidBlocks(container: HTMLElement) {
  const blocks = container.querySelectorAll<HTMLElement>("div.mermaid");
  if (blocks.length === 0) return;

  // Bump generation — any in-flight render from a previous call will bail out
  const gen = ++mermaidRenderGen;

  // Force re-init to reset mermaid's internal parser/registry state
  initMermaid(true);

  let idx = 0;
  for (const block of blocks) {
    // Bail out if a newer render has started (navigation happened mid-render)
    if (gen !== mermaidRenderGen) return;

    if (block.getAttribute("data-processed")) continue;

    const source = block.textContent?.trim() ?? "";
    if (!source) continue;

    try {
      const id = `mermaid-${gen}-${idx++}`;
      const { svg } = await mermaid.render(id, source);
      // Check again after await — DOM may have been replaced
      if (gen !== mermaidRenderGen) return;
      block.innerHTML = svg;
    } catch (e) {
      if (gen !== mermaidRenderGen) return;
      // Show inline error instead of raw source
      const escaped = source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      block.innerHTML = `<pre class="mermaid-error">Mermaid syntax error\n\n${escaped}</pre>`;
    }

    // Always mark as processed to prevent re-processing on effect re-runs
    block.setAttribute("data-processed", "true");

    // Clean up temporary render containers mermaid leaves in the body
    document.querySelectorAll('div[id^="dmermaid-"]').forEach((el) => el.remove());
  }
}

/** Set up IntersectionObserver to highlight the current TOC link based on scroll position */
function setupTocScrollTracking(container: HTMLElement): (() => void) | undefined {
  const toc = container.querySelector("#toc");
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
    const link = toc!.querySelector<HTMLAnchorElement>(`a[href="#${id}"]`);
    if (link) {
      link.classList.add("toc-active");
      currentActive = link;
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

import { isSupportedFile, isAdocFile } from "../lib/utils.ts";

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
  html: string;
  loading: boolean;
  tocVisible: boolean;
  /** Current file path (relative to root), used to resolve xref links */
  currentFilePath: string | null;
  /** Fragment ID to scroll to after content loads (from cross-file xref navigation) */
  pendingFragment: string | null;
  /** Called after the pending fragment has been scrolled to (to clear the signal) */
  onFragmentHandled: () => void;
  /** Called when user clicks a document link (.adoc/.md); receives the resolved path and optional fragment */
  onNavigate: (path: string, fragment?: string | null) => void;
}

export function Preview(props: PreviewProps) {
  let articleRef: HTMLElement | undefined;
  let cleanupToc: (() => void) | undefined;

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

  // Render mermaid blocks, set up TOC tracking, and apply TOC visibility whenever html changes
  createEffect(() => {
    const _html = props.html;
    // Also track tocVisible so this re-runs when it changes
    const tocVis = props.tocVisible;

    if (articleRef && _html) {
      queueMicrotask(() => {
        highlightCodeBlocks(articleRef!);
        renderMermaidBlocks(articleRef!);

        // Apply TOC visibility
        const toc = articleRef!.querySelector<HTMLElement>("#toc");
        if (toc) {
          toc.style.display = tocVis ? "" : "none";
        }

        // Set up scroll tracking (only if TOC is visible)
        cleanupToc?.();
        if (tocVis) {
          cleanupToc = setupTocScrollTracking(articleRef!);
        } else {
          cleanupToc = undefined;
        }

        // Scroll to pending fragment after content renders (cross-file xref navigation)
        const frag = props.pendingFragment;
        if (frag) {
          scrollToFragment(frag);
          props.onFragmentHandled();
        }
      });
    }
  });

  return (
    <div class="preview">
      <Show when={props.loading}>
        <div class="preview-loading">Converting...</div>
      </Show>
      <article
        ref={articleRef}
        class="doc-body"
        innerHTML={props.html}
        onClick={handleClick}
      />
    </div>
  );
}
