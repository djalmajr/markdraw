import { beforeEach, describe, expect, it } from "bun:test";
import {
  getStoredRespectGitignore,
  getStoredShowAllDirs,
  getStoredShowAllFiles,
  getStoredShowHiddenEntries,
  setStoredRespectGitignore,
  setStoredShowAllDirs,
  setStoredShowAllFiles,
  setStoredShowHiddenEntries,
} from "./file-tree-prefs.ts";
import { installLocalStorageMock } from "./test-utils.ts";

installLocalStorageMock();

describe("file-tree preferences defaults", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("respectGitignore defaults to true when nothing is stored", () => {
    // Mutation captured: flipping the default to `false` (e.g. by
    // forgetting to pass `true` to `getStoredStrictBoolean`) would
    // surprise upgrading users with a stricter file tree until they
    // discovered the toggle. Spec calls for ON by default.
    expect(getStoredRespectGitignore()).toBe(true);
  });

  it("showHiddenEntries defaults to true when nothing is stored", () => {
    // Mutation captured: passing `false` as the default would hide
    // dotfiles for fresh profiles even though the spec calls for the
    // visibility toggles to start ON.
    expect(getStoredShowHiddenEntries()).toBe(true);
  });

  it("showAllDirs defaults to true when nothing is stored", () => {
    // Mutation captured: passing `false` as the default would filter
    // out non-content directories for fresh profiles even though the
    // spec calls for the visibility toggles to start ON.
    expect(getStoredShowAllDirs()).toBe(true);
  });

  it("showAllFiles defaults to true when nothing is stored", () => {
    // Mutation captured: passing `false` as the default would filter
    // out non-markdown files for fresh profiles even though the spec
    // calls for the visibility toggles to start ON.
    expect(getStoredShowAllFiles()).toBe(true);
  });
});

describe("file-tree preferences round-trip", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips both true and false", () => {
    // Mutation captured: dropping the setter's `localStorage.setItem`
    // call would leave the getter returning the default forever, so
    // the toggle would appear stuck. Verifying both directions
    // ensures the persistence channel is wired both ways.
    setStoredRespectGitignore(false);
    expect(getStoredRespectGitignore()).toBe(false);
    setStoredRespectGitignore(true);
    expect(getStoredRespectGitignore()).toBe(true);
  });

  it("round-trips showHiddenEntries in both directions", () => {
    // Mutation captured: a setter writing to the wrong key (or not
    // writing at all) would leave the getter pinned to the default,
    // so the toggle would appear stuck across restarts.
    setStoredShowHiddenEntries(false);
    expect(getStoredShowHiddenEntries()).toBe(false);
    setStoredShowHiddenEntries(true);
    expect(getStoredShowHiddenEntries()).toBe(true);
  });

  it("round-trips showAllDirs in both directions", () => {
    // Mutation captured: a setter writing to the wrong key (or not
    // writing at all) would leave the getter pinned to the default,
    // so the toggle would appear stuck across restarts.
    setStoredShowAllDirs(false);
    expect(getStoredShowAllDirs()).toBe(false);
    setStoredShowAllDirs(true);
    expect(getStoredShowAllDirs()).toBe(true);
  });

  it("round-trips showAllFiles in both directions", () => {
    // Mutation captured: a setter writing to the wrong key (or not
    // writing at all) would leave the getter pinned to the default,
    // so the toggle would appear stuck across restarts.
    setStoredShowAllFiles(false);
    expect(getStoredShowAllFiles()).toBe(false);
    setStoredShowAllFiles(true);
    expect(getStoredShowAllFiles()).toBe(true);
  });
});

describe("file-tree preferences invalid stored values", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("falls back to default true when stored value is malformed", () => {
    // Mutation captured: a relaxed parse like
    // `stored !== "false"` would accept "yes" / "1" / arbitrary
    // strings as truthy and report `true` for nonsense input
    // — masking storage corruption instead of returning the
    // configured default cleanly.
    localStorage.setItem("asciimark-file-tree-respect-gitignore", "yes");
    expect(getStoredRespectGitignore()).toBe(true);
    localStorage.setItem("asciimark-file-tree-respect-gitignore", "1");
    expect(getStoredRespectGitignore()).toBe(true);
    localStorage.setItem("asciimark-file-tree-respect-gitignore", "");
    expect(getStoredRespectGitignore()).toBe(true);
  });

  it("showHiddenEntries falls back to true when stored value is malformed", () => {
    // Mutation captured: same relaxed-parse hazard as above — only
    // the literal strings "true"/"false" may be honored; anything
    // else must resolve to the configured default of `true`.
    localStorage.setItem("asciimark-file-tree-show-hidden", "yes");
    expect(getStoredShowHiddenEntries()).toBe(true);
    localStorage.setItem("asciimark-file-tree-show-hidden", "1");
    expect(getStoredShowHiddenEntries()).toBe(true);
    localStorage.setItem("asciimark-file-tree-show-hidden", "");
    expect(getStoredShowHiddenEntries()).toBe(true);
  });

  it("showAllDirs falls back to true when stored value is malformed", () => {
    // Mutation captured: same relaxed-parse hazard as above — only
    // the literal strings "true"/"false" may be honored; anything
    // else must resolve to the configured default of `true`.
    localStorage.setItem("asciimark-file-tree-show-all-dirs", "yes");
    expect(getStoredShowAllDirs()).toBe(true);
    localStorage.setItem("asciimark-file-tree-show-all-dirs", "1");
    expect(getStoredShowAllDirs()).toBe(true);
    localStorage.setItem("asciimark-file-tree-show-all-dirs", "");
    expect(getStoredShowAllDirs()).toBe(true);
  });

  it("showAllFiles falls back to true when stored value is malformed", () => {
    // Mutation captured: same relaxed-parse hazard as above — only
    // the literal strings "true"/"false" may be honored; anything
    // else must resolve to the configured default of `true`.
    localStorage.setItem("asciimark-file-tree-show-all-files", "yes");
    expect(getStoredShowAllFiles()).toBe(true);
    localStorage.setItem("asciimark-file-tree-show-all-files", "1");
    expect(getStoredShowAllFiles()).toBe(true);
    localStorage.setItem("asciimark-file-tree-show-all-files", "");
    expect(getStoredShowAllFiles()).toBe(true);
  });
});
