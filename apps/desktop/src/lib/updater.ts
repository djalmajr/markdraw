import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import * as m from "@markdraw/i18n";
import {
  initialProgressState,
  reduceDownloadEvent,
  type DownloadProgress,
  type ProgressReducerState,
} from "./updater-progress.ts";

// Best-effort handle drain before relaunch. The Rust side has two
// file watchers (`WatcherHolder`, `DirWatcherHolder`) plus the
// tauri_plugin_single_instance lock. If the OS hasn't released
// those by the time `relaunch()` spawns the new binary, the new
// process sees the old as still alive and the single-instance
// plugin silently exits — the user observes "freeze on relaunch"
// and has to force-quit before reopening. Stopping watchers + a
// short settling delay reliably avoids the race on macOS.
//
// Exported so the test suite can verify both invoke targets are
// called; the settling window is intentionally not asserted
// (timing-dependent) — it's documented here.
//
// Window: 250ms was enough on a real macOS bundle, but Windows users
// reported "freeze on relaunch, must reopen" — the single-instance
// lock + the NSIS installer's own restart take longer to release
// there, so the freshly relaunched process loses the single-instance
// race and exits. Bumped to 600ms for more headroom on Windows; the
// exact value is being validated against a real Windows auto-update.
export async function drainBeforeRelaunch(): Promise<void> {
  try {
    await Promise.allSettled([invoke("stop_watching"), invoke("stop_watching_dirs")]);
  } catch {
    // Best effort — if either command isn't available or errors,
    // we still want the relaunch to proceed.
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 600));
}

export type { DownloadProgress };

/**
 * State surfaced to the host (`apps/desktop/src/app.tsx`) so it can
 * render the in-app `<UpdateAvailableDialog>`. The native Tauri
 * `ask()` dialog used to handle this, but it can't scroll the body
 * — long changelogs pushed the action buttons off-screen. The
 * custom dialog renders the notes inside a flex layout with a
 * scrollable body and a sticky footer.
 *
 * Shape:
 *   `null`  — no pending update.
 *   object  — an update is pending; the host shows the dialog.
 *
 * The host wires its accept/dismiss handlers via this signal:
 *   - `update.install()` — calls downloadAndInstall + relaunch.
 *   - `setPending(null)` — closes the dialog.
 */
export interface PendingUpdate {
  version: string;
  currentVersion: string;
  notes: string;
  install: () => Promise<void>;
}

const [pendingUpdate, setPendingUpdate] = createSignal<PendingUpdate | null>(null);
const [downloadProgress, setDownloadProgress] = createSignal<DownloadProgress | null>(null);

interface InstallUpdateOptions {
  downloadTimeoutMs?: number;
}

// Tauri's DownloadOptions.timeout is the total HTTP request timeout: it has no
// separate first-byte/idle timeout, and the download is not cancellable. Use 1h
// so ~30MB still fits on very slow ~8 KB/s links, while a true infinite stall
// remains a finite rejection into the normal catch path.
const UPDATE_DOWNLOAD_TIMEOUT_MS = 3_600_000;

// Guards against a second `downloadAndInstall` running concurrently — e.g. a
// double-click on Install before the first event swaps the buttons for the
// progress bar. Two in-flight downloads would write the SAME progress signal
// from two independent reducer states, making `downloaded` oscillate.
let downloadInFlight = false;
let installOperationId = 0;

export const useUpdate = pendingUpdate;
export const useDownloadProgress = downloadProgress;
export const dismissUpdate = () => {
  setPendingUpdate(null);
  setDownloadProgress(null);
};


// Dev-only: lets the test harness simulate a pending update without
// actually hitting the network or installing anything. Wired via the
// `__DEV__` helper in `app.tsx` only when `import.meta.env.DEV`.
export function _devSetPendingUpdate(value: PendingUpdate | null): void {
  setPendingUpdate(value);
}

// Dev-only: directly drives the download progress signal so the
// progress UI can be exercised without hitting the network. Used by
// the in-app Tauri MCP validation harness for DJA-34.
export function _devSetDownloadProgress(value: DownloadProgress | null): void {
  setDownloadProgress(value);
}

