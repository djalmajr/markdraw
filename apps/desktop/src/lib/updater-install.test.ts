import { describe, expect, it, mock } from "bun:test";

// `installUpdate` flips `window.__markdraw_updating`; bun has no DOM, so stub it.
(globalThis as unknown as { window?: Record<string, unknown> }).window ??= {};

// Same Resource/Channel stubbing rationale as updater-drain.test.ts.
mock.module("@tauri-apps/api/core", () => ({
  invoke: async () => undefined,
  Resource: class {},
  Channel: class {},
}));
mock.module("@tauri-apps/plugin-updater", () => ({ check: async () => null, Update: class {} }));
const relaunchCalls: number[] = [];
let relaunchError: Error | undefined;
mock.module("@tauri-apps/plugin-process", () => ({
  relaunch: async () => {
    relaunchCalls.push(1);
    if (relaunchError) throw relaunchError;
  },
}));
const messageCalls: string[] = [];
mock.module("@tauri-apps/plugin-dialog", () => ({
  message: async (text: string) => {
    messageCalls.push(text);
  },
}));

import { installUpdate, useDownloadProgress } from "./updater.ts";
import type { DownloadEvent, DownloadOptions } from "@tauri-apps/plugin-updater";

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("installUpdate failure recovery", () => {
  it("clears progress and surfaces an error after a post-progress rejection", async () => {
    messageCalls.length = 0;
    const update = {
      downloadAndInstall: async (cb: (e: DownloadEvent) => void) => {
        cb({ event: "Started", data: { contentLength: 100 } });
        cb({ event: "Progress", data: { chunkLength: 40 } });
        // Verify/install/relaunch failing AFTER bytes flowed is the trap.
        throw new Error("network died");
      },
    };
    await installUpdate(update);
    // Bar cleared → the dialog restores Install/Later so the user can retry.
    expect(useDownloadProgress()).toBeNull();
    // Close-to-tray override undone (no relaunch happened).
    expect(win().__markdraw_updating).toBe(false);
    // The failure was surfaced, not swallowed silently.
    expect(messageCalls.length).toBe(1);
    expect(messageCalls[0]).toContain("network died");
  });

  it("locks the dialog synchronously — progress is set before the first DownloadEvent", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const update = {
      // Simulates a slow CDN handshake: no DownloadEvent fires for a while.
      downloadAndInstall: async () => {
        await gate;
        throw new Error("stop");
      },
    };
    const p = installUpdate(update); // intentionally not awaited
    // Synchronously after the call — before ANY DownloadEvent — progress is set,
    // so the dialog already blocks Later/Esc/outside-click.
    expect(useDownloadProgress()).not.toBeNull();
    expect(useDownloadProgress()?.phase).toBe("downloading");
    expect(useDownloadProgress()?.downloaded).toBe(0);
    release();
    await p;
    expect(useDownloadProgress()).toBeNull(); // failure path still recovers
  });

  it("ignores a concurrent second install while one is in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let secondRan = false;
    const slow = {
      downloadAndInstall: async () => {
        await gate;
        throw new Error("stop");
      },
    };
    const fast = {
      downloadAndInstall: async () => {
        secondRan = true;
        throw new Error("stop");
      },
    };
    // p1 sets `downloadInFlight` synchronously before its first await.
    const p1 = installUpdate(slow);
    const p2 = installUpdate(fast); // guarded → no-op
    await p2;
    expect(secondRan).toBe(false);
    release();
    await p1;
  });

  it("keeps a late-starting native install in flight and relaunches when it succeeds", async () => {
    messageCalls.length = 0;
    relaunchCalls.length = 0;
    let receivedTimeout: number | undefined;
    let releaseFirstEvent: () => void = () => {};
    const firstEventGate = new Promise<void>((r) => {
      releaseFirstEvent = r;
    });
    let secondRan = false;
    const slow = {
      downloadAndInstall: async (
        cb: (e: DownloadEvent) => void,
        options?: DownloadOptions,
      ) => {
        receivedTimeout = options?.timeout;
        await firstEventGate;
        cb({ event: "Started", data: { contentLength: 100 } });
        cb({ event: "Progress", data: { chunkLength: 100 } });
      },
    };
    const fast = {
      downloadAndInstall: async () => {
        secondRan = true;
      },
    };
    const p = installUpdate(slow, { downloadTimeoutMs: 1 });
    expect(useDownloadProgress()).not.toBeNull();
    await wait(5);
    await installUpdate(fast, { downloadTimeoutMs: 1 });
    expect(secondRan).toBe(false);
    releaseFirstEvent();
    await p;
    expect(receivedTimeout).toBe(1);
    expect(messageCalls.length).toBe(0);
    expect(relaunchCalls.length).toBe(1);
  });

  it("relaunches after a successful download with multiple progress events", async () => {
    messageCalls.length = 0;
    relaunchCalls.length = 0;
    const update = {
      downloadAndInstall: async (cb: (e: DownloadEvent) => void) => {
        cb({ event: "Started", data: { contentLength: 300 } });
        cb({ event: "Progress", data: { chunkLength: 100 } });
        cb({ event: "Progress", data: { chunkLength: 100 } });
        cb({ event: "Progress", data: { chunkLength: 100 } });
        cb({ event: "Finished" });
      },
    };
    await installUpdate(update);
    expect(messageCalls.length).toBe(0);
    expect(relaunchCalls.length).toBe(1);
  });

  it("passes a generous default total download timeout to the native updater", async () => {
    messageCalls.length = 0;
    let receivedTimeout: number | undefined;
    const update = {
      downloadAndInstall: async (
        _cb: (e: DownloadEvent) => void,
        options?: DownloadOptions,
      ) => {
        receivedTimeout = options?.timeout;
        throw new Error("stop");
      },
    };
    await installUpdate(update);
    expect(receivedTimeout).toBeGreaterThanOrEqual(600_000);
  });

  it("reports manual restart when relaunch fails after install completed", async () => {
    messageCalls.length = 0;
    relaunchCalls.length = 0;
    relaunchError = new Error("relaunch failed");
    const update = {
      downloadAndInstall: async (cb: (e: DownloadEvent) => void) => {
        cb({ event: "Started", data: { contentLength: 100 } });
        cb({ event: "Progress", data: { chunkLength: 100 } });
        cb({ event: "Finished" });
      },
    };
    try {
      await installUpdate(update);
    } finally {
      relaunchError = undefined;
    }
    expect(useDownloadProgress()).toBeNull();
    expect(messageCalls.length).toBe(1);
    expect(messageCalls[0]).toContain("restart the app");
    expect(messageCalls[0]).not.toContain("Failed to install");
  });
});
