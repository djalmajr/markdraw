import { describe, expect, it } from "bun:test";
import {
  applyCodeTheme,
  CodeThemes,
  getStoredCodeTheme,
  setStoredCodeTheme,
} from "./code-theme.ts";
import { installDocumentMock } from "./test-utils.ts";

const docEl = installDocumentMock();

describe("code theme (single-theme mode)", () => {
  it("getStoredCodeTheme always returns the single supported id", () => {
    expect(getStoredCodeTheme()).toBe("github-light");
  });

  it("setStoredCodeTheme is a no-op (doesn't throw and doesn't change result)", () => {
    setStoredCodeTheme("anything-else");
    expect(getStoredCodeTheme()).toBe("github-light");
  });

  it("applyCodeTheme writes the data-code-theme attribute on documentElement", () => {
    applyCodeTheme("anything", false);
    expect(docEl.getAttribute("data-code-theme")).toBe("github-light");
    applyCodeTheme("ignored", true);
    expect(docEl.getAttribute("data-code-theme")).toBe("github-light");
  });

  it("CodeThemes lists at least one option for the UI to render", () => {
    expect(CodeThemes.length).toBeGreaterThan(0);
    expect(CodeThemes[0]).toHaveProperty("id");
    expect(CodeThemes[0]).toHaveProperty("label");
  });
});
