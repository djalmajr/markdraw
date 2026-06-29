import { describe, expect, it } from "vitest";
import { aiDirectoryContextLabel } from "./app-shell.tsx";

describe("aiDirectoryContextLabel", () => {
  it("keeps the workspace-relative parent path for nested folder context chips", () => {
    expect(aiDirectoryContextLabel({ name: "playwright", path: "output/playwright" })).toBe(
      "output/playwright/",
    );
  });

  it("falls back to the folder name for workspace-root pseudo entries", () => {
    expect(aiDirectoryContextLabel({ name: "markdraw", path: "" })).toBe("markdraw/");
  });
});
