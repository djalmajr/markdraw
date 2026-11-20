import { beforeEach, describe, expect, it } from "bun:test";
import {
  getStoredCloseBehavior,
  getStoredShowTrayIcon,
  setStoredCloseBehavior,
  setStoredShowTrayIcon,
} from "./window-prefs.ts";
import { installLocalStorageMock } from "./test-utils.ts";

installLocalStorageMock();

describe("window preferences defaults", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("closeBehavior defaults to 'tray' when nothing is stored", () => {
    // Mutation captured: flipping the default to `"quit"` would
    // make every existing user's first close after upgrade quit
    // the app instead of minimising — silent behaviour change.
    // Default must be `"tray"` to preserve the current contract.
    expect(getStoredCloseBehavior()).toBe("tray");
  });

  it("showTrayIcon defaults to on when nothing is stored", () => {
    // Mutation captured: defaulting to off would remove the tray from
    // every existing install on upgrade, changing the close gesture
    // with no user action.
    expect(getStoredShowTrayIcon()).toBe(true);
  });
});

describe("window preferences round-trip", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips 'true' and 'false' for the tray icon", () => {
    // Mutation captured: a setter that always wrote "true" would leave
    // the toggle stuck on after the user turned it off.
    setStoredShowTrayIcon(false);
    expect(localStorage.getItem("markdraw-window-tray-icon")).toBe("false");
    expect(getStoredShowTrayIcon()).toBe(false);
    setStoredShowTrayIcon(true);
    expect(localStorage.getItem("markdraw-window-tray-icon")).toBe("true");
    expect(getStoredShowTrayIcon()).toBe(true);
  });

  it("round-trips both 'tray' and 'quit'", () => {
    // Mutation captured: a setter that always stores `"tray"` (or
    // a getter that ignores the stored value) would leave the
    // toggle appearing stuck after a user switched to `"quit"`.
    setStoredCloseBehavior("quit");
    expect(getStoredCloseBehavior()).toBe("quit");
    setStoredCloseBehavior("tray");
    expect(getStoredCloseBehavior()).toBe("tray");
  });
});

describe("window preferences invalid stored values", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("falls back to on when the tray-icon value is not in the whitelist", () => {
    localStorage.setItem("markdraw-window-tray-icon", "yes");
    expect(getStoredShowTrayIcon()).toBe(true);
    localStorage.setItem("markdraw-window-tray-icon", "");
    expect(getStoredShowTrayIcon()).toBe(true);
  });

  it("falls back to 'tray' when stored value is not in the whitelist", () => {
    // Mutation captured: dropping the
    // `stored === "tray" || stored === "quit"` whitelist would
    // forward an arbitrary localStorage payload (corrupted by
    // another script or a stale schema) into the close handler.
    // The decision function would then hit an unhandled branch
    // and likely default to `"hide"` regardless, but explicit
    // fallback here keeps the contract local.
    localStorage.setItem("markdraw-window-close-behavior", "minimize");
    expect(getStoredCloseBehavior()).toBe("tray");
    localStorage.setItem("markdraw-window-close-behavior", "");
    expect(getStoredCloseBehavior()).toBe("tray");
  });
});
