import type { Setter } from "solid-js";
import type { AppState } from "@asciimark/ui/composables/create-app-state.ts";
import { simpleHash } from "./hash.ts";
import {
  fetchFileByUrl,
  dirOfUrl,
  fileNameFromUrl,
  isFileUrl,
  createUrlReadFile,
} from "./url-source.ts";

interface UrlModeDeps {
  setFileAccessDenied: Setter<boolean>;
  setUrlError: Setter<string | null>;
  setUrlFileName: Setter<string>;
  state: AppState;
}

export function createUrlMode(deps: UrlModeDeps) {
  const { setFileAccessDenied, setUrlError, setUrlFileName, state } = deps;

  let urlRefreshInterval: ReturnType<typeof setInterval> | null = null;
  let lastUrlContentHash = "";

  async function loadUrlContent(url: string) {
    state.setLoading(true);
    setUrlError(null);
    setFileAccessDenied(false);

    try {
      const content = await fetchFileByUrl(url);
      lastUrlContentHash = simpleHash(content);

      const baseUrl = dirOfUrl(url);
      const filePath = fileNameFromUrl(url);
      const readFile = createUrlReadFile(baseUrl);

      const result = await state.convert(filePath, content, readFile);

      // Set a synthetic selectedFile so AppShell shows Preview (not EmptyState)
      // and the toc panel visibility works correctly
      state.setSelectedFile({ name: filePath, kind: "file", path: filePath });
      state.setHtml(result.html);
      state.setFrontmatter(result.frontmatter);
      state.setEditorContent(content);
      state.setSavedContent(content);
    } catch (e) {
      console.error("Failed to load URL:", e);

      if (isFileUrl(url)) {
        setFileAccessDenied(true);
      } else {
        setUrlError(`Failed to load file: ${e}`);
        state.setHtml(`<div class="error">Error loading file: ${e}</div>`);
      }
    } finally {
      state.setLoading(false);
    }
  }

  function startUrlRefresh(url: string) {
    if (urlRefreshInterval) clearInterval(urlRefreshInterval);
    urlRefreshInterval = setInterval(async () => {
      if (!state.autoRefresh()) return;
      try {
        const content = await fetchFileByUrl(url);
        const hash = simpleHash(content);
        if (hash !== lastUrlContentHash) {
          lastUrlContentHash = hash;
          const baseUrl = dirOfUrl(url);
          const filePath = fileNameFromUrl(url);
          const readFile = createUrlReadFile(baseUrl);
          const result = await state.convert(filePath, content, readFile);
          state.setHtml(result.html);
          state.setFrontmatter(result.frontmatter);
        }
      } catch {
        // Silently ignore polling errors
      }
    }, 2000);
  }

  async function initUrlMode(url: string) {
    setUrlFileName(fileNameFromUrl(url));

    // Restore fragment from URL hash (set by cross-file xref navigation)
    const hash = window.location.hash;
    if (hash.length > 1) {
      state.setPendingFragment(decodeURIComponent(hash.slice(1)));
    }

    await loadUrlContent(url);

    // Auto-refresh polling only works for https:// URLs (direct fetch).
    // For file:// URLs the content was captured once by the content script.
    if (!isFileUrl(url)) {
      startUrlRefresh(url);
    }
  }

  function cleanup() {
    if (urlRefreshInterval) clearInterval(urlRefreshInterval);
  }

  return { cleanup, initUrlMode };
}
