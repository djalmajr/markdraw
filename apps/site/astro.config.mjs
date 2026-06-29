import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const guideCategoryTranslations = {
  start: {
    "pt-BR": "Primeiros passos",
    es: "Primeros pasos",
  },
  documents: {
    "pt-BR": "Documentos",
    es: "Documentos",
  },
  workspace: {
    "pt-BR": "Workspace",
    es: "Workspace",
  },
  ai: {
    "pt-BR": "IA",
    es: "IA",
  },
  preferences: {
    "pt-BR": "Preferências",
    es: "Preferencias",
  },
};

export default defineConfig({
  site: "https://markdraw.app",
  integrations: [
    starlight({
      title: "Markdraw",
      description: "A local-first AsciiDoc and Markdown workflow for desktop and browser.",
      components: {
        Header: "./src/components/starlight/header.astro",
      },
      customCss: ["./src/styles/starlight.css"],
      favicon: "/favicon.svg",
      locales: {
        root: {
          label: "English",
          lang: "en",
        },
        "pt-br": {
          label: "Português",
          lang: "pt-BR",
        },
        es: {
          label: "Español",
          lang: "es",
        },
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/djalmajr/markdraw",
        },
      ],
      sidebar: [
        "guide",
        {
          label: "Getting started",
          translations: guideCategoryTranslations.start,
          collapsed: false,
          items: ["guide/installation", "guide/opening-files", "guide/navigation"],
        },
        {
          label: "Documents",
          translations: guideCategoryTranslations.documents,
          collapsed: false,
          items: ["guide/processing", "guide/editor", "guide/diagrams", "guide/media", "guide/export"],
        },
        {
          label: "Workspace",
          translations: guideCategoryTranslations.workspace,
          collapsed: false,
          items: [
            "guide/tabs",
            "guide/toc",
            "guide/search",
            "guide/workspace-symbols",
            "guide/reader-mode",
            "guide/screenshots",
          ],
        },
        {
          label: "AI",
          translations: guideCategoryTranslations.ai,
          collapsed: false,
          items: ["guide/assistant", "guide/providers", "guide/mcp", "guide/indexing"],
        },
        {
          label: "Preferences",
          translations: guideCategoryTranslations.preferences,
          collapsed: false,
          items: ["guide/appearance", "guide/shortcuts"],
        },
      ],
    }),
  ],
  vite: {
    resolve: {
      alias: {
        "~": path.resolve(rootDir, "src"),
      },
    },
  },
});
