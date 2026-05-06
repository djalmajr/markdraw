import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Button } from "@asciimark/ui/components/ui/button.tsx";

interface GuideImage {
  alt: string;
  caption: string;
  src: string;
}

interface GuideSectionLink {
  href: string;
  label: string;
}

const sectionLinks: GuideSectionLink[] = [
  { href: "#installation", label: "Installation" },
  { href: "#opening-files", label: "Opening Files" },
  { href: "#tabs", label: "Tabs" },
  { href: "#navigation", label: "Navigation" },
  { href: "#toc", label: "TOC and References" },
  { href: "#workspace-symbols", label: "Workspace Symbols" },
  { href: "#reader-mode", label: "Reader Mode" },
  { href: "#search", label: "Search" },
  { href: "#editor", label: "Editor" },
  { href: "#appearance", label: "Appearance" },
  { href: "#processing", label: "Document Processing" },
  { href: "#diagrams", label: "Diagrams" },
  { href: "#export", label: "Export" },
  { href: "#shortcuts", label: "Keyboard Shortcuts" },
  { href: "#screenshots", label: "Screenshots" },
];

interface GuideScreenshot {
  alt: string;
  caption: string;
  src: string;
}

const guideScreenshots: GuideScreenshot[] = [
  {
    src: "/screenshots/desktop-welcome.png",
    alt: "AsciiMark welcome screen with drop zone and keyboard shortcuts hint",
    caption: "Welcome screen — drop a folder or click to open. The keyboard hint in the corner opens the shortcuts modal.",
  },
  {
    src: "/screenshots/desktop-workspace-preview.png",
    alt: "AsciiMark workspace with file tree, tabs, preview, and TOC",
    caption: "A loaded workspace: sidebar tree, tab bar, live preview, and table of contents.",
  },
  {
    src: "/screenshots/desktop-split-panes.png",
    alt: "Two files open in split panes side by side",
    caption: "Split panes (Cmd/Ctrl+\\) — read or compare two documents at the same time. Each pane has its own tab list and TOC.",
  },
  {
    src: "/screenshots/desktop-preview-tabs.png",
    alt: "Active workspace with one pinned tab and one preview tab in italic",
    caption: "VSCode-style tabs — single-click opens the file in the preview slot (italic title); edit, double-click, or drag pins it.",
  },
  {
    src: "/screenshots/desktop-toc-segmented.png",
    alt: "Right gutter segmented into Summary and References tabs",
    caption: "Right gutter is segmented into Summary (TOC) and References (workspace backlinks). Status bar shows live word count + reading time.",
  },
  {
    src: "/screenshots/desktop-backlinks-panel.png",
    alt: "References tab listing five workspace files that reference the active doc",
    caption: "Backlinks — every workspace file that links to the active doc via Markdown link, AsciiDoc xref, or include::. Click a row to navigate.",
  },
  {
    src: "/screenshots/desktop-workspace-symbols.png",
    alt: "Workspace symbol palette listing headings across every doc",
    caption: "Workspace Symbol Search (Cmd/Ctrl+Alt+O) — fuzzy-match headings across every doc in the workspace and jump in one click.",
  },
  {
    src: "/screenshots/desktop-reader-mode.png",
    alt: "Reader mode rendering only the centered preview without chrome",
    caption: "Reader / Zen mode (Cmd/Ctrl+.) — chrome collapses, preview centers at a comfortable reading width.",
  },
  {
    src: "/screenshots/desktop-edit-preview.png",
    alt: "Editor and preview synced inside a single pane",
    caption: "Edit + Preview mode — write Markdown/AsciiDoc on the left and see the rendering on the right.",
  },
  {
    src: "/screenshots/desktop-quick-open.png",
    alt: "Cmd/Ctrl+P fuzzy file picker showing matched files",
    caption: "Quick Open (Cmd/Ctrl+P) — fuzzy-match files across all open workspaces.",
  },
  {
    src: "/screenshots/desktop-command-palette.png",
    alt: "Cmd/Ctrl+Shift+P command palette listing actions",
    caption: "Command Palette (Cmd/Ctrl+Shift+P) — every action in one place, including theme and editor mode.",
  },
  {
    src: "/screenshots/desktop-symbol-palette.png",
    alt: "Cmd/Ctrl+Shift+O heading navigator showing the document outline",
    caption: "Go to Heading (Cmd/Ctrl+Shift+O) — jump anywhere in the current document.",
  },
  {
    src: "/screenshots/desktop-find-in-files.png",
    alt: "Cmd/Ctrl+Shift+F search across the workspace with grouped results",
    caption: "Find in Files (Cmd/Ctrl+Shift+F) — search across the workspace; jump to any match.",
  },
  {
    src: "/screenshots/desktop-shortcuts-help.png",
    alt: "Keyboard shortcuts modal listing every binding",
    caption: "Shortcuts Help (Cmd/Ctrl+/) — discover bindings without leaving the app.",
  },
  {
    src: "/screenshots/desktop-dark-theme.png",
    alt: "AsciiMark in dark theme showing a rendered Markdown document",
    caption: "Dark theme — switch via the menu or Command Palette.",
  },
];

