// Pure decision function for the desktop window's `onCloseRequested`
// event. Extracted from the Tauri callback so the contract can be
// exercised in unit tests — the Tauri runtime would otherwise be
// untestable from bun without a full app shell.

import type { CloseBehavior } from "@markdraw/core/window-prefs.ts";

/**
 * Five outcomes — chosen because letting the Tauri default close
 * the window is NOT the same as quitting the app on macOS. The OS
 * keeps the process alive with zero windows, which is the wrong
 * behaviour when the user explicitly asked for "Quit app" via the
 * preference. We separate those concerns so the handler can pick
 * the right exit path:
 *
 * - `"hide"`        → `event.preventDefault()` + `window.hide()`
 *                     + drop the dock icon. Default "tray" route.
 * - `"hide-keep-dock"` → `event.preventDefault()` + `window.hide()`,
 *                     leaving the Dock icon alone. macOS with no tray:
 *                     the Dock is the only way back.
 * - `"exit"`        → user picked `"quit"`. The handler must call
 *                     `process.exit(0)` explicitly because on
 *                     macOS the window-X gesture wouldn't otherwise
 *                     terminate the process.
 * - `"minimize"`    → `event.preventDefault()` + `window.minimize()`:
 *                     the "tray" setting with no tray icon to come back
 *                     from on Windows/Linux.
 * - `"let-close"`   → the updater bypass. The relaunch flow needs
 *                     the window to close so it can spawn the new
 *                     binary; `relaunch()` handles the actual exit
 *                     of the old process internally.
 */
type CloseAction = "hide" | "hide-keep-dock" | "minimize" | "exit" | "let-close";

/**
 * Decide what to do when the OS asks the window to close. Order of
 * precedence:
 *
 *   1. `isUpdating === true` always wins → `"let-close"`. The
 *      updater flow needs the window down so `relaunch()` can take
 *      over without competing windows.
 *   2. `closeBehavior === "quit"` → `"exit"`. User asked us to
 *      terminate; we'll do it explicitly so macOS doesn't leave
 *      the process running window-less.
 *   3. No tray icon to bring the window back (`trayAvailable === false`:
 *      the user turned it off, or setup failed, e.g. a Linux session
 *      with no StatusNotifierItem host). Windows/Linux → `"minimize"`:
 *      hiding would leave the app running with no way back. macOS →
 *      `"hide-keep-dock"`: the Dock icon stays, so clicking it reopens
 *      the window (RunEvent::Reopen). Quitting here could drop unsaved
 *      work the user never chose to discard.
 *   4. Otherwise → `"hide"` (preserves the pre-DJA-50 close-to-tray
 *      default).
 */
function decideCloseAction(args: {
  closeBehavior: CloseBehavior;
  isUpdating: boolean;
  trayAvailable: boolean;
  platform: string;
}): CloseAction {
  if (args.isUpdating) return "let-close";
  if (args.closeBehavior === "quit") return "exit";
  if (!args.trayAvailable) {
    return args.platform.startsWith("Mac") ? "hide-keep-dock" : "minimize";
  }
  return "hide";
}

export type { CloseAction };
export { decideCloseAction };
