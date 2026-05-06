import { describe, expect, it } from "bun:test";
import {
  buildWorkspaceSymbols,
  filterWorkspaceSymbols,
} from "./workspace-symbols.ts";

const FILES = [
  {
    rootId: "r",
    rootName: "Root",
    path: "intro.md",
    content: "# Hello\n\nbody\n\n## Background\n",
  },
  {
    rootId: "r",
    rootName: "Root",
    path: "guide.adoc",
    content: "= Guide\n\n== Setup\n\n=== Install\n\n== Usage\n",
  },
  {
    rootId: "r",
    rootName: "Root",
    path: "raw.txt",
    content: "no headings here, plain text",
  },
];

describe("buildWorkspaceSymbols", () => {
  it("flattens headings across markdown and asciidoc files", () => {
    // Mutation: dropping the dispatch on filename extension would
    // miss either md or adoc and the workspace search would only
    // surface half the docs.
    const symbols = buildWorkspaceSymbols(FILES);
    const titles = symbols.map((s) => s.heading.text);
    expect(titles).toContain("Hello");
    expect(titles).toContain("Setup");
    expect(titles).toContain("Install");
  });

  it("skips non-document files (txt, json, etc.) — they can't host headings", () => {
    // Mutation: removing the `isSupportedFile` filter would feed
    // raw text into the heading parser, producing zero matches but
    // wasting CPU on every keystroke.
    const symbols = buildWorkspaceSymbols(FILES);
    expect(symbols.find((s) => s.path === "raw.txt")).toBeUndefined();
  });

  it("attaches `path` and `rootId` so the host can re-open the source file", () => {
    // Mutation: omitting the rootId would force the host to scan
    // every root for the file path — broken when two roots have
    // colliding paths.
    const symbols = buildWorkspaceSymbols(FILES);
    const setup = symbols.find((s) => s.heading.text === "Setup")!;
    expect(setup.path).toBe("guide.adoc");
    expect(setup.rootId).toBe("r");
  });

  it("preserves heading line numbers from the per-file extractor", () => {
    // Mutation: dropping the line index breaks the editor jump on
    // select — the user would land at line 0 of every file.
    const symbols = buildWorkspaceSymbols(FILES);
    const usage = symbols.find((s) => s.heading.text === "Usage")!;
    // "= Guide" is 0, blank 1, "== Setup" is 2, blank 3,
    // "=== Install" is 4, blank 5, "== Usage" is 6.
    expect(usage.heading.line).toBe(6);
  });
});

describe("filterWorkspaceSymbols", () => {
  const SYMBOLS = buildWorkspaceSymbols(FILES);

  it("returns all symbols when query is empty", () => {
    // Mutation: gating the empty-query path would force the user
    // to type before seeing any symbols — slower entry into the
    // palette.
    expect(filterWorkspaceSymbols("", SYMBOLS).length).toBe(SYMBOLS.length);
  });

  it("matches case-insensitively against the heading text", () => {
    // Mutation: forgetting `.toLowerCase()` would force exact-case
    // typing for every search.
    const hits = filterWorkspaceSymbols("inst", SYMBOLS);
    expect(hits.length).toBe(1);
    expect(hits[0]!.heading.text).toBe("Install");
  });

  it("falls back to the file path when the query doesn't match heading text", () => {
    // Mutation: matching ONLY heading text would hide all symbols
    // when the user types a filename — the natural way to scope
    // the workspace search to one file.
    const hits = filterWorkspaceSymbols("guide", SYMBOLS);
    // Every heading inside guide.adoc must surface
    expect(hits.every((h) => h.path === "guide.adoc")).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  });
});
