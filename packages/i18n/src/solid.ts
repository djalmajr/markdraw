import { createSignal } from "solid-js";
import {
  baseLocale,
  getLocale,
  isLocale,
  locales,
  setLocale as paraglideSetLocale,
  type Locale,
} from "./paraglide/runtime.js";

/**
 * Adapter that lifts Paraglide's runtime locale into a Solid signal, so
 * any JSX that depends on `useLocale()` re-runs when the user switches
 * language.
 *
 * Paraglide messages are plain functions (`m.toolbar_open_folder()`),
 * not signals. By themselves they don't trigger Solid reactivity. The
 * convention is to track the locale signal in the same JSX expression:
 *
 *   import * as m from "@asciimark/i18n";
 *   import { useLocale } from "@asciimark/i18n/solid";
 *
 *   <button>{(useLocale(), m.toolbar_open_folder())}</button>
 *
 * The comma operator pattern registers `useLocale()` as a tracked
 * dependency and returns the message string. Switching language via
 * `switchLocale("pt-BR")` updates the signal and Solid re-renders
 * every JSX node that read it.
 *
 * Persistence: the chosen locale is stored in localStorage under
 * `asciimark-locale`. On first load we hydrate from storage, falling
 * back to the browser's `navigator.language` (mapped to a supported
 * locale) and finally to `baseLocale` ("en").
 */

const STORAGE_KEY = "asciimark-locale";

function detectInitialLocale(): Locale {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isLocale(stored)) return stored;
  }
  if (typeof navigator !== "undefined") {
    const nav = navigator.language;
    // Try exact match first ("pt-BR"), then language-only ("pt").
    if (isLocale(nav)) return nav as Locale;
    const langOnly = nav.split("-")[0];
    const match = locales.find((l) => l === langOnly || l.startsWith(`${langOnly}-`));
    if (match) return match;
  }
  return baseLocale;
}

const initialLocale = detectInitialLocale();

// Sync paraglide's runtime to the detected locale before the app
// renders. Use { reload: false } so we don't end up in a refresh loop
// during initial hydration; the signal-driven re-render handles UI.
paraglideSetLocale(initialLocale, { reload: false });

const [localeSignal, setLocaleSignal] = createSignal<Locale>(initialLocale);

/**
 * Read the active locale as a tracked Solid signal. JSX that calls
 * this — typically via the comma-operator pattern shown above — will
 * re-run whenever the user switches language.
 */
export const useLocale = localeSignal;

/**
 * Available locales for UI selection (e.g. a Command Palette item or
 * a `<select>` in settings). Re-exports the Paraglide constant.
 */
export { locales };

/**
 * Switch the active locale. Persists to localStorage, updates
 * Paraglide's runtime, and triggers a Solid re-render of any JSX
 * that depends on `useLocale()`.
 */
export function switchLocale(newLocale: Locale): void {
  if (!isLocale(newLocale)) {
    console.warn(`[i18n] unknown locale "${newLocale}", ignoring`);
    return;
  }
  if (newLocale === localeSignal()) return;
  paraglideSetLocale(newLocale, { reload: false });
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, newLocale);
    } catch {
      // storage may be full or disabled; the in-memory signal still works
    }
  }
  setLocaleSignal(newLocale);
}

/**
 * One-shot read of the current locale (non-reactive). Use `useLocale()`
 * inside JSX or effects for reactivity.
 */
export const currentLocale = (): Locale => getLocale() as Locale;
