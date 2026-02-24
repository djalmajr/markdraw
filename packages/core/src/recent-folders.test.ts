import { beforeEach, describe, expect, it } from "bun:test";
import {
  addRecentFolder,
  clearRecentFolders,
  getRecentFolders,
  removeRecentFolder,
} from "./recent-folders.ts";

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

describe("recent-folders", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("should add items to the top, deduplicate by path, and keep max size", () => {
    for (let index = 0; index < 12; index += 1) {
      addRecentFolder({
        name: `Folder ${index}`,
        path: `/tmp/folder-${index}`,
      });
    }

    addRecentFolder({
      name: "Docs",
      path: "/tmp/docs",
    });

    addRecentFolder({
      name: "Docs Updated",
      path: "/tmp/docs",
    });

    const folders = getRecentFolders();
    expect(folders.length).toBe(10);
    expect(folders[0]?.name).toBe("Docs Updated");
    expect(
      folders.filter((folder) => {
        return folder.path === "/tmp/docs";
      }).length
    ).toBe(1);
  });

  it("should remove an item by path", () => {
    addRecentFolder({
      name: "Docs",
      path: "/tmp/docs",
    });
    addRecentFolder({
      name: "Workspace",
      path: "/tmp/workspace",
    });

    const folders = removeRecentFolder("/tmp/docs");
    expect(folders.length).toBe(1);
    expect(folders[0]?.path).toBe("/tmp/workspace");
  });

  it("should clear all recent folders", () => {
    addRecentFolder({
      name: "Docs",
      path: "/tmp/docs",
    });

    clearRecentFolders();
    expect(getRecentFolders()).toEqual([]);
  });
});
