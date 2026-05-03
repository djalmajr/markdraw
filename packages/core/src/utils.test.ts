import { describe, expect, it } from "bun:test";
import {
  ADOC_EXTENSIONS,
  cn,
  escapeHtml,
  IGNORED_DIRS,
  isAdocFile,
  isMdFile,
  isSupportedFile,
  MD_EXTENSIONS,
} from "./utils.ts";

describe("isAdocFile", () => {
  it.each(ADOC_EXTENSIONS)("recognizes %s as AsciiDoc", (ext) => {
    expect(isAdocFile(`doc${ext}`)).toBe(true);
  });

  it("returns false for non-asciidoc extensions", () => {
    expect(isAdocFile("doc.md")).toBe(false);
    expect(isAdocFile("doc.txt")).toBe(false);
    expect(isAdocFile("doc")).toBe(false);
  });

  it("matches by suffix so paths with directories work", () => {
    expect(isAdocFile("/abs/path/notes.adoc")).toBe(true);
  });
});

describe("isMdFile", () => {
  it.each(MD_EXTENSIONS)("recognizes %s as Markdown", (ext) => {
    expect(isMdFile(`doc${ext}`)).toBe(true);
  });

  it("returns false for non-markdown extensions", () => {
    expect(isMdFile("doc.adoc")).toBe(false);
    expect(isMdFile("README")).toBe(false);
  });
});

describe("isSupportedFile", () => {
  it("accepts both AsciiDoc and Markdown extensions", () => {
    expect(isSupportedFile("a.md")).toBe(true);
    expect(isSupportedFile("b.adoc")).toBe(true);
    expect(isSupportedFile("c.txt")).toBe(false);
  });
});

describe("escapeHtml", () => {
  it("escapes the four characters that break HTML attribute and tag context", () => {
    expect(escapeHtml('<a href="x">&"</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&quot;&lt;/a&gt;",
    );
  });

  it("must escape & before other entities so &lt; doesn't become &amp;lt;", () => {
    expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
  });

  it("returns input unchanged when no special chars are present", () => {
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
  });
});

describe("cn", () => {
  it("merges and dedupes tailwind classes via tailwind-merge", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("filters falsy values", () => {
    expect(cn("foo", false, null, undefined, "bar")).toBe("foo bar");
  });
});

describe("IGNORED_DIRS", () => {
  it("contains the standard noisy build/cache directories", () => {
    for (const dir of ["node_modules", ".git", "dist", "target", "coverage"]) {
      expect(IGNORED_DIRS.has(dir)).toBe(true);
    }
  });
});
