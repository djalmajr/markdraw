const STORAGE_KEY = "asciimark-font-prefs";

interface FontPrefs {
  fontFamily: string;
  fontSize: number;
}

const FontFamilies = [
  { id: "sans-serif", label: "Sans-serif" },
  { id: "serif", label: "Serif" },
  { id: "monospace", label: "Monospace" },
] as const;

const FontSizes = [13, 14, 15, 16, 18, 20] as const;

const DEFAULT_PREFS: FontPrefs = { fontSize: 15, fontFamily: "sans-serif" };

const FAMILY_MAP: Record<string, string> = {
  "monospace": "var(--font-mono)",
  "sans-serif": "var(--font-sans)",
  "serif": "Georgia, 'Times New Roman', serif",
};

function getStoredFontPrefs(): FontPrefs {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...JSON.parse(stored) };
  } catch {
    return DEFAULT_PREFS;
  }
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
