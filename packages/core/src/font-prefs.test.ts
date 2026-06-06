import { beforeEach, describe, expect, it } from "bun:test";
import {
  applyFontPrefs,
  FontFamilies,
  FontSizes,
  getStoredFontPrefs,
  setStoredFontPrefs,
  type FontPrefs,
} from "./font-prefs.ts";
import { installDocumentMock, installLocalStorageMock } from "./test-utils.ts";

installLocalStorageMock();
const docEl = installDocumentMock();

describe("font preferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns sensible defaults when storage is empty", () => {
    expect(getStoredFontPrefs()).toEqual({ fontSize: 15, fontFamily: "sans-serif" });
  });

  it("merges stored partial values onto defaults so adding new keys later won't break older clients", () => {
    localStorage.setItem("asciimark-font-prefs", JSON.stringify({ fontSize: 18 }));
    expect(getStoredFontPrefs()).toEqual({ fontSize: 18, fontFamily: "sans-serif" });
  });

  it("falls back to defaults when storage is corrupted", () => {
    localStorage.setItem("asciimark-font-prefs", "{not json");
    expect(getStoredFontPrefs()).toEqual({ fontSize: 15, fontFamily: "sans-serif" });
  });

  it("setStoredFontPrefs round-trips", () => {
    const prefs: FontPrefs = { fontFamily: "serif", fontSize: 20 };
    setStoredFontPrefs(prefs);
    expect(getStoredFontPrefs()).toEqual(prefs);
  });

  it("applyFontPrefs writes the matching CSS custom properties on documentElement", () => {
    applyFontPrefs({ fontFamily: "monospace", fontSize: 16 });
    expect(docEl.style.getPropertyValue("--doc-font-size")).toBe("16px");
    expect(docEl.style.getPropertyValue("--doc-font-family")).toBe("var(--font-mono)");

    applyFontPrefs({ fontFamily: "serif", fontSize: 14 });
    expect(docEl.style.getPropertyValue("--doc-font-family")).toContain("Georgia");

    applyFontPrefs({ fontFamily: "sans-serif", fontSize: 13 });
    expect(docEl.style.getPropertyValue("--doc-font-family")).toBe("var(--font-sans)");
  });

  it("falls back to sans when family is unknown (forward-compat)", () => {
    applyFontPrefs({ fontFamily: "comic-sans", fontSize: 15 });
    expect(docEl.style.getPropertyValue("--doc-font-family")).toBe("var(--font-sans)");
  });

  it("exposes a stable list of supported families and sizes for the UI", () => {
    expect(FontFamilies.map((f) => f.id)).toEqual(["sans-serif", "serif", "monospace"]);
    expect([...FontSizes]).toEqual([13, 14, 15, 16, 18, 20, 24, 28, 32, 40, 48]);
  });
});
