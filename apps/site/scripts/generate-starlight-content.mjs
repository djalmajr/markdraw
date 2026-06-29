import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "../..");
const messagesRoot = path.join(repoRoot, "packages/i18n/messages");
const docsRoot = path.join(appRoot, "src/content/docs");

const RELEASES_BASE_URL = "https://github.com/djalmajr/markdraw/releases/latest/download";
const RELEASES_LATEST_URL = "https://github.com/djalmajr/markdraw/releases/latest";

const locales = [
  { code: "en", route: "", dir: "", label: "English" },
  { code: "pt-BR", route: "pt-br", dir: "pt-br", label: "Português" },
  { code: "es", route: "es", dir: "es", label: "Español" },
];

const featureItems = [
  ["site_feature_formats_title", "site_feature_formats_description"],
  ["site_feature_panes_title", "site_feature_panes_description"],
  ["site_feature_keyboard_title", "site_feature_keyboard_description"],
  ["site_feature_backlinks_title", "site_feature_backlinks_description"],
  ["site_feature_symbols_title", "site_feature_symbols_description"],
  ["site_feature_reader_title", "site_feature_reader_description"],
  ["site_feature_diagrams_title", "site_feature_diagrams_description"],
  ["site_feature_ai_title", "site_feature_ai_description"],
  ["site_feature_multiroot_title", "site_feature_multiroot_description"],
  ["site_feature_localfirst_title", "site_feature_localfirst_description"],
];

const downloadItems = [
  ["site_platform_mac_arm64", "site_download_helper_dmg", "Markdraw-macos-arm64.dmg"],
  ["site_platform_mac_x64", "site_download_helper_dmg", "Markdraw-macos-x64.dmg"],
  ["site_platform_linux", "site_download_helper_appimage", "Markdraw-linux-x64.AppImage"],
  ["site_platform_linux_deb", "site_download_helper_deb", "Markdraw-linux-x64.deb"],
  ["site_platform_windows", "site_download_helper_msi", "Markdraw-windows-x64.msi"],
  ["site_platform_windows_alt", "site_download_helper_exe", "Markdraw-windows-x64.exe"],
];

const screenshots = [
  ["/screenshots/desktop-welcome.png", "guide_opening_folder_alt", "guide_opening_folder_caption"],
  ["/screenshots/desktop-workspace-preview.png", "guide_opening_folder_alt", "guide_opening_folder_caption"],
  ["/screenshots/desktop-split-panes.png", "guide_tabs_alt", "guide_tabs_caption"],
  ["/screenshots/desktop-preview-tabs.png", "guide_tabs_alt", "guide_tabs_caption"],
  ["/screenshots/desktop-toc-segmented.png", "guide_toc_h2", "guide_toc_summary_caption"],
  ["/screenshots/desktop-backlinks-panel.png", "guide_toc_h2", "guide_toc_references_caption"],
  ["/screenshots/desktop-workspace-symbols.png", "guide_symbols_h2", "guide_symbols_caption"],
  ["/screenshots/desktop-reader-mode.png", "guide_reader_h2", "guide_reader_caption"],
  ["/screenshots/desktop-edit-preview.png", "guide_editor_h2", "guide_editor_split_p"],
  ["/screenshots/desktop-respect-gitignore.png", "guide_opening_gitignore_alt", "guide_opening_gitignore_caption"],
  ["/screenshots/desktop-close-behavior.png", "guide_appearance_close_behavior_alt", "guide_appearance_close_behavior_caption"],
  ["/screenshots/desktop-quick-open.png", "guide_shortcut_quick_open", "guide_shortcut_quick_open"],
  ["/screenshots/desktop-command-palette.png", "guide_shortcut_command_palette", "guide_shortcut_command_palette"],
  ["/screenshots/desktop-symbol-palette.png", "guide_shortcut_go_heading", "guide_shortcut_go_heading"],
  ["/screenshots/desktop-find-in-files.png", "guide_shortcut_find_in_files", "guide_shortcut_find_in_files"],
  ["/screenshots/desktop-shortcuts-help.png", "guide_shortcut_modal", "guide_shortcut_modal"],
  ["/screenshots/desktop-dark-theme.png", "guide_appearance_caption", "guide_appearance_caption"],
  ["/screenshots/desktop-ai-panel.png", "guide_shot_ai_panel_caption", "guide_shot_ai_panel_caption"],
  ["/screenshots/desktop-ai-model-picker.png", "guide_shot_ai_models_caption", "guide_shot_ai_models_caption"],
  ["/screenshots/desktop-settings-ai.png", "guide_shot_settings_ai_caption", "guide_shot_settings_ai_caption"],
  ["/screenshots/desktop-settings-mcp.png", "guide_shot_settings_mcp_caption", "guide_shot_settings_mcp_caption"],
  ["/screenshots/desktop-settings-indexing.png", "guide_shot_settings_indexing_caption", "guide_shot_settings_indexing_caption"],
  ["/screenshots/desktop-diagram-viewer.png", "guide_shot_diagram_viewer_caption", "guide_shot_diagram_viewer_caption"],
  ["/screenshots/desktop-image-viewer.png", "guide_shot_image_viewer_caption", "guide_shot_image_viewer_caption"],
  ["/screenshots/desktop-excalidraw.png", "guide_shot_excalidraw_caption", "guide_shot_excalidraw_caption"],
];

