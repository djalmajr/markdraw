import { describe, expect, it } from "bun:test";
import { joinRelative, nextAvailableName, withDefaultExtension } from "./fs-paths.ts";

describe("withDefaultExtension", () => {
  // Mutation: dropping the `.md` default leaves bare names extension-less.
  it("appends .md when the basename has no extension", () => {
    expect(withDefaultExtension("notas")).toBe("notas.md");
    expect(withDefaultExtension("sub/dir/guia")).toBe("sub/dir/guia.md");
  });

  // Mutation: always-appending .md would corrupt names that already carry one.
  it("keeps an existing extension (including in subdirs)", () => {
    expect(withDefaultExtension("a.txt")).toBe("a.txt");
    expect(withDefaultExtension("sub/data.json")).toBe("sub/data.json");
    expect(withDefaultExtension("diagram.excalidraw")).toBe("diagram.excalidraw");
  });
});

describe("joinRelative", () => {
  // Mutation: a leading or doubled slash breaks the workspace-relative path.
  it("joins parent and child, collapsing a trailing slash", () => {
    expect(joinRelative("docs", "x.md")).toBe("docs/x.md");
    expect(joinRelative("docs/", "x.md")).toBe("docs/x.md");
    expect(joinRelative("a/b", "c.md")).toBe("a/b/c.md");
  });

  // Mutation: prefixing a slash at the root would escape to an absolute path.
  it("returns the bare name at the workspace root (empty parent)", () => {
    expect(joinRelative("", "x.md")).toBe("x.md");
  });
});

describe("nextAvailableName", () => {
  // Mutation: returning the original name on a collision would overwrite.
  it("returns the name unchanged when it is free", () => {
    expect(nextAvailableName("notes.md", () => false)).toBe("notes.md");
  });

  // Mutation: appending the suffix after the extension yields "notes.md (1)".
  it("inserts ' (1)' before the extension on the first collision", () => {
    const taken = new Set(["notes.md"]);
    expect(nextAvailableName("notes.md", (c) => taken.has(c))).toBe("notes (1).md");
  });

  // Mutation: not incrementing would loop forever or reuse a taken name.
  it("increments until a free slot is found", () => {
    const taken = new Set(["a.md", "a (1).md", "a (2).md"]);
    expect(nextAvailableName("a.md", (c) => taken.has(c))).toBe("a (3).md");
  });

  // Mutation: dot-splitting a directory name would mangle "my.dir".
  it("treats a directory name as having no extension", () => {
    const taken = new Set(["my.dir"]);
    expect(nextAvailableName("my.dir", (c) => taken.has(c), true)).toBe("my.dir (1)");
  });

  // A dotfile (leading dot, no other dot) has no real extension to split.
  it("does not split a dotfile into a fake extension", () => {
    const taken = new Set([".env"]);
    expect(nextAvailableName(".env", (c) => taken.has(c))).toBe(".env (1)");
  });
});
