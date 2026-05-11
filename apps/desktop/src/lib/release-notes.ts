// Fetches the release notes for a given AsciiMark version from the
// public release repo (`djalmajr/asciimark-releases`). The result is
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

const RELEASES_REPO = "djalmajr/asciimark-releases";

const cache = new Map<string, string>();

export interface ReleaseNotes {
  /** Markdown body. Empty string when the release has no notes. */
  body: string;
  /** Public URL of the release page (always returned so the UI can
   *  link out even when the request succeeded). */
  htmlUrl: string;
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

/** Test hook — clears the in-memory cache so test isolation is honoured. */
export function _clearReleaseNotesCache(): void {
  cache.clear();
}
