import { For, Show, createSignal, onMount } from "solid-js";
import { Button } from "@asciimark/ui/components/ui/button.tsx";
import { Link } from "@tanstack/solid-router";

interface FeatureItem {
  description: string;
  title: string;
}

interface DownloadItem {
  asset: string;
  helper: string;
  platform: string;
}

interface ScreenshotItem {
  alt: string;
  caption: string;
  path: string;
}

const RELEASES_BASE_URL =
  "https://github.com/djalmajr/asciimark-releases/releases/latest/download";
const RELEASES_LATEST_URL =
  "https://github.com/djalmajr/asciimark-releases/releases/latest";

interface PreferredDownload {
  href: string;
  label: string;
}

const featureItems: FeatureItem[] = [
  {
    title: "AsciiDoc + Markdown",
    description:
      "Renders both formats with admonitions, includes, frontmatter, and reusable partials in a single viewer.",
  },
  {
    title: "Split panes + tabs",
    description:
      "Open files side by side, drag tabs across panes, and keep the layout between sessions.",
  },
  {
    title: "Keyboard-first navigation",
    description:
      "Quick Open, Command Palette, Go-to-Heading, and Find-in-Files — all one shortcut away.",
  },
  {
    title: "Diagrams and math",
    description:
      "Mermaid, PlantUML, Graphviz, and KaTeX render inside the preview without extra setup.",
  },
  {
    title: "Edit + live preview",
    description:
      "CodeMirror editor with sync scroll, find-in-file, and configurable formatting.",
  },
  {
    title: "Local-first, auto-update",
    description:
      "Files stay on your machine; signed releases land via the auto-updater on startup.",
  },
];

const downloadItems: DownloadItem[] = [
  {
    platform: "macOS (Apple Silicon)",
    helper: "DMG installer",
    asset: "AsciiMark-macos-arm64.dmg",
  },
  {
    platform: "macOS (Intel)",
    helper: "DMG installer",
    asset: "AsciiMark-macos-x64.dmg",
  },
  {
    platform: "Linux",
    helper: "AppImage",
    asset: "AsciiMark-linux-x64.AppImage",
  },
  {
    platform: "Linux (Debian)",
    helper: "DEB package",
    asset: "AsciiMark-linux-x64.deb",
  },
  {
    platform: "Windows",
    helper: "MSI installer",
    asset: "AsciiMark-windows-x64.msi",
  },
  {
    platform: "Windows (alt)",
    helper: "EXE installer",
    asset: "AsciiMark-windows-x64.exe",
  },
];

const heroPreviewItem: ScreenshotItem = {
  path: "/screenshots/desktop-workspace-preview.png",
  alt: "AsciiMark desktop app with Markdown file, sidebar tree, and table of contents",
  caption: "Desktop preview with sidebar, tabs, and table of contents.",
};

function releaseUrl(asset: string) {
  return `${RELEASES_BASE_URL}/${asset}`;
}

function detectPreferredDownload(): PreferredDownload {
  if (typeof navigator === "undefined") {
    return { href: RELEASES_LATEST_URL, label: "your platform" };
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
      href: releaseUrl(isAppleSilicon ? "AsciiMark-macos-arm64.dmg" : "AsciiMark-macos-x64.dmg"),
      label: isAppleSilicon ? "macOS (Apple Silicon)" : "macOS (Intel)",
    };
  }

  if (platform.includes("win")) {
    return {
      href: releaseUrl("AsciiMark-windows-x64.msi"),
      label: "Windows",
    };
  }

  if (platform.includes("linux")) {
    return {
      href: releaseUrl("AsciiMark-linux-x64.AppImage"),
      label: "Linux",
    };
  }

  return { href: RELEASES_LATEST_URL, label: "your platform" };
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
        href: releaseUrl("AsciiMark-macos-arm64.dmg"),
        label: "macOS (Apple Silicon)",
      };
    }

    if (architecture?.includes("x86")) {
      return {
        href: releaseUrl("AsciiMark-macos-x64.dmg"),
        label: "macOS (Intel)",
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
            <p class="hero-kicker">AsciiDoc and Markdown Viewer</p>
            <h1 class="hero-title">Ship docs faster with a local-first preview workflow.</h1>
            <p class="hero-description">
              AsciiMark keeps authoring and preview side by side across desktop and browser.
              Install the latest build from GitHub Releases and keep everything in one ecosystem.
            </p>
            <div class="hero-actions">
              <Button as="a" href={preferredDownload().href} rel="noreferrer" target="_blank">
                Download for {preferredDownload().label}
              </Button>
              <Button as={Link} to="/guide" variant="secondary">
                Read Guide
              </Button>
            </div>
          </div>
          <figure class="hero-shot">
            <button
              class="hero-shot-button"
              onClick={() => openScreenshotModal(heroPreviewItem)}
              type="button"
            >
              <img alt={heroPreviewItem.alt} src={heroPreviewItem.path} />
            </button>
            <figcaption>{heroPreviewItem.caption}</figcaption>
          </figure>
        </div>
      </section>

      <section class="grid-panel">
        <h2 class="section-title">Features</h2>
        <div class="feature-grid">
          <For each={featureItems}>
            {(item) => (
              <article class="feature-card">
                <h3>{item.title}</h3>
                <p>{item.description}</p>
              </article>
            )}
          </For>
          <Link class="feature-card feature-card-more" to="/guide">
            <h3>…and much more</h3>
            <p>
              Multi-root workspaces, themes, PDF export, Chrome extension,
              auto-update, and the full keyboard map. See the guide for
              screenshots and details.
            </p>
          </Link>
        </div>
      </section>

      <section class="grid-panel" id="download">
        <h2 class="section-title">Downloads</h2>
        <p class="section-subtitle">
          All links below point to <code>releases/latest/download</code> in the public repository.
        </p>
        <div class="download-grid">
          <For each={downloadItems}>
            {(item) => (
              <article class="download-card">
                <p class="download-platform">{item.platform}</p>
                <p class="download-helper">{item.helper}</p>
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
            <div class="screenshot-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Screenshot preview">
              <div class="screenshot-modal-header">
                <p>{item().caption}</p>
                <button
                  aria-label="Close screenshot preview"
                  class="screenshot-modal-close"
                  onClick={closeScreenshotModal}
                  type="button"
                >
                  ×
                </button>
              </div>
              <div class="screenshot-modal-image-wrap">
                <img
                  alt={item().alt}
                  class="screenshot-modal-image"
                  src={item().path}
                />
              </div>
            </div>
          </div>
        )}
      </Show>

      <section class="notice-panel">
        <p>
          macOS may block unsigned apps on first launch. Run{" "}
          <code>xattr -cr /Applications/AsciiMark.app</code>{" "}
          after installing.
        </p>
        <p>
          Windows SmartScreen may require <strong>More info</strong> and then
          {" "} <strong>Run anyway</strong>.
        </p>
      </section>
    </div>
  );
}
