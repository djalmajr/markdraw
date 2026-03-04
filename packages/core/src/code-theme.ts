interface CodeTheme {
  id: string;
  label: string;
}

const CodeThemes: CodeTheme[] = [
  { id: "github-light", label: "GitHub Light" },
];

const THEME_ATTR = "data-code-theme";
const SINGLE_THEME_ID = "github-light";

function getStoredCodeTheme(): string {
  return SINGLE_THEME_ID;
}

function setStoredCodeTheme(_id: string): void {
  // Single-theme mode: no persisted selection.
}

function applyCodeTheme(_themeId: string, _isDark: boolean): void {
  document.documentElement.setAttribute(THEME_ATTR, SINGLE_THEME_ID);
}

export { type CodeTheme, CodeThemes, applyCodeTheme, getStoredCodeTheme, setStoredCodeTheme };
