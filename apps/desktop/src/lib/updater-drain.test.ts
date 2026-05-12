import { describe, expect, it, mock } from "bun:test";

// Capture invoke calls so the test can verify both watcher-stop
// commands fire before relaunch. `plugin-updater` extends `Resource`
// from `api/core`; provide a Resource-less stub for the same reason
// folder.test.ts does, so test order doesn't matter.
const invokeCalls: string[] = [];
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    invokeCalls.push(cmd);
    return undefined;
  },
  Resource: class {},
  // `@tauri-apps/plugin-updater` does a static import of `Channel`
  // from this module — bun's mock resolution is process-wide so we
  // have to ship every symbol downstream code expects, even when
  // plugin-updater itself is also mocked below (some test orders
  // load the real plugin-updater before the mock takes effect).
  Channel: class {},
}));
mock.module("@tauri-apps/plugin-updater", () => ({
  check: async () => null,
  Update: class {},
}));
mock.module("@tauri-apps/plugin-process", () => ({
  relaunch: async () => {},
}));
mock.module("@tauri-apps/plugin-dialog", () => ({
  message: async () => {},
}));

import { drainBeforeRelaunch } from "./updater.ts";

describe("drainBeforeRelaunch", () => {
  it("invokes both stop_watching and stop_watching_dirs before resolving", async () => {
    // Mutation captured: dropping `stop_watching_dirs` (or only
    // awaiting `stop_watching`) would leave the directory-watcher
    // alive across the relaunch, re-introducing the single-instance
    // freeze on macOS where the OS sees the old process as still
    // holding handles.
    invokeCalls.length = 0;
    await drainBeforeRelaunch();
    expect(invokeCalls).toContain("stop_watching");
    expect(invokeCalls).toContain("stop_watching_dirs");
    expect(invokeCalls).toHaveLength(2);
  });

});
