import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Button } from "@asciimark/ui/components/ui/button.tsx";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";

interface GuideImage {
  alt: string;
  caption: string;
  src: string;
}

// Inline-HTML wrappers — same pattern as the Privacy page: i18n
// strings carry their own <code> / <strong> markup and we render
// them via innerHTML. Source is fully controlled.
function HtmlP(props: { html: string }) {
  return <p innerHTML={props.html} />;
}
function HtmlLi(props: { html: string }) {
  return <li innerHTML={props.html} />;
}

const sectionIds = [
  "installation",
  "opening-files",
  "media",
  "tabs",
  "navigation",
  "toc",
  "workspace-symbols",
  "reader-mode",
  "search",
  "editor",
  "appearance",
  "processing",
  "diagrams",
  "assistant",
  "providers",
  "mcp",
  "indexing",
  "export",
  "shortcuts",
  "screenshots",
] as const;

const sectionLabels: Record<(typeof sectionIds)[number], () => string> = {
  installation: m.guide_section_installation,
  "opening-files": m.guide_section_opening_files,
  media: m.guide_section_media,
  tabs: m.guide_section_tabs,
  navigation: m.guide_section_navigation,
  toc: m.guide_section_toc,
  "workspace-symbols": m.guide_section_workspace_symbols,
  "reader-mode": m.guide_section_reader_mode,
  search: m.guide_section_search,
  editor: m.guide_section_editor,
  appearance: m.guide_section_appearance,
  processing: m.guide_section_processing,
  diagrams: m.guide_section_diagrams,
  assistant: m.guide_section_assistant,
  providers: m.guide_section_providers,
  mcp: m.guide_section_mcp,
  indexing: m.guide_section_indexing,
  export: m.guide_section_export,
  shortcuts: m.guide_section_shortcuts,
  screenshots: m.guide_section_screenshots,
};

interface GuideScreenshot {
  alt: () => string;
  caption: () => string;
  src: string;
}

