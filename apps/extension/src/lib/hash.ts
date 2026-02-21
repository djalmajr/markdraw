/** Get the ?url= parameter from the current page URL */
export function getUrlParam(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("url");
}

/** Get file path from URL hash. Hash format: #/path/to/file.adoc */
export function getPathFromHash(): string | null {
  const hash = window.location.hash;
  if (!hash || hash === "#") return null;
  return hash.replace(/^#\/?/, "");
}

/** Set URL hash from file path */
export function setHashFromPath(path: string | null) {
  if (path) {
    const newHash = `#/${path}`;
    if (window.location.hash !== newHash) {
      history.pushState(null, "", newHash);
    }
  } else {
    if (window.location.hash) {
      history.pushState(null, "", window.location.pathname + window.location.search);
    }
  }
}

/** Simple string hash for URL content change detection */
export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return hash.toString(36);
}
