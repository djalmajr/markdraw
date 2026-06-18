import { beforeEach, describe, expect, it } from "bun:test";
import {
  addFavorite,
  getFavorites,
  isFavorite,
  removeFavorite,
} from "./favorites.ts";
import { installLocalStorageMock } from "./test-utils.ts";

installLocalStorageMock();

describe("favorites", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns empty list when nothing is stored", () => {
    expect(getFavorites()).toEqual([]);
  });

  it("addFavorite places new items at the top", () => {
    addFavorite({ name: "A", path: "a.md", rootName: "r", rootPath: "/r" });
    addFavorite({ name: "B", path: "b.md", rootName: "r", rootPath: "/r" });
    const favs = getFavorites();
    expect(favs[0]?.path).toBe("b.md");
    expect(favs[1]?.path).toBe("a.md");
  });

  it("re-adding an existing favorite moves it to the top without duplicates", () => {
    addFavorite({ name: "A", path: "a.md", rootName: "r", rootPath: "/r" });
    addFavorite({ name: "B", path: "b.md", rootName: "r", rootPath: "/r" });
    addFavorite({ name: "A again", path: "a.md", rootName: "r", rootPath: "/r" });

    const favs = getFavorites();
    expect(favs).toHaveLength(2);
    expect(favs[0]?.name).toBe("A again");
  });

  it("dedup key uses path + rootPath together", () => {
    addFavorite({ name: "A in r1", path: "a.md", rootName: "r1", rootPath: "/r1" });
    addFavorite({ name: "A in r2", path: "a.md", rootName: "r2", rootPath: "/r2" });
    expect(getFavorites()).toHaveLength(2);
  });

  it("removeFavorite removes only the matching entry", () => {
    addFavorite({ name: "A", path: "a.md", rootName: "r", rootPath: "/r" });
    addFavorite({ name: "B", path: "b.md", rootName: "r", rootPath: "/r" });
    const remaining = removeFavorite("a.md", "/r");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.path).toBe("b.md");
  });

  it("isFavorite checks against the provided list", () => {
    const favs = [
      { name: "A", path: "a.md", rootName: "r", rootPath: "/r" },
    ];
    expect(isFavorite("a.md", "/r", favs)).toBe(true);
    expect(isFavorite("a.md", "/other", favs)).toBe(false);
    expect(isFavorite("z.md", "/r", favs)).toBe(false);
  });

  it("ignores corrupted storage gracefully", () => {
    localStorage.setItem("markdraw-favorites", "{not json");
    expect(getFavorites()).toEqual([]);
  });

  it("filters non-conforming items from a tampered list", () => {
    localStorage.setItem(
      "markdraw-favorites",
      JSON.stringify([
        { name: "Good", path: "g.md", rootName: "r", rootPath: "/r" },
        { name: "Missing rootPath", path: "x.md", rootName: "r" },
        null,
        "string entry",
      ]),
    );
    const favs = getFavorites();
    expect(favs).toHaveLength(1);
    expect(favs[0]?.name).toBe("Good");
  });
});
