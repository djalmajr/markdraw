import { describe, expect, it, mock } from "bun:test";

const calls: string[] = [];
mock.module("@tauri-apps/api/core", () => ({
  // bun shares module mocks across test files: keep every export a module
  // under test may import, or a later file fails to link.
  convertFileSrc: (path: string) => path,
  invoke: async (command: string) => { calls.push(command); },
  Resource: class {},
  Channel: class {},
}));
mock.module("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    show: async () => { calls.push("show"); },
    unminimize: async () => { calls.push("unminimize"); },
    setFocus: async () => { calls.push("setFocus"); },
  }),
}));
mock.module("@tauri-apps/plugin-updater", () => ({
  check: async () => ({ version: "1.0", currentVersion: "0.9", body: "" }),
  Update: class {},
}));
mock.module("@tauri-apps/plugin-process", () => ({ relaunch: async () => {} }));
mock.module("@tauri-apps/plugin-dialog", () => ({ message: async () => {} }));

import { checkForAppUpdates } from "./updater.ts";

describe("update window", () => {
  it("restores the main window before unminimizing and focusing", async () => {
    calls.length = 0;
    await checkForAppUpdates(true);
    expect(calls).toEqual(["show_main_window", "unminimize", "setFocus"]);
  });
});
