import { describe, expect, it, mock } from "bun:test";

// The Tauri bridge is replaced: `listen` hands us the callback so a test can
// fire an `fs-change` event with any payload.
let fire: ((event: { payload: unknown }) => void) | null = null;
const invoked: Array<[string, unknown]> = [];
mock.module("@tauri-apps/api/event", () => ({
  listen: async (_name: string, cb: (event: { payload: unknown }) => void) => {
    fire = cb;
    return () => {};
  },
}));
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: unknown) => { invoked.push([command, args]); },
  Resource: class {},
  Channel: class {},
}));

describe("FileWatcher event paths", () => {
  it("passes the paths of the fs-change event to the callback", async () => {
    // Mutation captured: calling onChange() without the payload paths makes
    // every event look path-less, so the own-write echo can never be told apart.
    const { FileWatcher } = await import("./watcher.ts");
    const seen: string[][] = [];
    const watcher = new FileWatcher((paths) => { seen.push(paths); });
    await watcher.start();
    fire!({ payload: { paths: ["/ws/a.adoc", "/ws/inc.adoc"] } });
    expect(seen).toEqual([["/ws/a.adoc", "/ws/inc.adoc"]]);
    await watcher.destroy();
  });

  it.each([
    ["no payload", undefined],
    ["a payload without paths", {}],
    ["paths that are not an array", { paths: "/ws/a.adoc" }],
    ["null", null],
  ])("an event with %s reaches the callback with no paths", async (_label, payload) => {
    const { FileWatcher } = await import("./watcher.ts");
    const seen: string[][] = [];
    const watcher = new FileWatcher((paths) => { seen.push(paths); });
    await watcher.start();
    fire!({ payload });
    expect(seen).toEqual([[]]);
    await watcher.destroy();
  });

  it("drops entries that are not strings instead of passing them on", async () => {
    const { eventPaths } = await import("./watcher.ts");
    expect(eventPaths({ paths: ["/ws/a.adoc", 3, null, "/ws/b.adoc"] })).toEqual(["/ws/a.adoc", "/ws/b.adoc"]);
  });
});
