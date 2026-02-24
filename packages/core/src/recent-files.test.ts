import { beforeEach, describe, expect, it } from "bun:test";
import {
  addRecentFile,
  clearRecentFiles,
  getRecentFiles,
  removeRecentFile,
} from "./recent-files.ts";

function createLocalStorageMock() {
  const store = new Map<string, string>();

  return {
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    get length() {
      return store.size;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  } satisfies Storage;
}

const localStorageMock = createLocalStorageMock();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: localStorageMock,
});

describe("recent-files", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("should add items to the top, deduplicate by rootPath + path, and keep max size", () => {
    for (let index = 0; index < 12; index += 1) {
      addRecentFile({
        name: `Doc ${index}`,
        path: `docs/file-${index}.adoc`,
        rootName: `repo-${index}`,
        rootPath: `/tmp/repo-${index}`,
      });
    }

    addRecentFile({
      name: "Readme A",
      path: "README.md",
      rootName: "repo-a",
      rootPath: "/tmp/repo-a",
    });

    addRecentFile({
      name: "Readme A updated",
      path: "README.md",
      rootName: "repo-a",
      rootPath: "/tmp/repo-a",
    });

    addRecentFile({
      name: "Readme B",
      path: "README.md",
      rootName: "repo-b",
      rootPath: "/tmp/repo-b",
    });

    const files = getRecentFiles();
    expect(files.length).toBe(10);
    expect(files[0]?.rootPath).toBe("/tmp/repo-b");
    expect(files[1]?.name).toBe("Readme A updated");
    expect(
      files.filter((file) => {
        return file.path === "README.md" && file.rootPath === "/tmp/repo-a";
      }).length
    ).toBe(1);
  });

  it("should remove an item by rootPath + path", () => {
    addRecentFile({
      name: "Guide A",
      path: "guide.adoc",
      rootName: "repo-a",
      rootPath: "/tmp/repo-a",
    });
    addRecentFile({
      name: "Guide B",
      path: "guide.adoc",
      rootName: "repo-b",
      rootPath: "/tmp/repo-b",
    });

    const updated = removeRecentFile("guide.adoc", "/tmp/repo-a");
    expect(updated.length).toBe(1);
    expect(updated[0]?.rootPath).toBe("/tmp/repo-b");
  });

  it("should clear all recent files", () => {
    addRecentFile({
      name: "Doc",
      path: "doc.adoc",
      rootName: "repo",
      rootPath: "/tmp/repo",
    });

    clearRecentFiles();
    expect(getRecentFiles()).toEqual([]);
  });

  it("should discard legacy storage key", () => {
    localStorage.setItem(
      "asciimark-recent-files",
      JSON.stringify([
        {
          name: "Legacy",
          path: "legacy.adoc",
          rootName: "legacy-root",
        },
      ]),
    );

    const files = getRecentFiles();
    expect(files).toEqual([]);
    expect(localStorage.getItem("asciimark-recent-files")).toBeNull();
  });
});
