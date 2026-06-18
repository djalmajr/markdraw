import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";

// The Privacy page mixes prose with inline <code> / <strong> / <a>
// tags. The catalog ships those tags as part of the translated
// string and we render them via innerHTML; the source is fully
// controlled (no user input ever lands in these keys), so the
// usual XSS concern doesn't apply here. This keeps the visual
// formatting intact while letting the entire copy live in the
// translatable catalog.
function HtmlP(props: { html: string }) {
  return <p innerHTML={props.html} />;
}
function HtmlLi(props: { html: string }) {
  return <li innerHTML={props.html} />;
}

export function PrivacyPage() {
  return (
    <div class="page-stack">
      <section class="content-panel privacy-panel">
        <h1 class="content-title">{(useLocale(), m.privacy_title())}</h1>
        <p>
          <strong>{(useLocale(), m.privacy_last_updated())}</strong>{" "}
          {(useLocale(), m.privacy_last_updated_date())}
        </p>

        <h2>{(useLocale(), m.privacy_section_data_collection())}</h2>
        <HtmlP html={(useLocale(), m.privacy_data_collection_p())} />

        <h2>{(useLocale(), m.privacy_section_scope())}</h2>
        <HtmlP html={(useLocale(), m.privacy_scope_p())} />

        <h2>{(useLocale(), m.privacy_section_local_processing())}</h2>
        <HtmlP html={(useLocale(), m.privacy_local_processing_p())} />

        <h2>{(useLocale(), m.privacy_section_local_storage())}</h2>
        <HtmlP html={(useLocale(), m.privacy_local_storage_p())} />
        <ul>
          <HtmlLi html={(useLocale(), m.privacy_local_storage_item_theme())} />
          <HtmlLi html={(useLocale(), m.privacy_local_storage_item_editor())} />
          <HtmlLi html={(useLocale(), m.privacy_local_storage_item_preview_font())} />
          <HtmlLi html={(useLocale(), m.privacy_local_storage_item_recent())} />
          <HtmlLi html={(useLocale(), m.privacy_local_storage_item_tabs())} />
          <HtmlLi html={(useLocale(), m.privacy_local_storage_item_layout())} />
          <HtmlLi html={(useLocale(), m.privacy_local_storage_item_dir_handles())} />
          <HtmlLi html={(useLocale(), m.privacy_local_storage_item_url_payload())} />
        </ul>

        <h2>{(useLocale(), m.privacy_section_permissions())}</h2>
        <ul>
          <HtmlLi html={(useLocale(), m.privacy_permission_storage())} />
          <HtmlLi html={(useLocale(), m.privacy_permission_kroki())} />
          <HtmlLi html={(useLocale(), m.privacy_permission_file_url())} />
        </ul>

        <h2>{(useLocale(), m.privacy_section_network())}</h2>
        <ul>
          <HtmlLi html={(useLocale(), m.privacy_network_document_urls())} />
          <HtmlLi html={(useLocale(), m.privacy_network_kroki())} />
          <HtmlLi html={(useLocale(), m.privacy_network_updater())} />
        </ul>

        <h2>{(useLocale(), m.privacy_section_sharing())}</h2>
        <HtmlP html={(useLocale(), m.privacy_sharing_p())} />

        <h2>{(useLocale(), m.privacy_section_libraries())}</h2>
        <p>{(useLocale(), m.privacy_libraries_p())}</p>
        <ul>
          <li>{(useLocale(), m.privacy_library_asciidoctor())}</li>
          <li>{(useLocale(), m.privacy_library_markdownit())}</li>
          <li>{(useLocale(), m.privacy_library_prism())}</li>
          <li>{(useLocale(), m.privacy_library_mermaid())}</li>
          <li>{(useLocale(), m.privacy_library_katex())}</li>
          <li>{(useLocale(), m.privacy_library_codemirror())}</li>
          <li>{(useLocale(), m.privacy_library_solid())}</li>
          <li>{(useLocale(), m.privacy_library_tauri())}</li>
        </ul>

        <h2>{(useLocale(), m.privacy_section_services())}</h2>
        <ul>
          <HtmlLi html={(useLocale(), m.privacy_service_kroki())} />
          <HtmlLi html={(useLocale(), m.privacy_service_github())} />
        </ul>

        <h2>{(useLocale(), m.privacy_section_changes())}</h2>
        <HtmlP html={(useLocale(), m.privacy_changes_p())} />

        <h2>{(useLocale(), m.privacy_section_contact())}</h2>
        <HtmlP html={(useLocale(), m.privacy_contact_p())} />
      </section>
    </div>
  );
}