const guideScreenshots: GuideScreenshot[] = [
  { src: "/screenshots/desktop-welcome.png", alt: m.guide_opening_folder_alt, caption: m.guide_opening_folder_caption },
  { src: "/screenshots/desktop-workspace-preview.png", alt: m.guide_opening_folder_alt, caption: m.guide_opening_folder_caption },
  { src: "/screenshots/desktop-split-panes.png", alt: m.guide_tabs_alt, caption: m.guide_tabs_caption },
  { src: "/screenshots/desktop-preview-tabs.png", alt: m.guide_tabs_alt, caption: m.guide_tabs_caption },
  { src: "/screenshots/desktop-toc-segmented.png", alt: m.guide_toc_h2, caption: m.guide_toc_summary_caption },
  { src: "/screenshots/desktop-backlinks-panel.png", alt: m.guide_toc_h2, caption: m.guide_toc_references_caption },
  { src: "/screenshots/desktop-workspace-symbols.png", alt: m.guide_symbols_h2, caption: m.guide_symbols_caption },
  { src: "/screenshots/desktop-reader-mode.png", alt: m.guide_reader_h2, caption: m.guide_reader_caption },
  { src: "/screenshots/desktop-edit-preview.png", alt: m.guide_editor_h2, caption: m.guide_editor_split_p },
  { src: "/screenshots/desktop-respect-gitignore.png", alt: m.guide_opening_gitignore_alt, caption: m.guide_opening_gitignore_caption },
  { src: "/screenshots/desktop-close-behavior.png", alt: m.guide_appearance_close_behavior_alt, caption: m.guide_appearance_close_behavior_caption },
  { src: "/screenshots/desktop-quick-open.png", alt: m.guide_shortcut_quick_open, caption: m.guide_shortcut_quick_open },
  { src: "/screenshots/desktop-command-palette.png", alt: m.guide_shortcut_command_palette, caption: m.guide_shortcut_command_palette },
  { src: "/screenshots/desktop-symbol-palette.png", alt: m.guide_shortcut_go_heading, caption: m.guide_shortcut_go_heading },
  { src: "/screenshots/desktop-find-in-files.png", alt: m.guide_shortcut_find_in_files, caption: m.guide_shortcut_find_in_files },
  { src: "/screenshots/desktop-shortcuts-help.png", alt: m.guide_shortcut_modal, caption: m.guide_shortcut_modal },
  { src: "/screenshots/desktop-dark-theme.png", alt: m.guide_appearance_caption, caption: m.guide_appearance_caption },
  { src: "/screenshots/desktop-ai-panel.png", alt: m.guide_shot_ai_panel_caption, caption: m.guide_shot_ai_panel_caption },
  { src: "/screenshots/desktop-ai-model-picker.png", alt: m.guide_shot_ai_models_caption, caption: m.guide_shot_ai_models_caption },
  { src: "/screenshots/desktop-settings-ai.png", alt: m.guide_shot_settings_ai_caption, caption: m.guide_shot_settings_ai_caption },
  { src: "/screenshots/desktop-settings-mcp.png", alt: m.guide_shot_settings_mcp_caption, caption: m.guide_shot_settings_mcp_caption },
  { src: "/screenshots/desktop-settings-indexing.png", alt: m.guide_shot_settings_indexing_caption, caption: m.guide_shot_settings_indexing_caption },
  { src: "/screenshots/desktop-diagram-viewer.png", alt: m.guide_shot_diagram_viewer_caption, caption: m.guide_shot_diagram_viewer_caption },
  { src: "/screenshots/desktop-image-viewer.png", alt: m.guide_shot_image_viewer_caption, caption: m.guide_shot_image_viewer_caption },
  { src: "/screenshots/desktop-excalidraw.png", alt: m.guide_shot_excalidraw_caption, caption: m.guide_shot_excalidraw_caption },
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
    const firstSectionId = sectionIds[0];
    const lastSectionId = sectionIds[sectionIds.length - 1];

    const sectionElements = sectionIds
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);

    function syncFromHash() {
      const hash = window.location.hash.replace("#", "");
      if (hash) setActiveSection(hash);
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

      if (nearBottom && reachedLastSection) setActiveSection(lastSectionId);
    }

    syncFromHash();
    syncFromScrollExtremes();

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
        if (visible.length > 0) setActiveSection(visible[0].target.id);
      },
      { root: null, rootMargin: "-28% 0px -58% 0px", threshold: [0, 0.25, 0.6, 1] },
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

  function openImageWith(alt: () => string, caption: () => string, src: string) {
    openImageModal({ alt: alt(), caption: caption(), src });
  }

  return (
    <div class="guide-layout">
      <aside class="guide-sidebar-panel">
        <p class="guide-sidebar-title">{(useLocale(), m.guide_sidebar_title())}</p>
        <nav aria-label="Guide sections" class="guide-sidebar-nav">
          <For each={sectionIds}>
            {(id) => (
              <a
                class={
                  id === activeSection()
                    ? "guide-sidebar-link guide-sidebar-link-active"
                    : "guide-sidebar-link"
                }
                href={`#${id}`}
              >
                {(useLocale(), sectionLabels[id]())}
              </a>
            )}
          </For>
        </nav>
      </aside>

      <div class="guide-content-stack">
        <section class="content-panel" id="top">
          <h1 class="content-title">{(useLocale(), m.guide_title())}</h1>
          <p>{(useLocale(), m.guide_intro_p())}</p>
        </section>

        <section class="content-panel" id="installation">
          <h2>{(useLocale(), m.guide_installation_h2())}</h2>
          <h3>{(useLocale(), m.guide_installation_chrome_h3())}</h3>
          <HtmlP html={(useLocale(), m.guide_installation_chrome_p())} />
          <h3>{(useLocale(), m.guide_installation_desktop_h3())}</h3>
          <p>{(useLocale(), m.guide_installation_desktop_p())}</p>
          <h3>{(useLocale(), m.guide_installation_macos_h3())}</h3>
          <p>{(useLocale(), m.guide_installation_macos_p())}</p>
          <p><code>xattr -cr /Applications/AsciiMark.app</code></p>
          <h3>{(useLocale(), m.guide_installation_windows_h3())}</h3>
          <HtmlP html={(useLocale(), m.guide_installation_windows_p())} />
          <h3>{(useLocale(), m.guide_installation_linux_h3())}</h3>
          <p>{(useLocale(), m.guide_installation_linux_p())}</p>
          <p><code>chmod +x AsciiMark_*.AppImage</code></p>
          <HtmlP html={(useLocale(), m.guide_installation_linux_deb())} />
        </section>

        <section class="content-panel" id="opening-files">
          <h2>{(useLocale(), m.guide_opening_h2())}</h2>
          <h3>{(useLocale(), m.guide_opening_folder_h3())}</h3>
          <p>{(useLocale(), m.guide_opening_folder_p())}</p>
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() =>
                openImageWith(m.guide_opening_folder_alt, m.guide_opening_folder_caption, "/screenshots/desktop-workspace-preview.png")
              }
              type="button"
            >
              <img alt={(useLocale(), m.guide_opening_folder_alt())} src="/screenshots/desktop-workspace-preview.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_opening_folder_caption())}</figcaption>
          </figure>
          <h3>{(useLocale(), m.guide_opening_dnd_h3())}</h3>
          <p>{(useLocale(), m.guide_opening_dnd_p())}</p>
          <h3>{(useLocale(), m.guide_opening_gitignore_h3())}</h3>
          <HtmlP html={(useLocale(), m.guide_opening_gitignore_p())} />
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() =>
                openImageWith(
                  m.guide_opening_gitignore_alt,
                  m.guide_opening_gitignore_caption,
                  "/screenshots/desktop-respect-gitignore.png",
                )
              }
              type="button"
            >
              <img
                alt={(useLocale(), m.guide_opening_gitignore_alt())}
                src="/screenshots/desktop-respect-gitignore.png"
              />
            </button>
            <figcaption>{(useLocale(), m.guide_opening_gitignore_caption())}</figcaption>
          </figure>
          <h3>{(useLocale(), m.guide_opening_url_h3())}</h3>
          <HtmlP html={(useLocale(), m.guide_opening_url_p())} />
          <h3>{(useLocale(), m.guide_opening_file_url_h3())}</h3>
          <ul>
            <HtmlLi html={(useLocale(), m.guide_opening_file_url_item1())} />
            <HtmlLi html={(useLocale(), m.guide_opening_file_url_item2())} />
            <HtmlLi html={(useLocale(), m.guide_opening_file_url_item3())} />
          </ul>
        </section>

        <section class="content-panel" id="media">
          <h2>{(useLocale(), m.guide_media_h2())}</h2>
          <p>{(useLocale(), m.guide_media_intro_p())}</p>
          <h3>{(useLocale(), m.guide_media_images_h3())}</h3>
          <HtmlP html={(useLocale(), m.guide_media_images_p())} />
          <h3>{(useLocale(), m.guide_media_pdf_h3())}</h3>
          <p>{(useLocale(), m.guide_media_pdf_p())}</p>
          <h3>{(useLocale(), m.guide_media_modes_h3())}</h3>
          <p>{(useLocale(), m.guide_media_modes_p())}</p>
          <ul>
            <HtmlLi html={(useLocale(), m.guide_media_modes_item_doc())} />
            <HtmlLi html={(useLocale(), m.guide_media_modes_item_media())} />
            <HtmlLi html={(useLocale(), m.guide_media_modes_item_text())} />
            <HtmlLi html={(useLocale(), m.guide_media_modes_item_unsupported())} />
          </ul>
          <h3>{(useLocale(), m.guide_media_zoom_h3())}</h3>
          <p>{(useLocale(), m.guide_media_zoom_p())}</p>
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() => openImageWith(m.guide_media_zoom_caption, m.guide_media_zoom_caption, "/screenshots/desktop-image-viewer.png")}
              type="button"
            >
              <img alt={(useLocale(), m.guide_media_zoom_caption())} src="/screenshots/desktop-image-viewer.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_media_zoom_caption())}</figcaption>
          </figure>
          <h3>{(useLocale(), m.guide_media_inline_h3())}</h3>
          <p>{(useLocale(), m.guide_media_inline_p())}</p>
        </section>

        <section class="content-panel" id="tabs">
          <h2>{(useLocale(), m.guide_tabs_h2())}</h2>
          <HtmlP html={(useLocale(), m.guide_tabs_p1())} />
          <HtmlP html={(useLocale(), m.guide_tabs_p2())} />
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() => openImageWith(m.guide_tabs_alt, m.guide_tabs_caption, "/screenshots/desktop-preview-tabs.png")}
              type="button"
            >
              <img alt={(useLocale(), m.guide_tabs_alt())} src="/screenshots/desktop-preview-tabs.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_tabs_caption())}</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="navigation">
          <h2>{(useLocale(), m.guide_navigation_h2())}</h2>
          <ul>
            <li>{(useLocale(), m.guide_navigation_item1())}</li>
            <li>{(useLocale(), m.guide_navigation_item2())}</li>
            <li>{(useLocale(), m.guide_navigation_item3())}</li>
            <li>{(useLocale(), m.guide_navigation_item4())}</li>
          </ul>
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() => openImageWith(m.guide_navigation_alt, m.guide_navigation_caption, "/screenshots/desktop-workspace-preview.png")}
              type="button"
            >
              <img alt={(useLocale(), m.guide_navigation_alt())} src="/screenshots/desktop-workspace-preview.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_navigation_caption())}</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="toc">
          <h2>{(useLocale(), m.guide_toc_h2())}</h2>
          <p>{(useLocale(), m.guide_toc_intro())}</p>
          <ul>
            <HtmlLi html={(useLocale(), m.guide_toc_item_summary())} />
            <HtmlLi html={(useLocale(), m.guide_toc_item_references())} />
          </ul>
          <p>{(useLocale(), m.guide_toc_outro())}</p>
          <figure class="guide-media guide-media-compact">
            <button
              class="guide-media-button"
              onClick={() => openImageWith(m.guide_toc_h2, m.guide_toc_summary_caption, "/screenshots/desktop-toc-segmented.png")}
              type="button"
            >
              <img alt={(useLocale(), m.guide_toc_h2())} src="/screenshots/desktop-toc-segmented.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_toc_summary_caption())}</figcaption>
          </figure>
          <figure class="guide-media guide-media-compact">
            <button
              class="guide-media-button"
              onClick={() => openImageWith(m.guide_toc_h2, m.guide_toc_references_caption, "/screenshots/desktop-backlinks-panel.png")}
              type="button"
            >
              <img alt={(useLocale(), m.guide_toc_h2())} src="/screenshots/desktop-backlinks-panel.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_toc_references_caption())}</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="workspace-symbols">
          <h2>{(useLocale(), m.guide_symbols_h2())}</h2>
          <HtmlP html={(useLocale(), m.guide_symbols_p())} />
          <figure class="guide-media guide-media-compact">
            <button
              class="guide-media-button"
              onClick={() => openImageWith(m.guide_symbols_h2, m.guide_symbols_caption, "/screenshots/desktop-workspace-symbols.png")}
              type="button"
            >
              <img alt={(useLocale(), m.guide_symbols_h2())} src="/screenshots/desktop-workspace-symbols.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_symbols_caption())}</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="reader-mode">
          <h2>{(useLocale(), m.guide_reader_h2())}</h2>
          <HtmlP html={(useLocale(), m.guide_reader_p1())} />
          <HtmlP html={(useLocale(), m.guide_reader_p2())} />
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() => openImageWith(m.guide_reader_h2, m.guide_reader_caption, "/screenshots/desktop-reader-mode.png")}
              type="button"
            >
              <img alt={(useLocale(), m.guide_reader_h2())} src="/screenshots/desktop-reader-mode.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_reader_caption())}</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="search">
          <h2>{(useLocale(), m.guide_search_h2())}</h2>
          <h3>{(useLocale(), m.guide_search_tree_h3())}</h3>
          <p>{(useLocale(), m.guide_search_tree_p())}</p>
          <h3>{(useLocale(), m.guide_search_preview_h3())}</h3>
          <HtmlP html={(useLocale(), m.guide_search_preview_p())} />
        </section>

        <section class="content-panel" id="editor">
          <h2>{(useLocale(), m.guide_editor_h2())}</h2>
          <h3>{(useLocale(), m.guide_editor_split_h3())}</h3>
          <p>{(useLocale(), m.guide_editor_split_p())}</p>
          <h3>{(useLocale(), m.guide_editor_save_h3())}</h3>
          <ul>
            <HtmlLi html={(useLocale(), m.guide_editor_save_item1())} />
            <li>{(useLocale(), m.guide_editor_save_item2())}</li>
          </ul>
        </section>

        <section class="content-panel" id="appearance">
          <h2>{(useLocale(), m.guide_appearance_h2())}</h2>
          <ul>
            <li>{(useLocale(), m.guide_appearance_item1())}</li>
            <li>{(useLocale(), m.guide_appearance_item2())}</li>
            <li>{(useLocale(), m.guide_appearance_item3())}</li>
          </ul>
          <figure class="guide-media guide-media-compact">
            <button
              class="guide-media-button"
              onClick={() => openImageWith(m.guide_appearance_caption, m.guide_appearance_caption, "/screenshots/desktop-dark-theme.png")}
              type="button"
            >
              <img alt={(useLocale(), m.guide_appearance_caption())} src="/screenshots/desktop-dark-theme.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_appearance_caption())}</figcaption>
          </figure>
          <h3>{(useLocale(), m.guide_appearance_close_behavior_h3())}</h3>
          <HtmlP html={(useLocale(), m.guide_appearance_close_behavior_p())} />
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() =>
                openImageWith(
                  m.guide_appearance_close_behavior_alt,
                  m.guide_appearance_close_behavior_caption,
                  "/screenshots/desktop-close-behavior.png",
                )
              }
              type="button"
            >
              <img
                alt={(useLocale(), m.guide_appearance_close_behavior_alt())}
                src="/screenshots/desktop-close-behavior.png"
              />
            </button>
            <figcaption>{(useLocale(), m.guide_appearance_close_behavior_caption())}</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="processing">
          <h2>{(useLocale(), m.guide_processing_h2())}</h2>
          <h3>{(useLocale(), m.guide_processing_asciidoc_h3())}</h3>
          <p>{(useLocale(), m.guide_processing_asciidoc_p())}</p>
          <h3>{(useLocale(), m.guide_processing_md_h3())}</h3>
          <p>{(useLocale(), m.guide_processing_md_p())}</p>
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() => openImageWith(m.guide_processing_caption, m.guide_processing_caption, "/screenshots/desktop-workspace-preview.png")}
              type="button"
            >
              <img alt={(useLocale(), m.guide_processing_caption())} src="/screenshots/desktop-workspace-preview.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_processing_caption())}</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="diagrams">
          <h2>{(useLocale(), m.guide_diagrams_h2())}</h2>
          <p>{(useLocale(), m.guide_diagrams_intro_p())}</p>
          <h3>{(useLocale(), m.guide_diagrams_render_h3())}</h3>
          <ul>
            <li>{(useLocale(), m.guide_diagrams_item1())}</li>
            <li>{(useLocale(), m.guide_diagrams_item2())}</li>
          </ul>
          <h3>{(useLocale(), m.guide_diagrams_viewer_h3())}</h3>
          <p>{(useLocale(), m.guide_diagrams_viewer_p())}</p>
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() => openImageWith(m.guide_diagrams_viewer_caption, m.guide_diagrams_viewer_caption, "/screenshots/desktop-diagram-viewer.png")}
              type="button"
            >
              <img alt={(useLocale(), m.guide_diagrams_viewer_caption())} src="/screenshots/desktop-diagram-viewer.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_diagrams_viewer_caption())}</figcaption>
          </figure>
          <h3>{(useLocale(), m.guide_diagrams_excalidraw_h3())}</h3>
          <HtmlP html={(useLocale(), m.guide_diagrams_excalidraw_p())} />
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() => openImageWith(m.guide_diagrams_excalidraw_caption, m.guide_diagrams_excalidraw_caption, "/screenshots/desktop-excalidraw.png")}
              type="button"
            >
              <img alt={(useLocale(), m.guide_diagrams_excalidraw_caption())} src="/screenshots/desktop-excalidraw.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_diagrams_excalidraw_caption())}</figcaption>
          </figure>
          <h3>{(useLocale(), m.guide_diagrams_ai_h3())}</h3>
          <p>{(useLocale(), m.guide_diagrams_ai_p())}</p>
        </section>

        <section class="content-panel" id="assistant">
          <h2>{(useLocale(), m.guide_assistant_h2())}</h2>
          <HtmlP html={(useLocale(), m.guide_assistant_intro_p())} />
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() => openImageWith(m.guide_assistant_caption, m.guide_assistant_caption, "/screenshots/desktop-ai-panel.png")}
              type="button"
            >
              <img alt={(useLocale(), m.guide_assistant_caption())} src="/screenshots/desktop-ai-panel.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_assistant_caption())}</figcaption>
          </figure>
          <h3>{(useLocale(), m.guide_assistant_modes_h3())}</h3>
          <HtmlP html={(useLocale(), m.guide_assistant_modes_p())} />
          <h3>{(useLocale(), m.guide_assistant_context_h3())}</h3>
          <HtmlP html={(useLocale(), m.guide_assistant_context_p())} />
          <h3>{(useLocale(), m.guide_assistant_slash_h3())}</h3>
          <HtmlP html={(useLocale(), m.guide_assistant_slash_p())} />
          <h3>{(useLocale(), m.guide_assistant_sessions_h3())}</h3>
          <p>{(useLocale(), m.guide_assistant_sessions_p())}</p>
          <figure class="guide-media guide-media-compact">
            <button
              class="guide-media-button"
              onClick={() => openImageWith(m.guide_assistant_models_caption, m.guide_assistant_models_caption, "/screenshots/desktop-ai-model-picker.png")}
              type="button"
            >
              <img alt={(useLocale(), m.guide_assistant_models_caption())} src="/screenshots/desktop-ai-model-picker.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_assistant_models_caption())}</figcaption>
          </figure>
          <h3>{(useLocale(), m.guide_assistant_tools_h3())}</h3>
          <p>{(useLocale(), m.guide_assistant_tools_p())}</p>
          <ul>
            <HtmlLi html={(useLocale(), m.guide_assistant_tools_item1())} />
            <HtmlLi html={(useLocale(), m.guide_assistant_tools_item2())} />
            <HtmlLi html={(useLocale(), m.guide_assistant_tools_item3())} />
            <HtmlLi html={(useLocale(), m.guide_assistant_tools_item4())} />
          </ul>
        </section>

        <section class="content-panel" id="providers">
          <h2>{(useLocale(), m.guide_providers_h2())}</h2>
          <HtmlP html={(useLocale(), m.guide_providers_intro_p())} />
          <h3>{(useLocale(), m.guide_providers_keys_h3())}</h3>
          <p>{(useLocale(), m.guide_providers_keys_p())}</p>
          <h3>{(useLocale(), m.guide_providers_subscription_h3())}</h3>
          <p>{(useLocale(), m.guide_providers_subscription_p())}</p>
          <h3>{(useLocale(), m.guide_providers_custom_h3())}</h3>
          <p>{(useLocale(), m.guide_providers_custom_p())}</p>
          <h3>{(useLocale(), m.guide_providers_models_h3())}</h3>
          <p>{(useLocale(), m.guide_providers_models_p())}</p>
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() => openImageWith(m.guide_providers_caption, m.guide_providers_caption, "/screenshots/desktop-settings-ai.png")}
              type="button"
            >
              <img alt={(useLocale(), m.guide_providers_caption())} src="/screenshots/desktop-settings-ai.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_providers_caption())}</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="mcp">
          <h2>{(useLocale(), m.guide_mcp_h2())}</h2>
          <HtmlP html={(useLocale(), m.guide_mcp_intro_p())} />
          <h3>{(useLocale(), m.guide_mcp_add_h3())}</h3>
          <p>{(useLocale(), m.guide_mcp_add_p())}</p>
          <h3>{(useLocale(), m.guide_mcp_discovered_h3())}</h3>
          <p>{(useLocale(), m.guide_mcp_discovered_p())}</p>
          <h3>{(useLocale(), m.guide_mcp_auth_h3())}</h3>
          <HtmlP html={(useLocale(), m.guide_mcp_auth_p())} />
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() => openImageWith(m.guide_mcp_caption, m.guide_mcp_caption, "/screenshots/desktop-settings-mcp.png")}
              type="button"
            >
              <img alt={(useLocale(), m.guide_mcp_caption())} src="/screenshots/desktop-settings-mcp.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_mcp_caption())}</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="indexing">
          <h2>{(useLocale(), m.guide_indexing_h2())}</h2>
          <HtmlP html={(useLocale(), m.guide_indexing_intro_p())} />
          <ul>
            <li><strong>{(useLocale(), m.guide_indexing_off_h3())}</strong> — {(useLocale(), m.guide_indexing_off_p())}</li>
            <li><strong>{(useLocale(), m.guide_indexing_fast_h3())}</strong> — {(useLocale(), m.guide_indexing_fast_p())}</li>
            <li><strong>{(useLocale(), m.guide_indexing_full_h3())}</strong> — {(useLocale(), m.guide_indexing_full_p())}</li>
          </ul>
          <figure class="guide-media">
            <button
              class="guide-media-button"
              onClick={() => openImageWith(m.guide_indexing_caption, m.guide_indexing_caption, "/screenshots/desktop-settings-indexing.png")}
              type="button"
            >
              <img alt={(useLocale(), m.guide_indexing_caption())} src="/screenshots/desktop-settings-indexing.png" />
            </button>
            <figcaption>{(useLocale(), m.guide_indexing_caption())}</figcaption>
          </figure>
        </section>

        <section class="content-panel" id="export">
          <h2>{(useLocale(), m.guide_export_h2())}</h2>
          <ul>
            <HtmlLi html={(useLocale(), m.guide_export_item1())} />
            <li>{(useLocale(), m.guide_export_item2())}</li>
          </ul>
        </section>

        <section class="content-panel" id="shortcuts">
          <h2>{(useLocale(), m.guide_shortcuts_h2())}</h2>
          <HtmlP html={(useLocale(), m.guide_shortcuts_intro())} />
          <table class="guide-table">
            <thead>
              <tr>
                <th>{(useLocale(), m.guide_shortcuts_col_shortcut())}</th>
                <th>{(useLocale(), m.guide_shortcuts_col_action())}</th>
              </tr>
            </thead>
            <tbody>
              <tr><td><code>Cmd/Ctrl+P</code></td><td>{(useLocale(), m.guide_shortcut_quick_open())}</td></tr>
              <tr><td><code>Cmd/Ctrl+Shift+P</code></td><td>{(useLocale(), m.guide_shortcut_command_palette())}</td></tr>
              <tr><td><code>Cmd/Ctrl+Shift+O</code></td><td>{(useLocale(), m.guide_shortcut_go_heading())}</td></tr>
              <tr><td><code>Cmd/Ctrl+Alt+O</code></td><td>{(useLocale(), m.guide_shortcut_workspace_symbols())}</td></tr>
              <tr><td><code>Cmd/Ctrl+Shift+F</code></td><td>{(useLocale(), m.guide_shortcut_find_in_files())}</td></tr>
              <tr><td><code>Cmd/Ctrl+.</code></td><td>{(useLocale(), m.guide_shortcut_reader_mode())}</td></tr>
              <tr><td><code>Cmd/Ctrl+/</code></td><td>{(useLocale(), m.guide_shortcut_modal())}</td></tr>
              <tr><td><code>Cmd/Ctrl+\</code></td><td>{(useLocale(), m.guide_shortcut_split_pane())}</td></tr>
              <tr><td><code>Cmd/Ctrl+1</code> / <code>Cmd/Ctrl+2</code></td><td>{(useLocale(), m.guide_shortcut_focus_pane())}</td></tr>
              <tr><td><code>Cmd/Ctrl+T</code></td><td>{(useLocale(), m.guide_shortcut_new_tab())}</td></tr>
              <tr><td><code>Cmd/Ctrl+W</code></td><td>{(useLocale(), m.guide_shortcut_close_tab())}</td></tr>
              <tr><td><code>Cmd/Ctrl+Shift+T</code></td><td>{(useLocale(), m.guide_shortcut_reopen_tab())}</td></tr>
              <tr><td><code>Ctrl+Tab</code> / <code>Ctrl+Shift+Tab</code></td><td>{(useLocale(), m.guide_shortcut_cycle_tab())}</td></tr>
              <tr><td><code>Cmd/Ctrl+S</code></td><td>{(useLocale(), m.guide_shortcut_save())}</td></tr>
              <tr><td><code>Cmd/Ctrl+F</code></td><td>{(useLocale(), m.guide_shortcut_find())}</td></tr>
            </tbody>
          </table>
        </section>

        <section class="content-panel" id="screenshots">
          <h2>{(useLocale(), m.guide_screenshots_h2())}</h2>
          <p>{(useLocale(), m.guide_screenshots_intro())}</p>
          <div class="screenshot-grid">
            <For each={guideScreenshots}>
              {(item) => (
                <figure class="screenshot-card">
                  <button
                    class="screenshot-button"
                    onClick={() => openImageWith(item.alt, item.caption, item.src)}
                    type="button"
                  >
                    <img
                      alt={(useLocale(), item.alt())}
                      class="screenshot-image"
                      loading="lazy"
                      src={item.src}
                    />
                  </button>
                  <figcaption>{(useLocale(), item.caption())}</figcaption>
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
                aria-label={(useLocale(), m.guide_modal_label())}
              >
                <div class="screenshot-modal-header">
                  <p>{image().caption}</p>
                  <Button onClick={closeImageModal} size="sm" type="button" variant="outline">
                    {(useLocale(), m.guide_modal_close())}
                  </Button>
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
