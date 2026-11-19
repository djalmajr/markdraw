import { describe, expect, it } from "bun:test";
import { createOwnWrites, decideExternalReload, eventIsOnly, hashContent } from "./external-reload.ts";

describe("decideExternalReload", () => {
  it("our own autosave never replaces text typed after it", () => {
    // The race: autosave wrote "a", the user kept typing ("ab"), then the
    // watcher fired for that write. Mutation captured: reloading whenever the
    // watcher fires (the old behaviour) returns "reload" and drops the "b".
    expect(decideExternalReload({ disk: "a", saved: "a", current: "ab" })).toBe("rerender");
  });

  it("re-renders when nothing changed at all (e.g. an included file did)", () => {
    expect(decideExternalReload({ disk: "a", saved: "a", current: "a" })).toBe("rerender");
  });

  it("adopts an external change when there are no unsaved edits", () => {
    // Mutation captured: never reloading would leave another editor's change
    // invisible until the file is reopened.
    expect(decideExternalReload({ disk: "x", saved: "a", current: "a" })).toBe("reload");
  });

  it("adopts the disk when it already holds the buffer, clearing the dirty mark", () => {
    // Mutation captured: treating this as "keep-local" leaves the buffer
    // marked unsaved although the file on disk is identical.
    expect(decideExternalReload({ disk: "ab", saved: "a", current: "ab" })).toBe("reload");
  });

  it("keeps unsaved edits over an external change", () => {
    // Mutation captured: preferring the disk here discards what the user is
    // typing whenever another program touches the file.
    expect(decideExternalReload({ disk: "x", saved: "a", current: "ab" })).toBe("keep-local");
  });
});

describe("own-write marks", () => {
  it("hashContent is a stable SHA-256 hex digest", async () => {
    expect(await hashContent("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await hashContent("a")).not.toBe(await hashContent("b"));
    expect(await hashContent("héllo ✓")).toBe(await hashContent("héllo ✓"));
  });

  it("matches the last content marked for a path and nothing else", async () => {
    const marks = createOwnWrites();
    marks.mark("/ws/a.adoc", "first");
    expect(await marks.matches("/ws/a.adoc", await hashContent("first"))).toBe(true);
    expect(await marks.matches("/ws/a.adoc", await hashContent("other"))).toBe(false);
    expect(await marks.matches("/ws/b.adoc", await hashContent("first"))).toBe(false);
    marks.mark("/ws/a.adoc", "second"); // a newer save replaces the mark
    expect(await marks.matches("/ws/a.adoc", await hashContent("first"))).toBe(false);
    expect(await marks.matches("/ws/a.adoc", await hashContent("second"))).toBe(true);
  });

  it("an event right after the mark still sees it (the digest is awaited, not raced)", async () => {
    const marks = createOwnWrites();
    marks.mark("/ws/a.adoc", "x".repeat(500_000));
    const hash = await hashContent("x".repeat(500_000));
    expect(await marks.matches("/ws/a.adoc", hash)).toBe(true);
  });

  it("forget drops the mark", async () => {
    const marks = createOwnWrites();
    marks.mark("/ws/a.adoc", "text");
    marks.forget("/ws/a.adoc");
    expect(await marks.matches("/ws/a.adoc", await hashContent("text"))).toBe(false);
  });

  it("counts every mark, including a repeat of the same text, and not a forget", () => {
    const marks = createOwnWrites(2);
    expect(marks.revision()).toBe(0);
    marks.mark("/ws/a.adoc", "same");
    marks.mark("/ws/a.adoc", "same"); // same path and text: still a new save
    expect(marks.revision()).toBe(2);
    marks.forget("/ws/a.adoc");
    expect(marks.revision()).toBe(2);
    marks.mark("/ws/1", "1");
    marks.mark("/ws/2", "2");
    marks.mark("/ws/3", "3"); // eviction of the oldest does not lower it
    expect(marks.revision()).toBe(5);
  });

  it("keeps at most `limit` paths, dropping the oldest", async () => {
    const marks = createOwnWrites(2);
    marks.mark("/ws/1", "1");
    marks.mark("/ws/2", "2");
    marks.mark("/ws/3", "3");
    expect(await marks.matches("/ws/1", await hashContent("1"))).toBe(false);
    expect(await marks.matches("/ws/2", await hashContent("2"))).toBe(true);
    expect(await marks.matches("/ws/3", await hashContent("3"))).toBe(true);
  });
});

describe("eventIsOnly", () => {
  const file = "/ws/doc.adoc";
  it("is true only for an event that names nothing but the file", () => {
    expect(eventIsOnly(file, [file])).toBe(true);
    expect(eventIsOnly(file, [file, file])).toBe(true);
  });
  it.each([
    ["no paths", undefined],
    ["an empty list", [] as string[]],
    ["an include too", [file, "/ws/inc.adoc"]],
    ["only an include", ["/ws/inc.adoc"]],
    ["a path that merely starts with the file", [`${file}.bak`]],
    ["a differently spelled path", ["/ws/./doc.adoc"]],
  ])("is false for %s", (_label, paths) => {
    expect(eventIsOnly(file, paths)).toBe(false);
  });
});
