import { describe, expect, it } from "bun:test";
import { decideCloseAction } from "./window-close.ts";

describe("decideCloseAction", () => {
  it("default 'tray' setting hides the window when the updater is idle", () => {
    // Mutation captured: dropping the `return "hide"` fallback (e.g.
    // flipping the default to "let-close") would make the standard
    // window-X click quit the app for every user on the default
    // setting — a silent regression of the pre-DJA-50 behaviour.
    expect(
      decideCloseAction({ closeBehavior: "tray", isUpdating: false, trayAvailable: true }),
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
      decideCloseAction({ closeBehavior: "quit", isUpdating: false, trayAvailable: true }),
    ).toBe("exit");
  });

  it("'tray' setting minimizes instead of hiding when there is no tray icon", () => {
    // Mutation captured: hiding without a tray icon (setting it up failed,
    // e.g. a Linux session with no StatusNotifierItem host) leaves the app
    // running with no way back to the window; quitting instead could drop
    // unsaved work in other panes or a pending autosave.
    expect(
      decideCloseAction({ closeBehavior: "tray", isUpdating: false, trayAvailable: false }),
    ).toBe("minimize");
    // The updater bypass still wins without a tray.
    expect(
      decideCloseAction({ closeBehavior: "tray", isUpdating: true, trayAvailable: false }),
    ).toBe("let-close");
  });

  it("updater bypass forces let-close even when the user picked 'tray'", () => {
    // Mutation captured: dropping the `if (args.isUpdating)` guard
    // would re-introduce the freeze fixed in 558de26 — the
    // Tauri updater needs the window to actually close so the
    // relaunched binary can take over. A "hide" return here would
    // strand the install half-applied, and "exit" here would
    // pre-empt the relaunch's own exit logic.
    expect(
      decideCloseAction({ closeBehavior: "tray", isUpdating: true, trayAvailable: true }),
    ).toBe("let-close");
  });

  it("updater bypass beats the 'quit' setting too", () => {
    // Precedence test: `isUpdating` must win over `closeBehavior`.
    // A handler that called `exit(0)` mid-relaunch would terminate
    // the old process BEFORE the new one finished spawning, which
    // on Windows tends to corrupt the updater's swap. `"let-close"`
    // here defers the exit to `relaunch()`'s own teardown.
    expect(
      decideCloseAction({ closeBehavior: "quit", isUpdating: true, trayAvailable: true }),
    ).toBe("let-close");
  });
});
