import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask, message } from "@tauri-apps/plugin-dialog";

/**
 * Check for an app update via the Tauri updater plugin and show a native
 * dialog when one is available.
 *
 * When `silent` is true, errors and the "you're up to date" case are
 * swallowed (used for the startup check, where any noise would be
 * disruptive). When `silent` is false (manual menu action), the user gets
 * feedback in either case.
 */
export async function checkForAppUpdates(silent: boolean): Promise<void> {
  try {
    const update = await check();

    if (!update) {
      if (!silent) {
        await message("You are on the latest version of AsciiMark.", {
          title: "AsciiMark",
          kind: "info",
        });
      }
      return;
    }

    const notes = update.body?.trim() ?? "";
    const promptBody =
      `AsciiMark ${update.version} is available (current: ${update.currentVersion}).`
      + (notes ? `\n\n${notes}` : "");

    const accepted = await ask(promptBody, {
      title: "Update available",
      kind: "info",
      okLabel: "Install and restart",
      cancelLabel: "Later",
    });

    if (!accepted) return;

    // Signal the close-to-tray handler to allow the window to actually close
    // instead of hiding. Without this, relaunch gets stuck because
    // onCloseRequested prevents the exit.
    (window as any).__asciimark_updating = true;

    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    console.error("Update check failed:", e);
    if (!silent) {
      await message(
        `Failed to check for updates: ${(e as Error)?.message ?? String(e)}`,
        {
          title: "AsciiMark",
          kind: "error",
        },
      );
    }
  }
}
