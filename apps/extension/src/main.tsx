/* @refresh reload */
import { render } from "solid-js/web";
import { App } from "./app.tsx";
import "@markdraw/ui/styles/index.css";
import { applyCodeTheme, getStoredCodeTheme } from "@markdraw/core/code-theme.ts";
import { applyFontPrefs, getStoredFontPrefs } from "@markdraw/core/font-prefs.ts";

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "adoc-viewer-theme";

function getStoredTheme(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "system";
}

function applyTheme(mode: ThemeMode) {
  localStorage.setItem(STORAGE_KEY, mode);
  const isDark =
    mode === "dark" ||
    (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", isDark);
}

// Apply on load
applyTheme(getStoredTheme());
applyCodeTheme(
  getStoredCodeTheme(),
  document.documentElement.classList.contains("dark")
);
applyFontPrefs(getStoredFontPrefs());

// Listen for system changes (only matters when mode is "system")
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (getStoredTheme() === "system") {
    applyTheme("system");
  }
});

// Export helpers for use in components
export { getStoredTheme, applyTheme, STORAGE_KEY };

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