const guideSections = [
  {
    slug: "installation",
    titleKey: "guide_installation_h2",
    blocks: [
      h3("guide_installation_chrome_h3"),
      p("guide_installation_chrome_p"),
      h3("guide_installation_desktop_h3"),
      p("guide_installation_desktop_p"),
      h3("guide_installation_macos_h3"),
      p("guide_installation_macos_p"),
      h3("guide_installation_windows_h3"),
      p("guide_installation_windows_p"),
      h3("guide_installation_linux_h3"),
      p("guide_installation_linux_p"),
      code("chmod +x Markdraw_*.AppImage"),
      p("guide_installation_linux_deb"),
    ],
  },
  {
    slug: "opening-files",
    titleKey: "guide_opening_h2",
    blocks: [
      h3("guide_opening_folder_h3"),
      p("guide_opening_folder_p"),
      image("/screenshots/desktop-workspace-preview.png", "guide_opening_folder_alt", "guide_opening_folder_caption"),
      h3("guide_opening_dnd_h3"),
      p("guide_opening_dnd_p"),
      h3("guide_opening_gitignore_h3"),
      p("guide_opening_gitignore_p"),
      image("/screenshots/desktop-respect-gitignore.png", "guide_opening_gitignore_alt", "guide_opening_gitignore_caption"),
      h3("guide_opening_url_h3"),
      p("guide_opening_url_p"),
      h3("guide_opening_file_url_h3"),
      list(["guide_opening_file_url_item1", "guide_opening_file_url_item2", "guide_opening_file_url_item3"]),
    ],
  },
  {
    slug: "media",
    titleKey: "guide_media_h2",
    blocks: [
      p("guide_media_intro_p"),
      h3("guide_media_images_h3"),
      p("guide_media_images_p"),
      h3("guide_media_pdf_h3"),
      p("guide_media_pdf_p"),
      h3("guide_media_modes_h3"),
      p("guide_media_modes_p"),
      list([
        "guide_media_modes_item_doc",
        "guide_media_modes_item_media",
        "guide_media_modes_item_text",
        "guide_media_modes_item_unsupported",
      ]),
      h3("guide_media_zoom_h3"),
      p("guide_media_zoom_p"),
      image("/screenshots/desktop-image-viewer.png", "guide_media_zoom_caption", "guide_media_zoom_caption"),
      h3("guide_media_inline_h3"),
      p("guide_media_inline_p"),
    ],
  },
  {
    slug: "tabs",
    titleKey: "guide_tabs_h2",
    blocks: [
      p("guide_tabs_p1"),
      p("guide_tabs_p2"),
      image("/screenshots/desktop-preview-tabs.png", "guide_tabs_alt", "guide_tabs_caption"),
    ],
  },
  {
    slug: "navigation",
    titleKey: "guide_navigation_h2",
    blocks: [
      list([
        "guide_navigation_item1",
        "guide_navigation_item2",
        "guide_navigation_item3",
        "guide_navigation_item4",
      ]),
      image("/screenshots/desktop-workspace-preview.png", "guide_navigation_alt", "guide_navigation_caption"),
    ],
  },
  {
    slug: "toc",
    titleKey: "guide_toc_h2",
    blocks: [
      p("guide_toc_intro"),
      list(["guide_toc_item_summary", "guide_toc_item_references"]),
      p("guide_toc_outro"),
      image("/screenshots/desktop-toc-segmented.png", "guide_toc_h2", "guide_toc_summary_caption"),
      image("/screenshots/desktop-backlinks-panel.png", "guide_toc_h2", "guide_toc_references_caption"),
    ],
  },
  {
    slug: "workspace-symbols",
    titleKey: "guide_symbols_h2",
    blocks: [
      p("guide_symbols_p"),
      image("/screenshots/desktop-workspace-symbols.png", "guide_symbols_h2", "guide_symbols_caption"),
    ],
  },
  {
    slug: "reader-mode",
    titleKey: "guide_reader_h2",
    blocks: [
      p("guide_reader_p1"),
      p("guide_reader_p2"),
      image("/screenshots/desktop-reader-mode.png", "guide_reader_h2", "guide_reader_caption"),
    ],
  },
  {
    slug: "search",
    titleKey: "guide_search_h2",
    blocks: [
      h3("guide_search_tree_h3"),
      p("guide_search_tree_p"),
      h3("guide_search_preview_h3"),
      p("guide_search_preview_p"),
    ],
  },
  {
    slug: "editor",
    titleKey: "guide_editor_h2",
    blocks: [
      h3("guide_editor_split_h3"),
      p("guide_editor_split_p"),
      h3("guide_editor_save_h3"),
      list(["guide_editor_save_item1", "guide_editor_save_item2"]),
    ],
  },
  {
    slug: "appearance",
    titleKey: "guide_appearance_h2",
    blocks: [
      list(["guide_appearance_item1", "guide_appearance_item2", "guide_appearance_item3"]),
      image("/screenshots/desktop-dark-theme.png", "guide_appearance_caption", "guide_appearance_caption"),
      h3("guide_appearance_close_behavior_h3"),
      p("guide_appearance_close_behavior_p"),
      image("/screenshots/desktop-close-behavior.png", "guide_appearance_close_behavior_alt", "guide_appearance_close_behavior_caption"),
    ],
  },
  {
    slug: "processing",
    titleKey: "guide_processing_h2",
    blocks: [
      h3("guide_processing_asciidoc_h3"),
      p("guide_processing_asciidoc_p"),
      h3("guide_processing_md_h3"),
      p("guide_processing_md_p"),
      image("/screenshots/desktop-workspace-preview.png", "guide_processing_caption", "guide_processing_caption"),
    ],
  },
  {
    slug: "diagrams",
    titleKey: "guide_diagrams_h2",
    blocks: [
      p("guide_diagrams_intro_p"),
      h3("guide_diagrams_render_h3"),
      list(["guide_diagrams_item1", "guide_diagrams_item2"]),
      h3("guide_diagrams_viewer_h3"),
      p("guide_diagrams_viewer_p"),
      image("/screenshots/desktop-diagram-viewer.png", "guide_diagrams_viewer_caption", "guide_diagrams_viewer_caption"),
      h3("guide_diagrams_excalidraw_h3"),
      p("guide_diagrams_excalidraw_p"),
      image("/screenshots/desktop-excalidraw.png", "guide_diagrams_excalidraw_caption", "guide_diagrams_excalidraw_caption"),
      h3("guide_diagrams_ai_h3"),
      p("guide_diagrams_ai_p"),
    ],
  },
  {
    slug: "assistant",
    titleKey: "guide_assistant_h2",
    blocks: [
      p("guide_assistant_intro_p"),
      image("/screenshots/desktop-ai-panel.png", "guide_assistant_caption", "guide_assistant_caption"),
      h3("guide_assistant_modes_h3"),
      p("guide_assistant_modes_p"),
      h3("guide_assistant_context_h3"),
      p("guide_assistant_context_p"),
      h3("guide_assistant_slash_h3"),
      p("guide_assistant_slash_p"),
      h3("guide_assistant_sessions_h3"),
      p("guide_assistant_sessions_p"),
      image("/screenshots/desktop-ai-model-picker.png", "guide_assistant_models_caption", "guide_assistant_models_caption"),
      h3("guide_assistant_tools_h3"),
      p("guide_assistant_tools_p"),
      list([
        "guide_assistant_tools_item1",
        "guide_assistant_tools_item2",
        "guide_assistant_tools_item3",
        "guide_assistant_tools_item4",
      ]),
    ],
  },
  {
    slug: "providers",
    titleKey: "guide_providers_h2",
    blocks: [
      p("guide_providers_intro_p"),
      h3("guide_providers_keys_h3"),
      p("guide_providers_keys_p"),
      h3("guide_providers_subscription_h3"),
      p("guide_providers_subscription_p"),
      h3("guide_providers_custom_h3"),
      p("guide_providers_custom_p"),
      h3("guide_providers_models_h3"),
      p("guide_providers_models_p"),
      image("/screenshots/desktop-settings-ai.png", "guide_providers_caption", "guide_providers_caption"),
    ],
  },
  {
    slug: "mcp",
    titleKey: "guide_mcp_h2",
    blocks: [
      p("guide_mcp_intro_p"),
      h3("guide_mcp_add_h3"),
      p("guide_mcp_add_p"),
      h3("guide_mcp_discovered_h3"),
      p("guide_mcp_discovered_p"),
      h3("guide_mcp_auth_h3"),
      p("guide_mcp_auth_p"),
      image("/screenshots/desktop-settings-mcp.png", "guide_mcp_caption", "guide_mcp_caption"),
    ],
  },
  {
    slug: "indexing",
    titleKey: "guide_indexing_h2",
    blocks: [
      p("guide_indexing_intro_p"),
      custom((t) => [
        "- " + strong(t("guide_indexing_off_h3")) + " — " + mdx(t("guide_indexing_off_p")),
        "- " + strong(t("guide_indexing_fast_h3")) + " — " + mdx(t("guide_indexing_fast_p")),
        "- " + strong(t("guide_indexing_full_h3")) + " — " + mdx(t("guide_indexing_full_p")),
      ].join("\n") + "\n"),
      image("/screenshots/desktop-settings-indexing.png", "guide_indexing_caption", "guide_indexing_caption"),
    ],
  },
  {
    slug: "export",
    titleKey: "guide_export_h2",
    blocks: [list(["guide_export_item1", "guide_export_item2"])],
  },
  {
    slug: "shortcuts",
    titleKey: "guide_shortcuts_h2",
    blocks: [
      p("guide_shortcuts_intro"),
      custom((t) => renderShortcutTable(t)),
    ],
  },
  {
    slug: "screenshots",
    titleKey: "guide_screenshots_h2",
    blocks: [
      p("guide_screenshots_intro"),
      custom((t) => renderScreenshotGrid(t)),
    ],
  },
];

