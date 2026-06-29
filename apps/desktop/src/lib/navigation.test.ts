import { describe, expect, it } from "bun:test";
import { resolveNavigationTarget } from "./navigation-target.ts";

describe("resolveNavigationTarget", () => {
  const roots = new Map([
    ["repo", "/Users/djalmajr/Developer/djalmajr/markdraw"],
    ["docs", "/Users/djalmajr/Developer/djalmajr/markdraw/docs"],
  ]);

  it("keeps repo-relative paths unchanged", () => {
    expect(resolveNavigationTarget("apps/site/public/demo-folder/docs/architecture.adoc", roots))
      .toEqual({ path: "apps/site/public/demo-folder/docs/architecture.adoc" });
  });

  it("maps absolute paths under an open root to root-relative paths", () => {
    expect(resolveNavigationTarget(
      "/Users/djalmajr/Developer/djalmajr/markdraw/apps/site/public/demo-folder/docs/architecture.adoc",
      roots,
    )).toEqual({
      path: "apps/site/public/demo-folder/docs/architecture.adoc",
      rootId: "repo",
    });
  });

  it("prefers the deepest open root for absolute paths", () => {
    expect(resolveNavigationTarget(
      "file:///Users/djalmajr/Developer/djalmajr/markdraw/docs/README.md",
      roots,
    )).toEqual({ path: "README.md", rootId: "docs" });
  });

  it("removes an open root name prefix from model-emitted paths", () => {
    expect(resolveNavigationTarget("markdraw/apps/site/public/demo-folder/docs/architecture.adoc", roots))
      .toEqual({
        path: "apps/site/public/demo-folder/docs/architecture.adoc",
        rootId: "repo",
      });
  });
});
