import { describe, expect, it } from "bun:test";
import { decideExternalReload } from "./external-reload.ts";

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