function h3(key) {
  return (t) => `## ${mdx(t(key))}\n`;
}

function p(key) {
  return (t) => `${mdx(t(key))}\n`;
}

function code(value) {
  return () => `\`${value}\`\n`;
}

function list(keys) {
  return (t) => `${keys.map((key) => `- ${mdx(t(key))}`).join("\n")}\n`;
}

function image(src, altKey, captionKey) {
  return (t) => `<figure className="markdraw-figure">
  <a href="${src}">
    <img alt="${attr(t(altKey))}" src="${src}" />
  </a>
  <figcaption>${mdx(t(captionKey))}</figcaption>
</figure>
`;
}

function custom(render) {
  return render;
}

function strong(value) {
  return `<strong>${mdx(value)}</strong>`;
}

function mdx(value) {
  return String(value).replaceAll("{", "&#123;").replaceAll("}", "&#125;");
}

function attr(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function htmlText(value) {
  return attr(value).replaceAll("\\", "&#92;");
}

function stripHtml(value) {
  return String(value).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function yamlString(value) {
  return JSON.stringify(stripHtml(value));
}

function yamlBlock(value, indent = 4) {
  const padding = " ".repeat(indent);
  return String(value)
    .split("\n")
    .map((line) => `${padding}${line}`)
    .join("\n");
}

function frontmatter(title, description = title, options = {}) {
  const lines = ["---", `title: ${yamlString(title)}`, `description: ${yamlString(description)}`];

  if (options.template) {
    lines.push(`template: ${options.template}`);
  }

  if (options.sidebarHidden) {
    lines.push("sidebar:", "  hidden: true");
  }

  if (options.standalone) {
    lines.push(
      "head:",
      "  - tag: script",
      `    content: ${yamlString('document.documentElement.dataset.markdrawStandalone = "true";')}`,
    );
  }

  return `${lines.join("\n")}\n---\n\n`;
}

function localizedUrl(locale, url) {
  return locale.route === "" ? url : `/${locale.route}${url}`;
}

function releaseUrl(asset) {
  return `${RELEASES_BASE_URL}/${asset}`;
}

function createTranslator(messages) {
  return (key, inputs = {}) => {
    if (!(key in messages)) {
      throw new Error(`Missing i18n key: ${key}`);
    }
    let value = String(messages[key]);
    for (const [inputKey, inputValue] of Object.entries(inputs)) {
      value = value.replaceAll(`{${inputKey}}`, String(inputValue));
    }
    return value;
  };
}

async function readMessages(locale) {
  const content = await fs.readFile(path.join(messagesRoot, `${locale}.json`), "utf8");
  return JSON.parse(content);
}

async function writeDoc(locale, relativePath, content) {
  const localeRoot = locale.dir ? path.join(docsRoot, locale.dir) : docsRoot;
  const filePath = path.join(localeRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

function renderHome(t, locale) {
  const guideUrl = localizedUrl(locale, "/guide/");
  const privacyUrl = localizedUrl(locale, "/privacy/");
  const heroTagline = `<span class="markdraw-hero-kicker">${attr(t("site_hero_kicker"))}</span>
<span class="markdraw-hero-line">${attr(t("site_hero_title"))}</span>
<span class="markdraw-hero-description">${attr(t("site_hero_description"))}</span>`;
  const heroImage = `<figure class="markdraw-hero-shot">
  <img alt="${attr(t("site_hero_alt"))}" src="/screenshots/desktop-workspace-preview.png" />
  <figcaption>${attr(t("site_hero_caption"))}</figcaption>
</figure>`;

  return [
    `---
title: "Markdraw"
description: ${yamlString(t("site_hero_description"))}
template: splash
hero:
  tagline: |
${yamlBlock(heroTagline)}
  image:
    html: |
${yamlBlock(heroImage, 6)}
  actions:
    - text: ${yamlString(t("site_hero_cta_download", { platform: t("site_platform_fallback") }))}
      link: ${yamlString(RELEASES_LATEST_URL)}
      icon: right-arrow
      variant: primary
      attrs:
        rel: noreferrer
        target: _blank
        data-preferred-download: true
        data-label-template: ${yamlString(t("site_hero_cta_download", { platform: "{platform}" }))}
        data-platform-fallback: ${yamlString(t("site_platform_fallback"))}
        data-platform-mac-arm64: ${yamlString(t("site_platform_mac_arm64"))}
        data-platform-mac-x64: ${yamlString(t("site_platform_mac_x64"))}
        data-platform-linux: ${yamlString(t("site_platform_linux"))}
        data-platform-windows: ${yamlString(t("site_platform_windows"))}
    - text: ${yamlString(t("site_hero_cta_guide"))}
      link: ${yamlString(guideUrl)}
      variant: secondary
---
`,
    `import { Card, CardGrid, LinkCard } from "@astrojs/starlight/components";`,
    `<script type="module" src="/scripts/preferred-download.js"></script>`,
    `## ${mdx(t("site_features_title"))}`,
    renderFeatureGrid(t, guideUrl, locale),
    `## ${mdx(t("site_downloads_title"))}`,
    `${mdx(t("site_downloads_subtitle"))}\n`,
    renderDownloadGrid(t),
    `<div className="markdraw-callout">
  <div>
    <h2>${mdx(t("site_chrome_ext_title"))}</h2>
    <p>${mdx(t("site_chrome_ext_description"))}</p>
  </div>
  <a className="markdraw-button markdraw-button-primary" href="https://chromewebstore.google.com/detail/asciimark/dmcihjkjbeckainfkaddpkeghlllmkbk" rel="noreferrer" target="_blank">${mdx(t("site_chrome_ext_cta"))}</a>
</div>`,
    `<div className="markdraw-home-links">
  <LinkCard title="${attr(t("site_nav_privacy"))}" description="${attr(t("privacy_data_collection_p"))}" href="${privacyUrl}" />
</div>`,
    `<div className="markdraw-notice">
  <p>${mdx(t("site_notice_windows"))}</p>
</div>`,
  ].join("\n\n");
}

function renderFeatureGrid(t, guideUrl) {
  const cards = featureItems.map(([titleKey, descriptionKey]) => `<Card title="${attr(t(titleKey))}">
  ${mdx(t(descriptionKey))}
</Card>`);
  cards.push(`<LinkCard
  title="${attr(t("site_features_more_title"))}"
  description="${attr(t("site_features_more_description"))}"
  href="${guideUrl}"
/>`);
  return `<CardGrid stagger>
${cards.join("\n")}
</CardGrid>`;
}

function renderDownloadGrid(t) {
  const cards = downloadItems.map(([platformKey, helperKey, asset]) => `<LinkCard
  title="${attr(t(platformKey))}"
  description="${attr(`${t(helperKey)} - ${asset}`)}"
  href="${releaseUrl(asset)}"
  rel="noreferrer"
  target="_blank"
/>`);
  return `<CardGrid>
${cards.join("\n")}
</CardGrid>`;
}

function renderGuideIndex(t, locale) {
  const links = guideSections.map(
    (section) => `- [${mdx(t(section.titleKey))}](${localizedUrl(locale, `/guide/${section.slug}/`)})`,
  );
  return [
    frontmatter(t("guide_title"), t("guide_intro_p")),
    `${mdx(t("guide_intro_p"))}\n`,
    `## ${mdx(t("guide_sidebar_title"))}`,
    links.join("\n"),
    image("/screenshots/desktop-workspace-preview.png", "guide_opening_folder_alt", "guide_opening_folder_caption")(t),
  ].join("\n\n");
}

function renderGuideSection(t, section) {
  return [
    frontmatter(t(section.titleKey), t("guide_intro_p")),
    section.blocks.map((block) => block(t)).join("\n"),
  ].join("");
}

function renderShortcutTable(t) {
  const rows = [
    ["Cmd/Ctrl+P", "guide_shortcut_quick_open"],
    ["Cmd/Ctrl+Shift+P", "guide_shortcut_command_palette"],
    ["Cmd/Ctrl+Shift+O", "guide_shortcut_go_heading"],
    ["Cmd/Ctrl+Alt+O", "guide_shortcut_workspace_symbols"],
    ["Cmd/Ctrl+Shift+F", "guide_shortcut_find_in_files"],
    ["Cmd/Ctrl+.", "guide_shortcut_reader_mode"],
    ["Cmd/Ctrl+/", "guide_shortcut_modal"],
    ["Cmd/Ctrl+\\", "guide_shortcut_split_pane"],
    ["Cmd/Ctrl+1 / Cmd/Ctrl+2", "guide_shortcut_focus_pane"],
    ["Cmd/Ctrl+T", "guide_shortcut_new_tab"],
    ["Cmd/Ctrl+W", "guide_shortcut_close_tab"],
    ["Cmd/Ctrl+Shift+T", "guide_shortcut_reopen_tab"],
    ["Ctrl+Tab / Ctrl+Shift+Tab", "guide_shortcut_cycle_tab"],
    ["Cmd/Ctrl+S", "guide_shortcut_save"],
    ["Cmd/Ctrl+F", "guide_shortcut_find"],
  ];
  return `<table className="markdraw-table">
  <thead>
    <tr><th>${mdx(t("guide_shortcuts_col_shortcut"))}</th><th>${mdx(t("guide_shortcuts_col_action"))}</th></tr>
  </thead>
  <tbody>
${rows.map(([shortcut, labelKey]) => `    <tr><td><code>${htmlText(shortcut)}</code></td><td>${mdx(t(labelKey))}</td></tr>`).join("\n")}
  </tbody>
</table>
`;
}

function renderScreenshotGrid(t) {
  const cards = screenshots.map(([src, altKey, captionKey]) => `<figure className="markdraw-screenshot-card">
  <a href="${src}">
    <img alt="${attr(t(altKey))}" loading="lazy" src="${src}" />
  </a>
  <figcaption>${mdx(t(captionKey))}</figcaption>
</figure>`);
  return `<div className="markdraw-screenshot-grid">
${cards.join("\n")}
</div>
`;
}

function renderPrivacy(t) {
  return [
    frontmatter(t("privacy_title"), t("privacy_data_collection_p"), {
      sidebarHidden: true,
      standalone: true,
    }),
    `**${mdx(t("privacy_last_updated"))}** ${mdx(t("privacy_last_updated_date"))}`,
    `## ${mdx(t("privacy_section_data_collection"))}`,
    p("privacy_data_collection_p")(t),
    `## ${mdx(t("privacy_section_scope"))}`,
    p("privacy_scope_p")(t),
    `## ${mdx(t("privacy_section_local_processing"))}`,
    p("privacy_local_processing_p")(t),
    `## ${mdx(t("privacy_section_local_storage"))}`,
    p("privacy_local_storage_p")(t),
    list([
      "privacy_local_storage_item_theme",
      "privacy_local_storage_item_editor",
      "privacy_local_storage_item_preview_font",
      "privacy_local_storage_item_recent",
      "privacy_local_storage_item_tabs",
      "privacy_local_storage_item_layout",
      "privacy_local_storage_item_dir_handles",
      "privacy_local_storage_item_url_payload",
    ])(t),
    `## ${mdx(t("privacy_section_permissions"))}`,
    list(["privacy_permission_storage", "privacy_permission_kroki", "privacy_permission_file_url"])(t),
    `## ${mdx(t("privacy_section_network"))}`,
    list(["privacy_network_document_urls", "privacy_network_kroki", "privacy_network_updater"])(t),
    `## ${mdx(t("privacy_section_sharing"))}`,
    p("privacy_sharing_p")(t),
    `## ${mdx(t("privacy_section_libraries"))}`,
    p("privacy_libraries_p")(t),
    list([
      "privacy_library_asciidoctor",
      "privacy_library_markdownit",
      "privacy_library_prism",
      "privacy_library_mermaid",
      "privacy_library_katex",
      "privacy_library_codemirror",
      "privacy_library_solid",
      "privacy_library_tauri",
    ])(t),
    `## ${mdx(t("privacy_section_services"))}`,
    list(["privacy_service_kroki", "privacy_service_github"])(t),
    `## ${mdx(t("privacy_section_changes"))}`,
    p("privacy_changes_p")(t),
    `## ${mdx(t("privacy_section_contact"))}`,
    p("privacy_contact_p")(t),
  ].join("\n\n");
}

async function main() {
  await fs.rm(docsRoot, { recursive: true, force: true });

  for (const locale of locales) {
    const t = createTranslator(await readMessages(locale.code));

    await writeDoc(locale, "index.mdx", renderHome(t, locale));
    await writeDoc(locale, "guide/index.mdx", renderGuideIndex(t, locale));
    await writeDoc(locale, "privacy.mdx", renderPrivacy(t));

    for (const section of guideSections) {
      await writeDoc(locale, `guide/${section.slug}.mdx`, renderGuideSection(t, section));
    }
  }

  console.log(`Generated Starlight content for ${locales.length} locales in ${path.relative(repoRoot, docsRoot)}`);
}

await main();
