/**
 * Reader / Zen mode persistence helpers — pure storage, no UI. The
 * AppState signal subscribes to these for the on-screen toggle, but
 * the value lives in localStorage so it survives reloads.
 */

export const READER_MODE_STORAGE_KEY = "asciimark-reader-mode";

export function getReaderMode(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    const raw = localStorage.getItem(READER_MODE_STORAGE_KEY);
    // Whitelist literal "true" / "false" — anything else (legacy
    // values, hand-edited junk, partial writes) falls back to the
    // safe default so the app can't get stuck in a chrome-less
    // state.
    if (raw === "true") return true;
    return false;
  } catch {
    return false;
  }
}

export function setReaderMode(value: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(READER_MODE_STORAGE_KEY, value ? "true" : "false");
  } catch {
    // Quota / privacy mode — silently drop; non-essential.
  }
}
