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
      const isSyntheticSeed =
        prev?.phase === "downloading" &&
        prev.downloaded === 0 &&
        prev.total === null &&
        prev.speed === 0 &&
        state.lastTickMs === 0 &&
        state.windowStartBytes === 0 &&
        state.windowStartMs === 0;
      // Once a real download is under way, extra `Started` events are a
      // CONTINUATION, never a reset — zeroing `downloaded` is what makes the bar
      // jump backward ("indo e voltando"). The caller may seed a synthetic 0%
      // state before the first event; that still needs the normal first-Started
      // timing setup so speed samples do not use epoch zero as their window.
      if (prev && !isSyntheticSeed) {
        const nextTotal =
          prev.total === null && total === null
            ? null
            : Math.max(prev.total ?? 0, total ?? 0, prev.downloaded);
        return {
          ...state,
          progress: { ...prev, phase: "downloading", total: nextTotal },
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