export function GuidePage() {
  const [activeImage, setActiveImage] = createSignal<GuideImage | null>(null);
  const [activeSection, setActiveSection] = createSignal<string>("installation");

  function openImageModal(image: GuideImage) {
    setActiveImage(image);
  }

  function closeImageModal() {
    setActiveImage(null);
  }

  onMount(() => {
    const firstSectionId = sectionLinks[0].href.slice(1);
    const lastSectionId = sectionLinks[sectionLinks.length - 1].href.slice(1);

    const sectionElements = sectionLinks
      .map((item) => item.href.slice(1))
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);

    function syncFromHash() {
      const hash = window.location.hash.replace("#", "");
      if (hash) {
        setActiveSection(hash);
      }
    }

    function syncFromScrollExtremes() {
      const currentScrollBottom = window.scrollY + window.innerHeight;
      const pageBottom = document.documentElement.scrollHeight;
      const nearBottom = currentScrollBottom >= pageBottom - 4;
      const lastSectionElement = sectionElements[sectionElements.length - 1];

      if (window.scrollY <= 4) {
        setActiveSection(firstSectionId);
        return;
      }

      const reachedLastSection =
        !!lastSectionElement &&
        lastSectionElement.getBoundingClientRect().top <= window.innerHeight - 120;

      if (nearBottom && reachedLastSection) {
        setActiveSection(lastSectionId);
      }
    }

    syncFromHash();
    syncFromScrollExtremes();

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleEntries = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);

        if (visibleEntries.length > 0) {
          setActiveSection(visibleEntries[0].target.id);
        }
      },
      {
        root: null,
        rootMargin: "-28% 0px -58% 0px",
        threshold: [0, 0.25, 0.6, 1],
      },
    );

    sectionElements.forEach((element) => observer.observe(element));
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("scroll", syncFromScrollExtremes, { passive: true });

    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("scroll", syncFromScrollExtremes);
    });
  });

  return (
    <div class="guide-layout">
      <aside class="guide-sidebar-panel">
        <p class="guide-sidebar-title">Guide Sections</p>
        <nav aria-label="Guide sections" class="guide-sidebar-nav">
          <For each={sectionLinks}>
            {(item) => (
              <a
                class={
                  item.href.slice(1) === activeSection()
                    ? "guide-sidebar-link guide-sidebar-link-active"
                    : "guide-sidebar-link"
                }
                href={item.href}
              >
                {item.label}
              </a>
            )}
          </For>
        </nav>
      </aside>

      <div class="guide-content-stack">
        <section class="content-panel" id="top">
          <h1 class="content-title">User Guide</h1>
          <p>
            Everything you need to install, configure, and use AsciiMark across desktop and
            extension workflows.
          </p>
        </section>

        <section class="content-panel" id="installation">
          <h2>Installation</h2>
          <h3>Chrome Extension</h3>
          <p>
            The Chrome Extension is currently under review in the Chrome Web Store. Once approved,
            you will be able to install it and render <code>.adoc</code> and <code>.md</code> files
            in-browser with formatted preview.
          </p>
          <h3>Desktop App</h3>
          <p>Download the installer for your platform from the Home page downloads section.</p>
          <h3>macOS: first launch</h3>
          <p>Since the app is not notarized, macOS may block first launch. Run once:</p>
          <p>
            <code>xattr -cr /Applications/AsciiMark.app</code>
          </p>
          <h3>Windows: SmartScreen</h3>
          <p>
            If SmartScreen appears, click <strong>More info</strong> and then
            <strong> Run anyway</strong>.
          </p>
          <h3>Linux: AppImage</h3>
          <p>Make the downloaded AppImage executable before running:</p>
          <p>
            <code>chmod +x AsciiMark_*.AppImage</code>
          </p>
          <p>
            The <code>.deb</code> package can be installed with your distro package manager.
          </p>
        </section>

        <section class="content-panel" id="opening-files">
          <h2>Opening Files</h2>
          <h3>Open Folder</h3>
          <p>Select a local directory to browse all supported files in a tree sidebar.</p>
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() =>
                openImageModal({
                  alt: "Sidebar file tree after loading a folder",
                  caption: "Loaded folder tree in the left sidebar.",
                  src: "/screenshots/desktop-workspace-preview.png",
                })
              }
              type="button"
            >
              <img alt="Sidebar file tree after loading a folder" src="/screenshots/desktop-workspace-preview.png" />
            </button>
            <figcaption>Loaded folder tree in the left sidebar.</figcaption>
          </figure>
          <h3>Drag and Drop</h3>
          <p>Drop a folder to populate the tree, or drop a file to open it directly.</p>
          <h3>URL Mode</h3>
          <p>
            URLs ending with <code>.adoc</code> and <code>.md</code> can be rendered directly.
          </p>
          <h3>File URL Access (Extension)</h3>
          <ul>
            <li>
              Open <code>chrome://extensions</code>
            </li>
            <li>Find AsciiMark and open Details</li>
            <li>Enable Allow access to file URLs</li>
          </ul>
        </section>

        <section class="content-panel" id="tabs">
          <h2>Tabs — preview vs pinned</h2>
          <p>
            Single-click in the file tree opens the file in the <strong>preview slot</strong> — the
            tab title shows in italic. Click another file and the preview is replaced. Double-click,
            drag, or just start editing to <strong>pin</strong> the tab; pinned tabs stay until you
            close them.
          </p>
          <p>
            The invariant: at most one preview tab per pane. Middle-click and "Open in New Tab"
            always create a pinned tab.
          </p>
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() =>
                openImageModal({
                  alt: "Active workspace with one pinned tab and one preview tab in italic",
                  caption: "VSCode-style tabs — pinned title is upright, preview is italic.",
                  src: "/screenshots/desktop-preview-tabs.png",
                })
              }
              type="button"
            >
              <img alt="Active workspace with one pinned tab and one preview tab in italic" src="/screenshots/desktop-preview-tabs.png" />
            </button>
            <figcaption>VSCode-style tabs — pinned upright, preview italic.</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="navigation">
          <h2>Navigation</h2>
          <ul>
            <li>Use the file tree to jump between documents.</li>
            <li>Follow AsciiDoc xref links in rendered preview.</li>
            <li>Use browser/app back and forward history.</li>
            <li>Use breadcrumbs to understand current file location.</li>
          </ul>
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() =>
                openImageModal({
                  alt: "Markdown file opened from sidebar tree",
                  caption: "Example of opening a file directly from the tree.",
                  src: "/screenshots/desktop-workspace-preview.png",
                })
              }
              type="button"
            >
              <img alt="Markdown file opened from sidebar tree" src="/screenshots/desktop-workspace-preview.png" />
            </button>
            <figcaption>Example of opening a file directly from the tree.</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="toc">
          <h2>TOC and References</h2>
          <p>
            The right gutter is segmented into two tabs:
          </p>
          <ul>
            <li><strong>Summary</strong> — the rendered document's table of contents. Scroll position drives the active heading highlight.</li>
            <li><strong>References</strong> — every other workspace doc that links to the current file via Markdown link, AsciiDoc xref, or include. The count badge tells you upfront whether the active doc is referenced.</li>
          </ul>
          <p>
            Both tabs stay mounted regardless of which is visible — switching is instant.
          </p>
          <figure class="guide-media guide-media-compact">
            <button
              class="guide-media-button"
              onClick={() =>
                openImageModal({
                  alt: "Right gutter segmented into Summary and References tabs",
                  caption: "Summary tab shows the document TOC; the count on References indicates inbound links.",
                  src: "/screenshots/desktop-toc-segmented.png",
                })
              }
              type="button"
            >
              <img alt="Right gutter segmented into Summary and References tabs" src="/screenshots/desktop-toc-segmented.png" />
            </button>
            <figcaption>Summary tab shows the document TOC; the count on References indicates inbound links.</figcaption>
          </figure>
          <figure class="guide-media guide-media-compact">
            <button
              class="guide-media-button"
              onClick={() =>
                openImageModal({
                  alt: "References tab listing five workspace files that reference the active doc",
                  caption: "References — workspace backlinks for the active file.",
                  src: "/screenshots/desktop-backlinks-panel.png",
                })
              }
              type="button"
            >
              <img alt="References tab listing five workspace files that reference the active doc" src="/screenshots/desktop-backlinks-panel.png" />
            </button>
            <figcaption>References — workspace backlinks for the active file.</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="workspace-symbols">
          <h2>Workspace Symbol Search</h2>
          <p>
            <code>Cmd/Ctrl+Alt+O</code> opens a fuzzy-match palette over every heading in every doc
            of the workspace — not just the active file. Type the heading text or the file path to
            scope; pick a row and the file opens, scrolled to the right line, with the TOC active
            highlight already on the matching item.
          </p>
          <figure class="guide-media guide-media-compact">
            <button
              class="guide-media-button"
              onClick={() =>
                openImageModal({
                  alt: "Workspace symbol palette listing headings across every doc",
                  caption: "Cmd/Ctrl+Alt+O — workspace-wide heading search.",
                  src: "/screenshots/desktop-workspace-symbols.png",
                })
              }
              type="button"
            >
              <img alt="Workspace symbol palette listing headings across every doc" src="/screenshots/desktop-workspace-symbols.png" />
            </button>
            <figcaption>Cmd/Ctrl+Alt+O — workspace-wide heading search.</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="reader-mode">
          <h2>Reader / Zen mode</h2>
          <p>
            <code>Cmd/Ctrl+.</code> (or <em>View → Toggle Reader Mode</em> in the Command Palette)
            collapses the toolbar, sidebar, TOC, and status bar — leaving only the rendered preview
            centered at a comfortable reading width. Press the same shortcut to come back.
          </p>
          <p>
            <code>F11</code> is accepted as a fallback on platforms where it isn't already taken by
            the OS. macOS Mission Control swallows <code>F11</code> by default — use the period
            chord there.
          </p>
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() =>
                openImageModal({
                  alt: "Reader mode rendering only the centered preview without chrome",
                  caption: "Reader / Zen mode — focused preview without distractions.",
                  src: "/screenshots/desktop-reader-mode.png",
                })
              }
              type="button"
            >
              <img alt="Reader mode rendering only the centered preview without chrome" src="/screenshots/desktop-reader-mode.png" />
            </button>
            <figcaption>Reader / Zen mode — focused preview without distractions.</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="search">
          <h2>Search</h2>
          <h3>Search in file tree</h3>
          <p>Filter files by name as you type.</p>
          <h3>Search in preview</h3>
          <p>
            Press <code>Ctrl+F</code> to open in-document search and navigate highlighted results.
          </p>
        </section>

        <section class="content-panel" id="editor">
          <h2>Editor</h2>
          <h3>Split mode</h3>
          <p>Edit source and preview output side by side.</p>
          <h3>Save</h3>
          <ul>
            <li>
              Save with <code>Ctrl+S</code> (or <code>Cmd+S</code> on macOS).
            </li>
            <li>Changes are written back to local files when permissions are granted.</li>
          </ul>
        </section>

        <section class="content-panel" id="appearance">
          <h2>Appearance</h2>
          <ul>
            <li>Theme: Light, Dark, or System.</li>
            <li>Consistent code block styling.</li>
            <li>Font size and family customization.</li>
          </ul>
          <figure class="guide-media guide-media-compact">
            <button
              class="guide-media-button"
              onClick={() =>
                openImageModal({
                  alt: "Settings menu options",
                  caption: "Appearance and export controls in the settings menu.",
                  src: "/screenshots/desktop-dark-theme.png",
                })
              }
              type="button"
            >
              <img alt="Settings menu options" src="/screenshots/desktop-dark-theme.png" />
            </button>
            <figcaption>Appearance and export controls in the settings menu.</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="processing">
          <h2>Document Processing</h2>
          <h3>AsciiDoc</h3>
          <p>
            Uses Asciidoctor with support for admonitions, tables, source blocks, xrefs, and
            recursive includes.
          </p>
          <h3>Markdown</h3>
          <p>
            Uses markdown-it with plugins for task lists, footnotes, definition lists, emoji,
            alerts, advanced tables, and more.
          </p>
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() =>
                openImageModal({
                  alt: "Rendered markdown preview with sections",
                  caption: "Rendered output with markdown features.",
                  src: "/screenshots/desktop-workspace-preview.png",
                })
              }
              type="button"
            >
              <img alt="Rendered markdown preview with sections" src="/screenshots/desktop-workspace-preview.png" />
            </button>
            <figcaption>Rendered output with markdown features.</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="diagrams">
          <h2>Diagrams</h2>
          <ul>
            <li>Mermaid diagrams render directly in preview.</li>
            <li>Kroki is used for PlantUML, Ditaa, Graphviz and related formats.</li>
          </ul>
        </section>

        <section class="content-panel" id="export">
          <h2>Export</h2>
          <ul>
            <li>
              Print to PDF with <code>Ctrl+P</code>.
            </li>
            <li>Direct PDF generation is available in supported modes.</li>
          </ul>
        </section>

        <section class="content-panel" id="shortcuts">
          <h2>Keyboard Shortcuts</h2>
          <p>
            On macOS use <code>Cmd</code>; on Linux and Windows use <code>Ctrl</code>. Press
            {" "}
            <code>Cmd/Ctrl+/</code>
            {" "}
            anywhere in the app to open the live shortcuts reference.
          </p>
          <table class="guide-table">
            <thead>
              <tr>
                <th>Shortcut</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>Cmd/Ctrl+P</code></td>
                <td>Quick Open — fuzzy-find a file across all open workspaces</td>
              </tr>
              <tr>
                <td><code>Cmd/Ctrl+Shift+P</code></td>
                <td>Command Palette — every action in one place</td>
              </tr>
              <tr>
                <td><code>Cmd/Ctrl+Shift+O</code></td>
                <td>Go to Heading — jump anywhere in the current document</td>
              </tr>
              <tr>
                <td><code>Cmd/Ctrl+Alt+O</code></td>
                <td>Go to Symbol in Workspace — fuzzy-match headings across every doc</td>
              </tr>
              <tr>
                <td><code>Cmd/Ctrl+Shift+F</code></td>
                <td>Find in Files — search across the workspace</td>
              </tr>
              <tr>
                <td><code>Cmd/Ctrl+.</code></td>
                <td>Toggle Reader / Zen mode (chrome-less, centered preview)</td>
              </tr>
              <tr>
                <td><code>Cmd/Ctrl+/</code></td>
                <td>Open the keyboard-shortcuts modal</td>
              </tr>
              <tr>
                <td><code>Cmd/Ctrl+\</code></td>
                <td>Toggle the second pane (split / collapse)</td>
              </tr>
              <tr>
                <td><code>Cmd/Ctrl+1</code> / <code>Cmd/Ctrl+2</code></td>
                <td>Focus the first / second pane</td>
              </tr>
              <tr>
                <td><code>Cmd/Ctrl+T</code></td>
                <td>New tab in the active pane</td>
              </tr>
              <tr>
                <td><code>Cmd/Ctrl+W</code></td>
                <td>Close the active tab</td>
              </tr>
              <tr>
                <td><code>Cmd/Ctrl+Shift+T</code></td>
                <td>Reopen the last closed tab</td>
              </tr>
              <tr>
                <td><code>Ctrl+Tab</code> / <code>Ctrl+Shift+Tab</code></td>
                <td>Cycle tabs forward / backward</td>
              </tr>
              <tr>
                <td><code>Cmd/Ctrl+S</code></td>
                <td>Save the active document (when permissions allow)</td>
              </tr>
              <tr>
                <td><code>Cmd/Ctrl+F</code></td>
                <td>Find inside the current preview / editor</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="content-panel" id="screenshots">
          <h2>Screenshots</h2>
          <p>
            Captured from the desktop app. The Chrome extension shares the same UI in a smaller window.
          </p>
          <div class="screenshot-grid">
            <For each={guideScreenshots}>
              {(item) => (
                <figure class="screenshot-card">
                  <button
                    class="screenshot-button"
                    onClick={() =>
                      openImageModal({ alt: item.alt, caption: item.caption, src: item.src })
                    }
                    type="button"
                  >
                    <img alt={item.alt} class="screenshot-image" loading="lazy" src={item.src} />
                  </button>
                  <figcaption>{item.caption}</figcaption>
                </figure>
              )}
            </For>
          </div>
        </section>

        <Show when={activeImage()}>
          {(image) => (
            <div class="screenshot-modal-backdrop" onClick={closeImageModal} role="presentation">
              <div
                class="screenshot-modal"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Guide image preview"
              >
                <div class="screenshot-modal-header">
                  <p>{image().caption}</p>
                  <Button onClick={closeImageModal} size="sm" type="button" variant="outline">Close</Button>
                </div>
                <div class="screenshot-modal-image-wrap">
                  <img alt={image().alt} class="screenshot-modal-image" src={image().src} />
                </div>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
