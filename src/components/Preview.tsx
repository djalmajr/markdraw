import { Show, createEffect, onMount, onCleanup } from "solid-js";
import mermaid from "mermaid";
import "../styles/asciidoc.css";

let mermaidInitialized = false;

function initMermaid() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
    securityLevel: "loose",
    fontFamily: "inherit",
  });
  mermaidInitialized = true;
}

async function renderMermaidBlocks(container: HTMLElement) {
  const blocks = container.querySelectorAll<HTMLElement>("div.mermaid");
  if (blocks.length === 0) return;

  initMermaid();

  let idx = 0;
  for (const block of blocks) {
    if (block.getAttribute("data-processed")) continue;

    const source = block.textContent?.trim() ?? "";
    if (!source) continue;

    try {
      const id = `mermaid-${Date.now()}-${idx++}`;
      const { svg } = await mermaid.render(id, source);
      block.innerHTML = svg;
      block.setAttribute("data-processed", "true");
    } catch (e) {
      console.warn("Mermaid render error:", e);
      block.innerHTML = `<pre class="mermaid-error">Mermaid error: ${e}\n\n${source}</pre>`;
    }
  }
}

/** Set up IntersectionObserver to highlight the current TOC link based on scroll position */
function setupTocScrollTracking(container: HTMLElement): (() => void) | undefined {
  const toc = container.querySelector("#toc");
  if (!toc) return;

  // Collect all heading IDs referenced in the TOC
  const tocLinks = Array.from(toc.querySelectorAll<HTMLAnchorElement>("a[href^='#']"));
  if (tocLinks.length === 0) return;

  const headingIds = tocLinks.map((a) => a.getAttribute("href")!.slice(1));
  const headings = headingIds
    .map((id) => container.querySelector(`[id="${id}"]`))
    .filter(Boolean) as HTMLElement[];

  if (headings.length === 0) return;

  let currentActive: HTMLAnchorElement | null = null;

  function setActive(id: string) {
    if (currentActive) currentActive.classList.remove("toc-active");
    const link = toc!.querySelector<HTMLAnchorElement>(`a[href="#${id}"]`);
    if (link) {
      link.classList.add("toc-active");
      currentActive = link;
    }
  }

  // Track which headings are visible; pick the topmost
  const visibleHeadings = new Map<string, IntersectionObserverEntry>();

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).id;
        if (entry.isIntersecting) {
          visibleHeadings.set(id, entry);
        } else {
          visibleHeadings.delete(id);
        }
      }

      // Find the topmost visible heading (smallest boundingClientRect.top)
      let topId: string | null = null;
      let topY = Infinity;
      for (const [id, entry] of visibleHeadings) {
        if (entry.boundingClientRect.top < topY) {
          topY = entry.boundingClientRect.top;
          topId = id;
        }
      }

      if (topId) {
        setActive(topId);
      }
    },
    {
      // Observe within the scrolling content area, trigger early
      rootMargin: "-44px 0px -60% 0px",
      threshold: 0,
    }
  );

  for (const heading of headings) {
    observer.observe(heading);
  }

  // Activate the first heading initially
  if (headings.length > 0) {
    setActive(headings[0].id);
  }

  return () => observer.disconnect();
}

interface PreviewProps {
  html: string;
  loading: boolean;
  tocVisible: boolean;
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

  // Render mermaid blocks and set up TOC tracking whenever html changes
  createEffect(() => {
    const _html = props.html;
    if (articleRef && _html) {
      queueMicrotask(() => {
        renderMermaidBlocks(articleRef!);

        // Clean up previous observer, set up new one
        cleanupToc?.();
        cleanupToc = setupTocScrollTracking(articleRef!);
      });
    }
  });

  // Toggle TOC visibility
  createEffect(() => {
    if (!articleRef) return;
    const toc = articleRef.querySelector<HTMLElement>("#toc");
    if (toc) {
      toc.style.display = props.tocVisible ? "" : "none";
    }
  });

  return (
    <div class="preview">
      <Show when={props.loading}>
        <div class="preview-loading">Converting...</div>
      </Show>
      <article ref={articleRef} class="adoc-body" innerHTML={props.html} />
    </div>
  );
}
