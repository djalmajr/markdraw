import { For } from "solid-js";
import { Link, Outlet } from "@tanstack/solid-router";
import { Button } from "@markdraw/ui/components/ui/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@markdraw/ui/components/ui/popover.tsx";
import * as m from "@markdraw/i18n";
import { locales, switchLocale, useLocale } from "@markdraw/i18n/solid";

function GithubIcon() {
  return (
    <svg
      aria-hidden="true"
      class="site-header-button-icon"
      fill="none"
      height="16"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      viewBox="0 0 24 24"
      width="16"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  );
}

// Each navigation item carries a locale-resolving thunk instead of
// a string key. Static references like `m.site_nav_home` let
// Rollup tree-shake the i18n catalog — a `messages[key]()` lookup
// would retain every message reachable via the catalog's index
// module (worth ~13 KB gzip on the site bundle). Guide and Privacy
// keep their English long-form copy per DJA-28 scope; only the nav
// label is localized.
const navigationItems = [
  { href: "/", label: m.site_nav_home },
  { href: "/guide", label: m.site_nav_guide },
  { href: "/privacy", label: m.site_nav_privacy },
] as const;

// Display labels for each shipping locale. Native names read better
// than two-letter codes inside the picker.
const LOCALE_LABELS: Record<string, string> = {
  en: "English",
  "pt-BR": "Português",
  es: "Español",
};

// Inline SVG flags so the picker stays self-contained (no external
// font/emoji fallback variance across OSes and headless browsers).
// Each flag is a simplified rectangular take on the national flag —
// recognizable at the 20×14 size we ship in the header.
function Flag(props: { locale: string; class?: string }) {
  const cls = props.class ?? "site-locale-flag";
  if (props.locale === "pt-BR") {
    return (
      <svg
        aria-hidden="true"
        class={cls}
        viewBox="0 0 20 14"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect width="20" height="14" fill="#009b3a" />
        <polygon points="10,2 18,7 10,12 2,7" fill="#ffdf00" />
        <circle cx="10" cy="7" r="2.4" fill="#002776" />
      </svg>
    );
  }
  if (props.locale === "es") {
    return (
      <svg
        aria-hidden="true"
        class={cls}
        viewBox="0 0 20 14"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect width="20" height="3.5" y="0" fill="#aa151b" />
        <rect width="20" height="7" y="3.5" fill="#f1bf00" />
        <rect width="20" height="3.5" y="10.5" fill="#aa151b" />
      </svg>
    );
  }
  // en — US flag (stripes + canton). At the picker size we don't
  // try to render the 50 stars; the alternating red/white bands
  // plus the blue canton are enough for instant recognition.
  return (
    <svg aria-hidden="true" class={cls} viewBox="0 0 20 14" xmlns="http://www.w3.org/2000/svg">
      <rect width="20" height="14" fill="#ffffff" />
      <rect width="20" height="2" y="0" fill="#b22234" />
      <rect width="20" height="2" y="4" fill="#b22234" />
      <rect width="20" height="2" y="8" fill="#b22234" />
      <rect width="20" height="2" y="12" fill="#b22234" />
      <rect width="8" height="7.5" fill="#3c3b6e" />
    </svg>
  );
}

export function SiteLayout() {
  return (
    <div class="site-shell">
      <header class="site-header">
        <div class="site-header-inner">
          <Link class="site-logo" to="/">
            <img alt="Markdraw logo" class="site-logo-mark" src="/asciimark-logo.svg" />
            <span>Markdraw</span>
          </Link>
          <nav class="site-nav" aria-label="Main navigation">
            <For each={navigationItems}>
              {(item) => (
                <Link
                  to={item.href}
                  class="site-nav-item"
                  activeProps={{ class: "site-nav-item site-nav-item-active", "aria-current": "page" }}
                >
                  {(useLocale(), item.label())}
                </Link>
              )}
            </For>
          </nav>
          <div class="site-header-actions">
            <Popover>
              <PopoverTrigger
                class="site-locale-trigger"
                aria-label={(useLocale(), m.site_locale_label())}
              >
                <Flag locale={useLocale()} />
              </PopoverTrigger>
              <PopoverContent class="site-locale-popover">
                <ul class="site-locale-list" role="listbox">
                  <For each={locales}>
                    {(loc) => (
                      <li>
                        <button
                          type="button"
                          role="option"
                          aria-selected={useLocale() === loc}
                          class="site-locale-option"
                          classList={{
                            // Track the reactive locale signal (useLocale),
                            // NOT currentLocale() — the latter is a one-shot
                            // read, so the active highlight froze on the
                            // previous locale after switching.
                            "site-locale-option-active": useLocale() === loc,
                          }}
                          onClick={() => {
                            if (useLocale() === loc) return;
                            switchLocale(loc as (typeof locales)[number]);
                          }}
                        >
                          <Flag locale={loc} />
                          <span>{LOCALE_LABELS[loc] ?? loc}</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </PopoverContent>
            </Popover>
            <Button
              as="a"
              class="site-header-button"
              href="https://github.com/djalmajr/asciimark/issues"
              rel="noreferrer"
              target="_blank"
              variant="ghost"
            >
              <GithubIcon />
            </Button>
          </div>
        </div>
      </header>

      <main class="site-main">
        <Outlet />
      </main>

      <footer class="site-footer">
        <p>{(useLocale(), m.site_footer_copyright())}</p>
      </footer>
    </div>
  );
}
