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
  { href: "#navigation", label: "Navigation" },
  { href: "#toc", label: "Table of Contents" },
  { href: "#search", label: "Search" },
  { href: "#editor", label: "Editor" },
  { href: "#appearance", label: "Appearance" },
  { href: "#processing", label: "Document Processing" },
  { href: "#diagrams", label: "Diagrams" },
  { href: "#export", label: "Export" },
  { href: "#shortcuts", label: "Keyboard Shortcuts" },
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
            Install AsciiMark from the Chrome Web Store. After installation, <code>.adoc</code>
            and <code>.md</code> files can be rendered in-browser with formatted preview.
          </p>
          <h3>Desktop App (Tauri)</h3>
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
                  src: "/screenshots/guide-crop-sidebar-tree.png",
                })
              }
              type="button"
            >
              <img alt="Sidebar file tree after loading a folder" src="/screenshots/guide-crop-sidebar-tree.png" />
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
                  src: "/screenshots/extension-file-readme.png",
                })
              }
              type="button"
            >
              <img alt="Markdown file opened from sidebar tree" src="/screenshots/extension-file-readme.png" />
            </button>
            <figcaption>Example of opening a file directly from the tree.</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="toc">
          <h2>Table of Contents</h2>
          <p>
            The TOC panel is generated from heading hierarchy and helps quick section jumps in long
            documents.
          </p>
          <figure class="guide-media guide-media-compact">
            <button
              class="guide-media-button"
              onClick={() =>
                openImageModal({
                  alt: "Table of contents panel",
                  caption: "TOC panel with clickable document sections.",
                  src: "/screenshots/guide-crop-toc-panel.png",
                })
              }
              type="button"
            >
              <img alt="Table of contents panel" src="/screenshots/guide-crop-toc-panel.png" />
            </button>
            <figcaption>TOC panel with clickable document sections.</figcaption>
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
            <li>Code theme options for syntax highlighting.</li>
            <li>Font size and family customization.</li>
          </ul>
          <figure class="guide-media guide-media-compact">
            <button
              class="guide-media-button"
              onClick={() =>
                openImageModal({
                  alt: "Settings menu options",
                  caption: "Appearance and export controls in the settings menu.",
                  src: "/screenshots/guide-crop-settings-menu.png",
                })
              }
              type="button"
            >
              <img alt="Settings menu options" src="/screenshots/guide-crop-settings-menu.png" />
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
                  caption: "Rendered output with markdown features and highlighted content.",
                  src: "/screenshots/extension-preview-markdown.png",
                })
              }
              type="button"
            >
              <img alt="Rendered markdown preview with sections" src="/screenshots/extension-preview-markdown.png" />
            </button>
            <figcaption>Rendered output with markdown features and highlighted content.</figcaption>
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
          <table class="guide-table">
            <thead>
              <tr>
                <th>Shortcut</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>Ctrl+F</code>
                </td>
                <td>Search inside preview</td>
              </tr>
            </tbody>
          </table>
          <p>
            Today, this is the only dedicated shortcut implemented globally. The other actions are
            available through toolbar and menu controls.
          </p>
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