/**
 * Download + install a pending update, driving the progress signal. Exported so
 * the failure-recovery path is unit-testable.
 *
 * Reentrancy guarded (`downloadInFlight`): the dialog keeps the Install button
 * visible until the first event swaps it for the bar, so a double-click would
 * otherwise start a SECOND download — two reducer states writing one signal make
 * `downloaded` oscillate.
 *
 * A post-progress rejection (download, signature check, install, drain, or
 * relaunch) MUST restore the UI: the dialog hides Install/Later and blocks
 * dismissal while `downloadProgress` is set, so a stale bar would strand the user
 * with no retry. The catch clears progress, undoes the close-to-tray override
 * (no relaunch is happening), and surfaces the error.
 */
export async function installUpdate(
  update: Pick<Update, "downloadAndInstall">,
  options: InstallUpdateOptions = {},
): Promise<void> {
  if (downloadInFlight) return;
  downloadInFlight = true;
  const operationId = ++installOperationId;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? UPDATE_DOWNLOAD_TIMEOUT_MS;
  const isOperationActive = () => downloadInFlight && operationId === installOperationId;
  const markUpdating = (v: boolean) => {
    (window as unknown as { __markdraw_updating?: boolean }).__markdraw_updating = v;
  };
  // Let the close-to-tray handler actually close the window so relaunch works.
  markUpdating(true);
  // Lock the dialog SYNCHRONOUSLY, before any await: it blocks dismissal and
  // hides Later only while `downloadProgress` is non-null, and the updater's
  // first event can lag behind a slow CDN handshake. Without seeding a 0%
  // downloading state here, clicking Install then Later/Esc in that gap clears
  // the pending update while the install keeps running in the background.
  let state: ProgressReducerState = {
    ...initialProgressState(),
    progress: { phase: "downloading" as const, downloaded: 0, total: null, speed: 0 },
  };
  setDownloadProgress(state.progress);
  let installed = false;
  try {
    await update.downloadAndInstall(
      (event) => {
        if (!isOperationActive()) return;
        state = reduceDownloadEvent(state, event);
        setDownloadProgress(state.progress);
      },
      { timeout: downloadTimeoutMs },
    );
    installed = true;
    if (!isOperationActive()) return;
    await drainBeforeRelaunch();
    await relaunch();
  } catch (e) {
    if (!isOperationActive()) return;
    setDownloadProgress(null);
    markUpdating(false);
    if (installed) {
      setPendingUpdate(null);
      console.error("Update installed but restart failed:", e);
      await message(m.update_installed_restart_manually(), {
        title: "Markdraw",
        kind: "info",
      });
      return;
    }
    console.error("Update install failed:", e);
    await message(m.update_install_failed({ message: (e as Error)?.message ?? String(e) }), {
      title: "Markdraw",
      kind: "error",
    });
  } finally {
    if (operationId === installOperationId) {
      downloadInFlight = false;
    }
  }
}

/**
 * Check for an app update via the Tauri updater plugin.
 *
 * On success with a pending update: surfaces the update via the
 * `useUpdate` signal so the host renders the in-app dialog.
 *
 * `silent` true (startup check) — swallows "already up to date" and
 * transient errors. `silent` false (manual check via menu/palette) —
 * shows a native `message()` toast for both states so the user gets
 * feedback after a manual action.
 */
export async function checkForAppUpdates(silent: boolean): Promise<void> {
  try {
    const update: Update | null = await check();

    if (!update) {
      if (!silent) {
        await message(m.update_up_to_date(), {
          title: "Markdraw",
          kind: "info",
        });
      }
      return;
    }

    // Make sure the window is visible and focused before surfacing the
    // dialog. On Windows, users reported the modal's buttons not
    // responding to clicks (only Tab+Enter worked) — a classic symptom
    // of WebView2 swallowing pointer input on an unfocused/background
    // window (the startup check fires 3s after boot, and the window may
    // be in the tray or behind another app). Show + focus first so the
    // first click lands on the button instead of just activating the
    // window.
    try {
      // Dynamic import so test files that load updater.ts (drain /
      // progress) don't drag the window module — and its core
      // `SERIALIZE_TO_IPC_FN` import — into their mocked graph.
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      await win.show();
      await win.unminimize();
      await win.setFocus();
    } catch {
      // Best effort — never block the update prompt on a focus hiccup.
    }

    setPendingUpdate({
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body?.trim() ?? "",
      install: () => installUpdate(update),
    });
  } catch (e) {
    if (silent) return;
    console.error("Update check failed:", e);
    await message(
      m.update_check_failed({ message: (e as Error)?.message ?? String(e) }),
      {
        title: "Markdraw",
        kind: "error",
      },
    );
  }
}
