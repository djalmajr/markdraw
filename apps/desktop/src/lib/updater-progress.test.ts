import { describe, expect, it } from "bun:test";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import {
  initialProgressState,
  reduceDownloadEvent,
  type ProgressReducerState,
} from "./updater-progress.ts";

describe("reduceDownloadEvent", () => {
  it("Started sets phase=downloading, downloaded=0, and captures contentLength as total", () => {
    // Mutation captured: collapsing `total` to a literal 0 instead of
    // the contentLength makes the dialog render an indeterminate
    // progress bar even when the server tells us the size up front.
    const state = reduceDownloadEvent(
      initialProgressState(),
      { event: "Started", data: { contentLength: 31_457_280 } },
      1000,
    );
    expect(state.progress).toEqual({
      phase: "downloading",
      downloaded: 0,
      total: 31_457_280,
      speed: 0,
    });
  });

  it("Started with missing contentLength surfaces total=null (indeterminate)", () => {
    // Domain rule: Tauri's updater plugin sometimes lacks
    // `content-length` (server omitted the header, proxy stripped it).
    // The dialog has a dedicated copy ("Downloading X · Y/s") for
    // this case; total MUST be null, not 0, so the renderer can pick
    // the right branch.
    const state = reduceDownloadEvent(
      initialProgressState(),
      { event: "Started", data: {} },
      1000,
    );
    expect(state.progress?.total).toBeNull();
  });

  it("accumulates Progress chunks into a monotonically growing downloaded count", () => {
    // Mutation captured: replacing `prev.downloaded + chunkLength`
    // with a bare `chunkLength` would lose the running total and the
    // dialog would oscillate.
    let s = reduceDownloadEvent(
      initialProgressState(),
      { event: "Started", data: { contentLength: 100 } },
      0,
    );
    s = reduceDownloadEvent(s, { event: "Progress", data: { chunkLength: 30 } }, 100);
    expect(s.progress?.downloaded).toBe(30);
    s = reduceDownloadEvent(s, { event: "Progress", data: { chunkLength: 25 } }, 200);
    expect(s.progress?.downloaded).toBe(55);
  });

  it("ignores Progress events that arrive before a Started event", () => {
    // Regression guard: if the bridge emits a stale Progress event
    // from a previous (cancelled) download, swallowing it keeps the
    // dialog quiet instead of flashing a half-built state.
    const s = reduceDownloadEvent(
      initialProgressState(),
      { event: "Progress", data: { chunkLength: 10 } },
      100,
    );
    expect(s.progress).toBeNull();
  });

  it("computes speed in bytes/second over the rolling sample window", () => {
    // Mutation captured: dividing by elapsed seconds rather than ms
    // (or dropping the *1000 conversion) would shrink the speed
    // reading by a factor of 1000 and fail this assertion.
    let s = reduceDownloadEvent(
      initialProgressState(),
      { event: "Started", data: { contentLength: 10_000_000 } },
      0,
    );
    s = reduceDownloadEvent(
      s,
      { event: "Progress", data: { chunkLength: 1_000_000 } },
      500, // 1 MB transferred over 500ms → 2 MB/s
    );
    expect(s.progress?.speed).toBe(2_000_000);
  });

  it("initializes speed timing when Started follows the synchronous seed state", () => {
    // Mutation captured: treating the seed as an in-flight download leaves
    // windowStartMs at 0, making the first speed sample effectively zero.
    const seed: ProgressReducerState = {
      ...initialProgressState(),
      progress: { phase: "downloading", downloaded: 0, total: null, speed: 0 },
    };
    let s = reduceDownloadEvent(
      seed,
      { event: "Started", data: { contentLength: 10_000_000 } },
      1000,
    );
    s = reduceDownloadEvent(
      s,
      { event: "Progress", data: { chunkLength: 1_000_000 } },
      1500,
    );
    expect(s.progress?.speed).toBe(2_000_000);
  });

  it("clamps the speed to zero when a clock-skew makes the math go negative", () => {
    // Mutation captured: removing the `< 0` clamp leaks a negative
    // speed reading to the dialog copy ("Downloading … · -3 MB/s"),
    // which is a UX bug we cover with a hard floor.
    let s = reduceDownloadEvent(
      initialProgressState(),
      { event: "Started", data: { contentLength: 100 } },
      1000,
    );
    // Simulate a clock that ticks backwards (skew). The reducer
    // should still hand back a non-negative speed.
    s = reduceDownloadEvent(s, { event: "Progress", data: { chunkLength: 50 } }, 500);
    expect(s.progress?.speed).toBeGreaterThanOrEqual(0);
  });

  it("Finished flips phase to installing and zeros the live speed reading", () => {
    // Mutation captured: leaving phase as "downloading" after
    // Finished would keep the progress bar visible while Tauri is
    // actually installing — the user would think the download stalled
    // at 100%.
    let s = reduceDownloadEvent(
      initialProgressState(),
      { event: "Started", data: { contentLength: 100 } },
      0,
    );
    s = reduceDownloadEvent(s, { event: "Progress", data: { chunkLength: 100 } }, 100);
    s = reduceDownloadEvent(s, { event: "Finished" }, 200);
    expect(s.progress?.phase).toBe("installing");
    expect(s.progress?.speed).toBe(0);
    // Downloaded counter persists so the install copy can keep the
    // last "X / X" reading visible while the installer runs.
    expect(s.progress?.downloaded).toBe(100);
  });

  it("handles Finished arriving before any Started/Progress (defensive)", () => {
    // Stray Finished events shouldn't crash the reducer — they just
    // produce a synthetic installing state with zero progress.
    const s = reduceDownloadEvent(initialProgressState(), { event: "Finished" }, 0);
    expect(s.progress?.phase).toBe("installing");
    expect(s.progress?.downloaded).toBe(0);
  });

  it("ignores negative chunkLength values defensively", () => {
    // Domain rule: the upstream event is supposed to be unsigned —
    // but a buggy proxy could feed garbage. The reducer must clamp
    // the chunk to zero so the cumulative downloaded count stays
    // monotonic.
    let s = reduceDownloadEvent(
      initialProgressState(),
      { event: "Started", data: { contentLength: 100 } },
      0,
    );
    s = reduceDownloadEvent(s, { event: "Progress", data: { chunkLength: -50 } } as DownloadEvent, 100);
    expect(s.progress?.downloaded).toBe(0);
  });

  it("a second Started mid-download does NOT reset downloaded (Windows redirect / 3G retry)", () => {
    // Regression: on a slow Windows/3G download the progress bar went
    // "back and forth" because every `Started` zeroed `downloaded`. The
    // Tauri updater can emit a second Started (the GitHub→CDN redirect hop
    // and the real download each fire one; flaky links also retry). The
    // extra Started must be a CONTINUATION, not a reset.
    // Mutation captured: reverting the Started case to always
    // `downloaded: 0` flips the post-redirect assertion from 40 to 0.
    let s = reduceDownloadEvent(initialProgressState(), { event: "Started", data: { contentLength: 100 } }, 0);
    s = reduceDownloadEvent(s, { event: "Progress", data: { chunkLength: 40 } }, 100);
    expect(s.progress?.downloaded).toBe(40);
    // Second Started arrives mid-stream.
    s = reduceDownloadEvent(s, { event: "Started", data: { contentLength: 100 } }, 150);
    expect(s.progress?.downloaded).toBe(40); // continuation, not reset
    expect(s.progress?.total).toBe(100);
    s = reduceDownloadEvent(s, { event: "Progress", data: { chunkLength: 30 } }, 250);
    expect(s.progress?.downloaded).toBe(70); // keeps climbing monotonically
  });

  it("a second Started adopts a total the first (redirect hop) lacked", () => {
    // Common Windows shape: the redirect hop's Started has no
    // content-length; the real download's Started carries it. We must
    // fill the total without disturbing the byte count.
    let s = reduceDownloadEvent(initialProgressState(), { event: "Started", data: {} }, 0);
    expect(s.progress?.total).toBeNull();
    s = reduceDownloadEvent(s, { event: "Progress", data: { chunkLength: 10 } }, 50);
    s = reduceDownloadEvent(s, { event: "Started", data: { contentLength: 5_000 } }, 100);
    expect(s.progress?.downloaded).toBe(10);
    expect(s.progress?.total).toBe(5_000);
  });

  it("a Started AFTER a (premature) Finished resumes — keeps bytes, recovers phase", () => {
    // The caller starts every install() with a FRESH reducer state
    // (initialProgressState), so a Started here is never a new run reusing a
    // finished state — it's the updater resuming after a premature Finished
    // (observed on macOS). Resetting to 0 is exactly the "indo e voltando" bug,
    // so keep the bytes and flip the phase back to downloading.
    let s = reduceDownloadEvent(initialProgressState(), { event: "Started", data: { contentLength: 100 } }, 0);
    s = reduceDownloadEvent(s, { event: "Progress", data: { chunkLength: 100 } }, 100);
    s = reduceDownloadEvent(s, { event: "Finished" }, 200);
    expect(s.progress?.phase).toBe("installing");
    s = reduceDownloadEvent(s, { event: "Started", data: { contentLength: 200 } }, 300);
    expect(s.progress?.downloaded).toBe(100); // resume, not reset
    expect(s.progress?.phase).toBe("downloading");
    expect(s.progress?.total).toBe(200); // grows to the larger resumed response
    // And it keeps accumulating from where it was.
    s = reduceDownloadEvent(s, { event: "Progress", data: { chunkLength: 25 } }, 350);
    expect(s.progress?.downloaded).toBe(125);
    const progress = s.progress;
    if (progress && progress.total !== null) {
      expect(progress.downloaded).toBeLessThanOrEqual(progress.total);
    }
  });

  it("a genuinely new run uses a fresh state and starts at 0", () => {
    // How the caller actually models a new download: a brand-new reducer state.
    const s = reduceDownloadEvent(
      initialProgressState(),
      { event: "Started", data: { contentLength: 200 } },
      0,
    );
    expect(s.progress?.downloaded).toBe(0);
    expect(s.progress?.total).toBe(200);
  });
});
