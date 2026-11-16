import { describe, expect, it } from "bun:test";
import { hidesNativeMenuBar, usesCustomWindowFrame } from "./window-frame.ts";

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
