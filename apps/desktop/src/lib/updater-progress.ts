// Pure reducer that folds a stream of Tauri updater download events
// into a UI-ready progress snapshot. Lives outside `updater.ts` so it
// can be unit-tested in `bun test` without pulling in the Tauri
// plugin (which only loads inside the webview).

import type { DownloadEvent } from "@tauri-apps/plugin-updater";

/** UI-shaped snapshot consumed by `<UpdateAvailableDialog>`. */
export interface DownloadProgress {
  phase: "downloading" | "installing";
  downloaded: number;
  /** `null` when the server didn't ship `content-length`; the dialog
   *  swaps to its indeterminate copy for this case. */
  total: number | null;
  /** Bytes per second over the rolling sample window. Clamped to
   *  >= 0 so a clock skew never surfaces a negative speed. */
  speed: number;
}

export interface ProgressReducerState {
  progress: DownloadProgress | null;
  lastTickMs: number;
  windowStartBytes: number;
  windowStartMs: number;
}

/** Window over which speed is averaged. 1s keeps the hint stable. */
const SPEED_WINDOW_MS = 1000;

export function initialProgressState(): ProgressReducerState {
  return { progress: null, lastTickMs: 0, windowStartBytes: 0, windowStartMs: 0 };
}

export function reduceDownloadEvent(
  state: ProgressReducerState,
  event: DownloadEvent,
  nowMs: number = Date.now(),
): ProgressReducerState {
  switch (event.event) {
    case "Started": {
      const total =
        typeof event.data.contentLength === "number" && event.data.contentLength > 0
          ? event.data.contentLength
          : null;
      const prev = state.progress;
      // A download already in flight that emits a SECOND `Started` must
      // not reset `downloaded` to 0 — that makes the bar jump backward
      // ("indo e voltando"). This happens on Windows (the updater follows
      // the GitHub asset → CDN redirect with a fresh request, so the redirect
      // hop and the real download each emit a `Started`) and on flaky 3G
      // links that retry. Treat the extra `Started` as a continuation: keep
      // the bytes already counted and only fill a `total` we didn't have yet
      // (the redirect hop often carries no content-length; the real one does).
      if (prev && prev.phase === "downloading") {
        return {
          ...state,
          progress: { ...prev, total: prev.total ?? total },
        };
      }
      return {
        progress: { phase: "downloading", downloaded: 0, total, speed: 0 },
        lastTickMs: nowMs,
        windowStartBytes: 0,
        windowStartMs: nowMs,
      };
    }
    case "Progress": {
      const prev = state.progress;
      if (!prev) return state;
      const chunk = Math.max(0, event.data.chunkLength);
      const downloaded = prev.downloaded + chunk;
      const elapsedMs = Math.max(1, nowMs - state.windowStartMs);
      let speed = ((downloaded - state.windowStartBytes) * 1000) / elapsedMs;
      let { windowStartBytes, windowStartMs } = state;
      if (elapsedMs >= SPEED_WINDOW_MS) {
        windowStartBytes = downloaded;
        windowStartMs = nowMs;
      }
      if (!Number.isFinite(speed) || speed < 0) speed = 0;
      return {
        progress: { ...prev, downloaded, speed },
        lastTickMs: nowMs,
        windowStartBytes,
        windowStartMs,
      };
    }
    case "Finished": {
      const prev = state.progress ?? {
        phase: "downloading" as const,
        downloaded: 0,
        total: null,
        speed: 0,
      };
      return {
        progress: { ...prev, phase: "installing", speed: 0 },
        lastTickMs: nowMs,
        windowStartBytes: state.windowStartBytes,
        windowStartMs: state.windowStartMs,
      };
    }
  }
}
