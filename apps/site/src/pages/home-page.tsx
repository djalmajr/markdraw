import { For, Show, createSignal, onMount } from "solid-js";
import { Button } from "@asciimark/ui/components/ui/button.tsx";
import { Link } from "@tanstack/solid-router";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";

// Features and downloads carry locale-resolving thunks instead of
// dynamic key lookups so Vite + Rollup can tree-shake the i18n
// catalog. A `messages[key]()` indexing pattern would force Rollup
// to keep every message reachable through the `_index.js` module —
// adding ~13 KB gzip to the site bundle. Static references like
// `m.site_feature_formats_title` stay safe.
type StringFn = () => string;

interface FeatureItem {
  description: StringFn;
  title: StringFn;
}

interface DownloadItem {
  asset: string;
  helper: StringFn;
  platform: StringFn;
}

interface ScreenshotItem {
  alt: StringFn;
  caption: StringFn;
  path: string;
}

const RELEASES_BASE_URL =
  "https://github.com/djalmajr/asciimark/releases/latest/download";
const RELEASES_LATEST_URL =
  "https://github.com/djalmajr/asciimark/releases/latest";

interface PreferredDownload {
  href: string;
  /** Locale-resolving thunk for the platform label. Resolved at
   *  render time so the active locale wins even after detection. */
  platform: StringFn;
}

const featureItems: FeatureItem[] = [
  { title: m.site_feature_formats_title, description: m.site_feature_formats_description },
  { title: m.site_feature_panes_title, description: m.site_feature_panes_description },
  { title: m.site_feature_keyboard_title, description: m.site_feature_keyboard_description },
  { title: m.site_feature_backlinks_title, description: m.site_feature_backlinks_description },
  { title: m.site_feature_symbols_title, description: m.site_feature_symbols_description },
  { title: m.site_feature_reader_title, description: m.site_feature_reader_description },
  { title: m.site_feature_diagrams_title, description: m.site_feature_diagrams_description },
  { title: m.site_feature_ai_title, description: m.site_feature_ai_description },
  { title: m.site_feature_multiroot_title, description: m.site_feature_multiroot_description },
  { title: m.site_feature_localfirst_title, description: m.site_feature_localfirst_description },
];

const downloadItems: DownloadItem[] = [
  {
    platform: m.site_platform_mac_arm64,
    helper: m.site_download_helper_dmg,
    asset: "AsciiMark-macos-arm64.dmg",
  },
  {
    platform: m.site_platform_mac_x64,
    helper: m.site_download_helper_dmg,
    asset: "AsciiMark-macos-x64.dmg",
  },
  {
    platform: m.site_platform_linux,
    helper: m.site_download_helper_appimage,
    asset: "AsciiMark-linux-x64.AppImage",
  },
  {
    platform: m.site_platform_linux_deb,
    helper: m.site_download_helper_deb,
    asset: "AsciiMark-linux-x64.deb",
  },
  {
    platform: m.site_platform_windows,
    helper: m.site_download_helper_msi,
    asset: "AsciiMark-windows-x64.msi",
  },
  {
    platform: m.site_platform_windows_alt,
    helper: m.site_download_helper_exe,
    asset: "AsciiMark-windows-x64.exe",
  },
];

const heroPreviewItem: ScreenshotItem = {
  path: "/screenshots/desktop-workspace-preview.png",
  alt: m.site_hero_alt,
  caption: m.site_hero_caption,
};

function releaseUrl(asset: string) {
  return `${RELEASES_BASE_URL}/${asset}`;
}

function detectPreferredDownload(): PreferredDownload {
  if (typeof navigator === "undefined") {
    return { href: RELEASES_LATEST_URL, platform: m.site_platform_fallback };
  }

  const userAgent = navigator.userAgent.toLowerCase();
  const maybeUserAgentData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform =
    maybeUserAgentData.userAgentData?.platform?.toLowerCase() ??
    navigator.platform.toLowerCase();

  if (platform.includes("mac")) {
    const hasSiliconHint =
      platform.includes("arm") ||
      userAgent.includes("arm64") ||
      userAgent.includes("aarch64") ||
      userAgent.includes("apple silicon");
    const hasIntelHint = userAgent.includes("intel") || userAgent.includes("x86_64");
    const isAppleSilicon = hasSiliconHint || !hasIntelHint;
    return {
      href: releaseUrl(isAppleSilicon ? "Markdraw-macos-arm64.dmg" : "Markdraw-macos-x64.dmg"),
      platform: isAppleSilicon ? m.site_platform_mac_arm64 : m.site_platform_mac_x64,
    };
  }

  if (platform.includes("win")) {
    return {
      href: releaseUrl("Markdraw-windows-x64.msi"),
      platform: m.site_platform_windows,
    };
  }

  if (platform.includes("linux")) {
    return {
      href: releaseUrl("Markdraw-linux-x64.AppImage"),
      platform: m.site_platform_linux,
    };
  }

  return { href: RELEASES_LATEST_URL, platform: m.site_platform_fallback };
}

