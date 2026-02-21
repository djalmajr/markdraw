import atomOneDarkUrl from "highlight.js/styles/atom-one-dark.css?url";
import atomOneLightUrl from "highlight.js/styles/atom-one-light.css?url";
import githubDarkUrl from "highlight.js/styles/github-dark-dimmed.css?url";
import githubLightUrl from "highlight.js/styles/github.css?url";
import nordUrl from "highlight.js/styles/nord.css?url";
import tokyoDarkUrl from "highlight.js/styles/tokyo-night-dark.css?url";
import tokyoLightUrl from "highlight.js/styles/tokyo-night-light.css?url";

interface CodeTheme {
  darkVariant: boolean;
  id: string;
  label: string;
  url: string;
}

const CodeThemes: CodeTheme[] = [
  { id: "github-light", label: "GitHub Light", url: githubLightUrl, darkVariant: false },
  { id: "github-dark", label: "GitHub Dark", url: githubDarkUrl, darkVariant: true },
  { id: "atom-one-light", label: "Atom One Light", url: atomOneLightUrl, darkVariant: false },
  { id: "atom-one-dark", label: "Atom One Dark", url: atomOneDarkUrl, darkVariant: true },
  { id: "nord", label: "Nord", url: nordUrl, darkVariant: true },
  { id: "tokyo-light", label: "Tokyo Night Light", url: tokyoLightUrl, darkVariant: false },
  { id: "tokyo-dark", label: "Tokyo Night Dark", url: tokyoDarkUrl, darkVariant: true },
];

const STORAGE_KEY = "adoc-viewer-code-theme";
const LINK_ID = "hljs-theme-link";

function getStoredCodeTheme(): string {
  return localStorage.getItem(STORAGE_KEY) || "auto";
}

function setStoredCodeTheme(id: string): void {
  localStorage.setItem(STORAGE_KEY, id);
}

function applyCodeTheme(themeId: string, isDark: boolean): void {
  const url =
    themeId === "auto"
      ? (isDark ? githubDarkUrl : githubLightUrl)
      : (CodeThemes.find((t) => t.id === themeId)?.url ?? githubLightUrl);

  let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = LINK_ID;
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  if (link.href !== url) {
    link.href = url;
  }
}

export { type CodeTheme, CodeThemes, applyCodeTheme, getStoredCodeTheme, setStoredCodeTheme };
