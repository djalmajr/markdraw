/**
 * URL-based data source for the viewer.
 * Reads file content from chrome.storage.session (captured by content script)
 * or falls back to service worker fetch for https:// URLs.
 */

const hasStorage =
  typeof chrome !== "undefined" &&
  chrome?.storage?.session !== undefined;

/**
 * Read the cached file content from chrome.storage.session.
 * The content script stores { url, content } before redirecting to the viewer.
 */
async function readCachedContent(url: string): Promise<string | null> {
  if (!hasStorage) return null;
  try {
    const data = await chrome.storage.session.get("urlContent");
    if (data?.urlContent?.url === url && typeof data.urlContent.content === "string") {
      return data.urlContent.content;
    }
  } catch {
    // storage not available
  }
  return null;
}

/**
 * Fetch a file's text content.
 * 1. Try chrome.storage.session (content captured by content script — no permissions needed)
 * 2. Fall back to direct fetch (works for https:// URLs from extension context)
 */
export async function fetchFileByUrl(url: string): Promise<string> {
  // Try cached content first (captured by content script for file:// URLs)
  const cached = await readCachedContent(url);
  if (cached !== null) return cached;

  // Direct fetch — works for https:// URLs from extension pages
  // For file:// URLs, this will fail without host_permissions,
  // but the content script should have cached the content already
  const resp = await fetch(url, {
    headers: { "Cache-Control": "no-cache", Accept: "text/plain, */*" },
  });
  if (!resp.ok && resp.status !== 0) {
    throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  }
  return resp.text();
}

/** Extract the directory portion of a URL (everything up to the last /) */
export function dirOfUrl(url: string): string {
  const idx = url.lastIndexOf("/");
  return idx >= 0 ? url.substring(0, idx) : url;
}

/** Extract the filename from a URL */
export function fileNameFromUrl(url: string): string {
  const idx = url.lastIndexOf("/");
  const name = idx >= 0 ? url.substring(idx + 1) : url;
  const qIdx = name.indexOf("?");
  return qIdx >= 0 ? name.substring(0, qIdx) : name;
}

/**
 * Resolve a relative include path against a base URL.
 * Handles ../ and ./ segments.
 */
export function resolveUrl(baseUrl: string, relativePath: string): string {
  if (/^(file|https?):\/\//i.test(relativePath)) return relativePath;

  const baseParts = baseUrl.split("/");
  const relParts = relativePath.split("/");

  for (const part of relParts) {
    if (part === "..") {
      baseParts.pop();
    } else if (part !== "." && part !== "") {
      baseParts.push(part);
    }
  }

  return baseParts.join("/");
}

/**
 * Read a file by resolving a relative path against a base URL.
 * Used as the `readFile` function for convertAdoc in URL mode.
 * Note: includes only work for https:// URLs (direct fetch).
 * For file:// URLs, includes are not supported without host_permissions.
 */
export function createUrlReadFile(
  baseUrl: string,
): (path: string) => Promise<string | null> {
  return async (path: string): Promise<string | null> => {
    const fullUrl = resolveUrl(baseUrl, path);
    try {
      return await fetchFileByUrl(fullUrl);
    } catch {
      return null;
    }
  };
}

/**
 * Extract a display-friendly path from a URL.
 * file:///Users/x/docs/readme.adoc → readme.adoc
 * https://example.com/docs/readme.adoc → example.com/docs/readme.adoc
 */
export function displayPathFromUrl(url: string): string {
  if (url.startsWith("file://")) {
    return fileNameFromUrl(url);
  }
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return fileNameFromUrl(url);
  }
}

/** Check if a URL is a file:// URL */
export function isFileUrl(url: string): boolean {
  return url.startsWith("file://");
}