async function refineMacDownloadWithUserAgentData(
  fallback: PreferredDownload,
): Promise<PreferredDownload> {
  if (typeof navigator === "undefined") {
    return fallback;
  }

  const maybeUserAgentData = navigator as Navigator & {
    userAgentData?: {
      getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
      platform?: string;
    };
  };
  const platform =
    maybeUserAgentData.userAgentData?.platform?.toLowerCase() ??
    navigator.platform.toLowerCase();

  if (!platform.includes("mac")) {
    return fallback;
  }

  try {
    const values = await maybeUserAgentData.userAgentData?.getHighEntropyValues?.([
      "architecture",
    ]);
    const architecture = values?.architecture?.toLowerCase();

    if (architecture?.includes("arm")) {
      return {
        href: releaseUrl("Markdraw-macos-arm64.dmg"),
        platform: m.site_platform_mac_arm64,
      };
    }

    if (architecture?.includes("x86")) {
      return {
        href: releaseUrl("Markdraw-macos-x64.dmg"),
        platform: m.site_platform_mac_x64,
      };
    }
  } catch {
    return fallback;
  }

  return fallback;
}

export function HomePage() {
  const [activeScreenshot, setActiveScreenshot] = createSignal<ScreenshotItem | null>(null);
  const [preferredDownload, setPreferredDownload] = createSignal<PreferredDownload>(
    detectPreferredDownload(),
  );

  onMount(() => {
    void refineMacDownloadWithUserAgentData(preferredDownload()).then((refined) => {
      setPreferredDownload(refined);
    });
  });

  function closeScreenshotModal() {
    setActiveScreenshot(null);
  }

  function openScreenshotModal(item: ScreenshotItem) {
    setActiveScreenshot(item);
  }

  return (
    <div class="page-stack">
      <section class="hero-panel">
        <div class="hero-layout">
          <div>
            <p class="hero-kicker">{(useLocale(), m.site_hero_kicker())}</p>
            <h1 class="hero-title">{(useLocale(), m.site_hero_title())}</h1>
            <p class="hero-description">
              {(useLocale(), m.site_hero_description())}
            </p>
            <div class="hero-actions">
              <Button as="a" href={preferredDownload().href} rel="noreferrer" target="_blank">
                {(useLocale(),
                  m.site_hero_cta_download({ platform: preferredDownload().platform() }))}
              </Button>
              <Button as={Link} to="/guide" variant="secondary">
                {(useLocale(), m.site_hero_cta_guide())}
              </Button>
            </div>
          </div>
          <figure class="hero-shot">
            <button
              class="hero-shot-button"
              onClick={() => openScreenshotModal(heroPreviewItem)}
              type="button"
            >
              <img alt={(useLocale(), heroPreviewItem.alt())} src={heroPreviewItem.path} />
            </button>
            <figcaption>{(useLocale(), heroPreviewItem.caption())}</figcaption>
          </figure>
        </div>
      </section>

      <section class="grid-panel">
        <h2 class="section-title">{(useLocale(), m.site_features_title())}</h2>
        <div class="feature-grid">
          <For each={featureItems}>
            {(item) => (
              <article class="feature-card">
                <h3>{(useLocale(), item.title())}</h3>
                <p>{(useLocale(), item.description())}</p>
              </article>
            )}
          </For>
          <Link class="feature-card feature-card-more" to="/guide">
            <h3>{(useLocale(), m.site_features_more_title())}</h3>
            <p>{(useLocale(), m.site_features_more_description())}</p>
          </Link>
        </div>
      </section>

      <section class="grid-panel" id="download">
        <h2 class="section-title">{(useLocale(), m.site_downloads_title())}</h2>
        <p class="section-subtitle">
          {(useLocale(), m.site_downloads_subtitle())}
        </p>
        <div class="download-grid">
          <For each={downloadItems}>
            {(item) => (
              <article class="download-card">
                <p class="download-platform">{(useLocale(), item.platform())}</p>
                <p class="download-helper">{(useLocale(), item.helper())}</p>
                <Button
                  as="a"
                  class="download-button"
                  href={releaseUrl(item.asset)}
                  rel="noreferrer"
                  target="_blank"
                  variant="outline"
                >
                  {item.asset}
                </Button>
              </article>
            )}
          </For>
        </div>
      </section>

      <Show when={activeScreenshot()}>
        {(item) => (
          <div class="screenshot-modal-backdrop" onClick={closeScreenshotModal} role="presentation">
            <div
              class="screenshot-modal"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label={(useLocale(), m.site_screenshot_dialog_label())}
            >
              <div class="screenshot-modal-header">
                <p>{(useLocale(), item().caption())}</p>
                <button
                  aria-label={(useLocale(), m.site_screenshot_close_label())}
                  class="screenshot-modal-close"
                  onClick={closeScreenshotModal}
                  type="button"
                >
                  ×
                </button>
              </div>
              <div class="screenshot-modal-image-wrap">
                <img
                  alt={(useLocale(), item().alt())}
                  class="screenshot-modal-image"
                  src={item().path}
                />
              </div>
            </div>
          </div>
        )}
      </Show>

      <section class="chrome-ext-panel">
        <div>
          <h2 class="section-title">{(useLocale(), m.site_chrome_ext_title())}</h2>
          <p class="section-subtitle">
            {(useLocale(), m.site_chrome_ext_description())}
          </p>
        </div>
        <Button
          as="a"
          href="https://chromewebstore.google.com/detail/asciimark/dmcihjkjbeckainfkaddpkeghlllmkbk"
          rel="noreferrer"
          target="_blank"
        >
          {(useLocale(), m.site_chrome_ext_cta())}
        </Button>
      </section>

      <section class="notice-panel">
        <p>
          {(useLocale(),
            m.site_notice_macos({ cmd: "xattr -cr /Applications/Markdraw.app" }))}
        </p>
        <p>{(useLocale(), m.site_notice_windows())}</p>
      </section>
    </div>
  );
}
