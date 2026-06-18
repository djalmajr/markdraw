// Pure decision function for the desktop window's `onCloseRequested`
// event. Extracted from the Tauri callback so the contract can be
// exercised in unit tests — the Tauri runtime would otherwise be
// untestable from bun without a full app shell.

import type { CloseBehavior } from "@markdraw/core/window-prefs.ts";

/**
 * Three outcomes — chosen because letting the Tauri default close
 * the window is NOT the same as quitting the app on macOS. The OS
 * keeps the process alive with zero windows, which is the wrong
 * behaviour when the user explicitly asked for "Quit app" via the
 * preference. We separate those concerns so the handler can pick
 * the right exit path:
 *
 * - `"hide"`        → `event.preventDefault()` + `window.hide()`
 *                     + drop the dock icon. Default "tray" route.
 * - `"exit"`        → user picked `"quit"`. The handler must call
 *                     `process.exit(0)` explicitly because on
 *                     macOS the window-X gesture wouldn't otherwise
 *                     terminate the process.
 * - `"let-close"`   → the updater bypass. The relaunch flow needs
 *                     the window to close so it can spawn the new
 *                     binary; `relaunch()` handles the actual exit
 *                     of the old process internally.
 */
type CloseAction = "hide" | "exit" | "let-close";

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
 *   3. Otherwise → `"hide"` (preserves the pre-DJA-50 close-to-tray
 *      default).
 */
function decideCloseAction(args: {
  closeBehavior: CloseBehavior;
  isUpdating: boolean;
}): CloseAction {
  if (args.isUpdating) return "let-close";
  if (args.closeBehavior === "quit") return "exit";
  return "hide";
}

export type { CloseAction };
export { decideCloseAction };
