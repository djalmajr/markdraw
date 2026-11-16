import { describe, expect, it } from "bun:test";
import {
  ALL_WINDOW_CAPABILITIES,
  captionButtonsInset,
  hidesNativeMenuBar,
  usesCustomWindowFrame,
} from "./window-frame.ts";

// `navigator.platform` values as reported by each webview.
const LINUX = "Linux x86_64";
const WINDOWS = "Win32";
const MAC = "MacIntel";

describe("usesCustomWindowFrame", () => {
  it("Linux draws its own caption buttons", () => {
    // Mutation captured: dropping the Linux branch brings back the stacked
    // GTK header bar + in-app controls (two sets of min/max/close).
    expect(usesCustomWindowFrame(LINUX)).toBe(true);
  });

  it("Windows draws its own caption buttons", () => {
    expect(usesCustomWindowFrame(WINDOWS)).toBe(true);
  });

  it("macOS keeps the native traffic lights", () => {
    // Mutation captured: returning true everywhere would paint Windows-style
    // buttons next to the macOS traffic lights.
    expect(usesCustomWindowFrame(MAC)).toBe(false);
  });
});

describe("hidesNativeMenuBar", () => {
  it("hides the GTK menu bar on Linux only", () => {
    // Mutation captured: never hiding it leaves the File/Edit/View bar under
    // the toolbar; hiding it on macOS would target the system menu bar.
    expect(hidesNativeMenuBar(LINUX)).toBe(true);
    expect(hidesNativeMenuBar(WINDOWS)).toBe(false);
    expect(hidesNativeMenuBar(MAC)).toBe(false);
  });
});

describe("captionButtonsInset", () => {
  it("reserves room for all three buttons when the compositor supports them", () => {
    expect(captionButtonsInset(ALL_WINDOW_CAPABILITIES)).toBe("138px");
  });

  it("shrinks when the compositor can't minimize (e.g. Hyprland)", () => {
    // Mutation captured: ignoring `minimize` keeps a 46px gap where the
    // hidden button used to be.
    expect(captionButtonsInset({ minimize: false, maximize: true })).toBe("92px");
  });

  it("always keeps the close button", () => {
    expect(captionButtonsInset({ minimize: false, maximize: false })).toBe("46px");
  });
});
