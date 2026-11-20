import { describe, expect, it } from "bun:test";
import { decideCloseAction } from "./window-close.ts";

const LINUX = "Linux x86_64";
const WINDOWS = "Win32";
const MAC = "MacIntel";

describe("decideCloseAction", () => {
  it("default 'tray' setting hides the window when the updater is idle", () => {
    // Mutation captured: dropping the `return "hide"` fallback (e.g.
    // flipping the default to "let-close") would make the standard
    // window-X click quit the app for every user on the default
    // setting — a silent regression of the pre-DJA-50 behaviour.
    expect(
      decideCloseAction({ closeBehavior: "tray", isUpdating: false, trayAvailable: true, platform: LINUX }),
    ).toBe("hide");
  });

  it("'quit' setting returns 'exit' so macOS actually terminates the process", () => {
    // Mutation captured: returning `"let-close"` here (the old
    // 2-state contract) would only close the WINDOW on macOS, not
    // the app — the user toggles "Quit app", presses X, and the
    // process keeps running window-less. `"exit"` forces the
    // handler down the `process.exit(0)` path which kills the
    // process on every platform.
    expect(
      decideCloseAction({ closeBehavior: "quit", isUpdating: false, trayAvailable: true, platform: MAC }),
    ).toBe("exit");
  });

  it("Windows and Linux minimize instead of hiding when there is no tray icon", () => {
    // Mutation captured: hiding without a tray icon (setting it up failed,
    // e.g. a Linux session with no StatusNotifierItem host, or the user
    // turned the icon off) leaves the app running with no taskbar/window
    // way back; quitting instead could drop unsaved work in other panes.
    for (const platform of [WINDOWS, LINUX]) {
      expect(
        decideCloseAction({ closeBehavior: "tray", isUpdating: false, trayAvailable: false, platform }),
      ).toBe("minimize");
    }
  });

  it("macOS hides but keeps the Dock icon when there is no tray icon", () => {
    // Mutation captured: reusing the Windows/Linux `"minimize"` branch
    // here would leave a hidden macOS window with no restore affordance
    // once `set_dock_visible(false)` ran; returning plain `"hide"` would
    // drop the Dock icon and lose the last way back.
    expect(
      decideCloseAction({ closeBehavior: "tray", isUpdating: false, trayAvailable: false, platform: MAC }),
    ).toBe("hide-keep-dock");
  });

  it("updater bypass forces let-close even when the user picked 'tray'", () => {
    // Mutation captured: dropping the `if (args.isUpdating)` guard
    // would re-introduce the freeze fixed in 558de26 — the
    // Tauri updater needs the window to actually close so the
    // relaunched binary can take over. A "hide" return here would
    // strand the install half-applied, and "exit" here would
    // pre-empt the relaunch's own exit logic.
    expect(
      decideCloseAction({ closeBehavior: "tray", isUpdating: true, trayAvailable: false, platform: LINUX }),
    ).toBe("let-close");
  });

  it("updater bypass beats the 'quit' setting too", () => {
    // Precedence test: `isUpdating` must win over `closeBehavior`.
    // A handler that called `exit(0)` mid-relaunch would terminate
    // the old process BEFORE the new one finished spawning, which
    // on Windows tends to corrupt the updater's swap. `"let-close"`
    // here defers the exit to `relaunch()`'s own teardown.
    expect(
      decideCloseAction({ closeBehavior: "quit", isUpdating: true, trayAvailable: true, platform: WINDOWS }),
    ).toBe("let-close");
  });
});
