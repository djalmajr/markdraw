import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  _clearReleaseNotesCache,
  fetchReleaseHistory,
  fetchReleaseNotes,
  releaseHtmlUrl,
} from "./release-notes.ts";

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  _clearReleaseNotesCache();
});

describe("releaseHtmlUrl", () => {
  it("points to the public asciimark-releases tag URL", () => {
    // Domain rule: the public release page is the canonical fallback
    // surfaced to the user when the API call fails — it MUST land on
    // the public repo, not on the private source repo.
    expect(releaseHtmlUrl("0.10.0")).toBe(
      "https://github.com/djalmajr/asciimark-releases/releases/tag/v0.10.0",
    );
  });
});

describe("fetchReleaseNotes", () => {
  it("returns the trimmed markdown body from the GitHub release endpoint", async () => {
    // Mutation captured: dropping the `.trim()` would leak the leading
    // newline GitHub sometimes ships in `body`, and any test asserting
    // exact output would catch the drift.
    const fetcher = mock(async () => jsonResponse({ body: "\n## Notes\n\n- a\n- b\n" }));
    const result = await fetchReleaseNotes("0.10.0", fetcher as unknown as typeof fetch);
    expect(result.body).toBe("## Notes\n\n- a\n- b");
    expect(result.htmlUrl).toBe(releaseHtmlUrl("0.10.0"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns an empty string when the release ships without a body", async () => {
    // Regression guard: GitHub omits `body` when the maintainer
    // published the release without notes. The dialog renders a
    // localized "no notes" fallback for this case — turning `null`
    // into an empty string keeps that path lit.
    const fetcher = mock(async () => jsonResponse({}));
    const result = await fetchReleaseNotes("0.9.0", fetcher as unknown as typeof fetch);
    expect(result.body).toBe("");
  });

  it("caches the body so reopening the dialog skips the network", async () => {
    // Mutation captured: removing the `cache.set` / `cache.get` would
    // refetch on every call, blowing the second call's spy count up
    // from 1 to 2.
    const fetcher = mock(async () => jsonResponse({ body: "cached" }));
    await fetchReleaseNotes("0.8.0", fetcher as unknown as typeof fetch);
    await fetchReleaseNotes("0.8.0", fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("caches per-version — different versions trigger separate fetches", async () => {
    // Mutation captured: a global cache (ignoring the version key)
    // would skip the second call and return the first version's body.
    const fetcher = mock(async (url: string) => {
      const version = (url.match(/tags\/v(\d[\d.]+)/) ?? [, ""])[1];
      return jsonResponse({ body: `v${version}` });
    });
    const a = await fetchReleaseNotes("0.8.0", fetcher as unknown as typeof fetch);
    const b = await fetchReleaseNotes("0.9.0", fetcher as unknown as typeof fetch);
    expect(a.body).toBe("v0.8.0");
    expect(b.body).toBe("v0.9.0");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("propagates a descriptive Error for non-2xx responses", async () => {
    // Mutation captured: skipping the `res.ok` check would let the
    // dialog render an empty body for a 404 response instead of
    // surfacing the GitHub error to the user via the error fallback.
    const fetcher = mock(async () => new Response("", { status: 404, statusText: "Not Found" }));
    await expect(
      fetchReleaseNotes("9.9.9", fetcher as unknown as typeof fetch),
    ).rejects.toThrow(/404/);
  });

  it("does not cache failed responses (retry on next open should hit the network again)", async () => {
    // Domain rule: a network blip on first open shouldn't leave the
    // dialog stuck in an error state forever — the second open must
    // be allowed to refetch.
    let calls = 0;
    const fetcher = mock(async () => {
      calls += 1;
      if (calls === 1) return new Response("", { status: 503, statusText: "Down" });
      return jsonResponse({ body: "recovered" });
    });
    await expect(
      fetchReleaseNotes("0.10.0", fetcher as unknown as typeof fetch),
    ).rejects.toThrow();
    const ok = await fetchReleaseNotes("0.10.0", fetcher as unknown as typeof fetch);
    expect(ok.body).toBe("recovered");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("fetchReleaseHistory", () => {
  it("normalizes the GitHub list payload into ReleaseHistoryEntry[]", async () => {
    // Mutation captured: dropping the `v` strip from `tag_name` would
    // surface "v0.10.0" inside `version` and break the version-equality
    // check the dialog uses to mark the "current" entry.
    const fetcher = mock(async () =>
      jsonResponse([
        {
          tag_name: "v0.10.0",
          name: "AsciiMark v0.10.0",
          body: "## Features\n\n- thing",
          html_url: "https://github.com/djalmajr/asciimark-releases/releases/tag/v0.10.0",
          published_at: "2026-05-06T23:46:24Z",
        },
        {
          tag_name: "v0.9.1",
          name: "AsciiMark v0.9.1",
          body: "## Fixes\n\n- crash",
          html_url: "https://github.com/djalmajr/asciimark-releases/releases/tag/v0.9.1",
          published_at: "2026-05-06T01:36:30Z",
        },
      ]),
    );
    const list = await fetchReleaseHistory(10, fetcher as unknown as typeof fetch);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      tagName: "v0.10.0",
      version: "0.10.0",
      name: "AsciiMark v0.10.0",
      body: "## Features\n\n- thing",
      publishedAt: "2026-05-06T23:46:24Z",
    });
    expect(list[1]?.version).toBe("0.9.1");
  });

  it("skips drafts and tolerates missing fields", async () => {
    // Mutation captured: removing the draft filter would surface
    // unpublished work-in-progress entries to every user.
    const fetcher = mock(async () =>
      jsonResponse([
        { tag_name: "v0.11.0", draft: true, body: "WIP" },
        { tag_name: "v0.10.0", name: "AsciiMark v0.10.0" },
        // missing tag_name → discarded (no way to render it)
        { name: "broken", body: "x" },
      ]),
    );
    const list = await fetchReleaseHistory(10, fetcher as unknown as typeof fetch);
    expect(list.map((e) => e.tagName)).toEqual(["v0.10.0"]);
    expect(list[0]?.body).toBe(""); // missing body → empty string, not undefined
    expect(list[0]?.htmlUrl).toContain("v0.10.0"); // fallback when html_url missing
  });

  it("caches the result — second call skips the network", async () => {
    // Mutation captured: removing the `historyCache` short-circuit
    // would refetch on every dialog open.
    const fetcher = mock(async () => jsonResponse([{ tag_name: "v0.10.0", body: "x" }]));
    await fetchReleaseHistory(10, fetcher as unknown as typeof fetch);
    await fetchReleaseHistory(10, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not cache failed responses", async () => {
    // Domain rule: a network blip on the first open should not leave
    // the dialog stuck in an error state forever — the next open
    // must be allowed to refetch.
    let calls = 0;
    const fetcher = mock(async () => {
      calls += 1;
      if (calls === 1) return new Response("", { status: 503, statusText: "Down" });
      return jsonResponse([{ tag_name: "v0.10.0", body: "ok" }]);
    });
    await expect(fetchReleaseHistory(10, fetcher as unknown as typeof fetch)).rejects.toThrow();
    const list = await fetchReleaseHistory(10, fetcher as unknown as typeof fetch);
    expect(list).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
