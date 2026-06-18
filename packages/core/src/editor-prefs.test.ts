import { beforeEach, describe, expect, it } from "bun:test";
import {
  getStoredIndentMode,
  getStoredIndentSize,
  getStoredLineNumbers,
  getStoredShowInvisibles,
  getStoredSyncScroll,
  getStoredTableWrap,
  getStoredWrapText,
  setStoredIndentMode,
  setStoredIndentSize,
  setStoredLineNumbers,
  setStoredShowInvisibles,
  setStoredSyncScroll,
  setStoredTableWrap,
  setStoredWrapText,
} from "./editor-prefs.ts";
import { installLocalStorageMock } from "./test-utils.ts";

installLocalStorageMock();

describe("editor preferences defaults", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("default to user-friendly values when nothing is stored", () => {
    expect(getStoredWrapText()).toBe(true);
    expect(getStoredLineNumbers()).toBe(true);
    expect(getStoredShowInvisibles()).toBe(false);
    expect(getStoredSyncScroll()).toBe(true);
    expect(getStoredIndentMode()).toBe("spaces");
    expect(getStoredIndentSize()).toBe(2);
    // Wide tables wrap to fit the width by default so they stay readable
    // without a horizontal scrollbar; scrolling is the opt-out.
    expect(getStoredTableWrap()).toBe(true);
  });
});

describe("editor preferences round-trip", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("boolean prefs round-trip both true and false", () => {
    for (const value of [true, false]) {
      setStoredWrapText(value);
      expect(getStoredWrapText()).toBe(value);

      setStoredLineNumbers(value);
      expect(getStoredLineNumbers()).toBe(value);

      setStoredShowInvisibles(value);
      expect(getStoredShowInvisibles()).toBe(value);

      setStoredSyncScroll(value);
      expect(getStoredSyncScroll()).toBe(value);

      setStoredTableWrap(value);
      expect(getStoredTableWrap()).toBe(value);
    }
  });

  it("indent mode round-trips for tabs and spaces", () => {
    setStoredIndentMode("tabs");
    expect(getStoredIndentMode()).toBe("tabs");
    setStoredIndentMode("spaces");
    expect(getStoredIndentMode()).toBe("spaces");
  });

  it("indent size round-trips for 2 and 4", () => {
    setStoredIndentSize(4);
    expect(getStoredIndentSize()).toBe(4);
    setStoredIndentSize(2);
    expect(getStoredIndentSize()).toBe(2);
  });
});

describe("editor preferences invalid stored values", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("falls back to default when boolean string is malformed", () => {
    localStorage.setItem("markdraw-editor-wrap-text", "yes");
    expect(getStoredWrapText()).toBe(false);
  });

  it("falls back to 'spaces' when stored indent mode is invalid", () => {
    localStorage.setItem("markdraw-editor-indent-mode", "tab");
    expect(getStoredIndentMode()).toBe("spaces");
  });

  it("falls back to 2 when stored indent size is not 2 or 4", () => {
    localStorage.setItem("markdraw-editor-indent-size", "8");
    expect(getStoredIndentSize()).toBe(2);
    localStorage.setItem("markdraw-editor-indent-size", "garbage");
    expect(getStoredIndentSize()).toBe(2);
  });
});
