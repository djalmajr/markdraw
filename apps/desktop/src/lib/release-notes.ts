// Fetches the release notes for a given Markdraw version from the
// public release repo (`djalmajr/markdraw`). The result is
// cached in-memory per version so reopening the dialog never refetches.
//
// The GitHub REST endpoint for a release-by-tag returns `body` as
// markdown. We return that string verbatim — the dialog renders it
// through MarkdownIt with `html: false`, same path the update flow
// already uses for the notes coming through the Tauri updater.
//
// Empty `body` is reported as an empty string; the dialog renders a
// localized "no notes" fallback for that case. A non-2xx response or a
// transport failure is surfaced as a thrown Error whose message reaches
// the dialog's error fallback (and the "Open on GitHub" button).

const RELEASES_REPO = "djalmajr/markdraw";

/** Default number of historical releases the dialog asks for. The
 *  GitHub API caps `per_page` at 100; 10 is enough to cover the
 *  visible scroll length of the dialog and keeps the payload small. */
const DEFAULT_HISTORY_LIMIT = 10;

const cache = new Map<string, string>();
let historyCache: ReleaseHistoryEntry[] | null = null;

export interface ReleaseNotes {
  /** Markdown body. Empty string when the release has no notes. */
  body: string;
  /** Public URL of the release page (always returned so the UI can
   *  link out even when the request succeeded). */
  htmlUrl: string;
}

/** One entry in the release-history listing rendered by the dialog. */
export interface ReleaseHistoryEntry {
  /** Tag name as published on GitHub (`v0.10.0`). */
  tagName: string;
  /** Version stripped of the leading `v` (`0.10.0`). The dialog uses
   *  this for the header label and for matching against the locally
   *  installed version. */
  version: string;
  /** Display name (`Markdraw v0.10.0` etc.). Falls back to tagName
   *  when the release has no `name`. */
  name: string;
  /** Release body (markdown). Empty string when the release shipped
   *  without notes. */
  body: string;
  /** Public URL of the release page. */
  htmlUrl: string;
  /** ISO timestamp from GitHub. May be empty for drafts. */
  publishedAt: string;
}

/** URL of the release page for the given version. Used by the dialog
 *  for the "Open on GitHub" button and the error fallback. */
export function releaseHtmlUrl(version: string): string {
  return `https://github.com/${RELEASES_REPO}/releases/tag/v${version}`;
}

/** Fetches release notes for the given version, caching the result.
 *  Subsequent calls for the same version skip the network entirely. */
export async function fetchReleaseNotes(
  version: string,
  fetcher: typeof fetch = fetch,
): Promise<ReleaseNotes> {
  const cached = cache.get(version);
  if (cached !== undefined) {
    return { body: cached, htmlUrl: releaseHtmlUrl(version) };
  }
  const url = `https://api.github.com/repos/${RELEASES_REPO}/releases/tags/v${version}`;
  const res = await fetcher(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub responded with ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { body?: string };
  const body = (data.body ?? "").trim();
  cache.set(version, body);
  return { body, htmlUrl: releaseHtmlUrl(version) };
}

/**
 * Fetches the N most recent releases from the public release repo,
 * caching the resulting list in memory so reopening the dialog skips
 * the network. Drafts are filtered out by the API for unauthenticated
 * calls; we additionally normalize the shape to `ReleaseHistoryEntry`
 * (tagName / version / name / body / htmlUrl / publishedAt).
 *
 * A failure throws — the dialog renders the error message and the
 * "Open on GitHub" button remains available either way. Failures are
 * NOT cached, so a transient network blip on first open can recover
 * on the next try.
 */
export async function fetchReleaseHistory(
  limit: number = DEFAULT_HISTORY_LIMIT,
  fetcher: typeof fetch = fetch,
): Promise<ReleaseHistoryEntry[]> {
  if (historyCache !== null) return historyCache;
  const url = `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=${limit}`;
  const res = await fetcher(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub responded with ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as Array<{
    tag_name?: string;
    name?: string;
    body?: string;
    html_url?: string;
    published_at?: string;
    draft?: boolean;
    prerelease?: boolean;
  }>;
  const entries: ReleaseHistoryEntry[] = raw
    .filter((entry) => entry.draft !== true && typeof entry.tag_name === "string")
    .map((entry) => {
      const tagName = entry.tag_name!;
      const version = tagName.startsWith("v") ? tagName.slice(1) : tagName;
      return {
        tagName,
        version,
        name: entry.name?.trim() || tagName,
        body: (entry.body ?? "").trim(),
        htmlUrl: entry.html_url ?? releaseHtmlUrl(version),
        publishedAt: entry.published_at ?? "",
      };
    });
  historyCache = entries;
  return entries;
}

/** Test hook — clears the in-memory caches so test isolation is honoured. */
export function _clearReleaseNotesCache(): void {
  cache.clear();
  historyCache = null;
}
