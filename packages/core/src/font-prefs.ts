import { PartialFontPrefsSchema, safeJsonParse, type FontPrefs as PersistedFontPrefs } from "./schemas.ts";

const STORAGE_KEY = "asciimark-font-prefs";

// Local alias — keeps the public type name (`FontPrefs`) stable for
// downstream imports while the schema-inferred type lives in
// schemas.ts so both stay in sync.
interface FontPrefs extends PersistedFontPrefs {}

const FontFamilies = [
  { id: "sans-serif", label: "Sans-serif" },
  { id: "serif", label: "Serif" },
  { id: "monospace", label: "Monospace" },
] as const;

const FontSizes = [13, 14, 15, 16, 18, 20, 24, 28, 32, 40, 48] as const;

const DEFAULT_PREFS: FontPrefs = { fontSize: 15, fontFamily: "sans-serif" };

const FAMILY_MAP: Record<string, string> = {
  "monospace": "var(--font-mono)",
  "sans-serif": "var(--font-sans)",
  "serif": "Georgia, 'Times New Roman', serif",
};

function getStoredFontPrefs(): FontPrefs {
  // Storage boundary: validate the partial shape (older AsciiMark
  // installs persisted only `fontSize` before `fontFamily` shipped,
  // so a strict parse would reject those legacy entries). Validated
  // fields are merged onto defaults; anything missing or invalid
  // falls back to the canonical default for that field.
  const parsed = safeJsonParse(localStorage.getItem(STORAGE_KEY), PartialFontPrefsSchema);
  if (!parsed) return DEFAULT_PREFS;
  return { ...DEFAULT_PREFS, ...parsed };
}

function setStoredFontPrefs(prefs: FontPrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

function applyFontPrefs(prefs: FontPrefs): void {
  document.documentElement.style.setProperty("--doc-font-size", `${prefs.fontSize}px`);
  document.documentElement.style.setProperty(
    "--doc-font-family",
    FAMILY_MAP[prefs.fontFamily] || "var(--font-sans)"
  );
}

export {
  type FontPrefs,
  FontFamilies,
  FontSizes,
  applyFontPrefs,
  getStoredFontPrefs,
  setStoredFontPrefs,
};
