// Wait for the desktop app's frontend to be mounted to the point where
// `window.__DEV__` (the e2e helper) is exposed. The TCP socket from
// `tauri-plugin-mcp-bridge` opens before Solid mounts the app, so a
// pure port probe in `run-e2e.sh` is too early — specs run against a
// half-mounted page and the first call to `__DEV__.openFolder()` blows
// up with "DEV helper not exposed" or a silent NPE.
//
// We poll `evalJs("typeof window.__DEV__")` over the bridge until it
// returns `"object"`, then exit 0. Used by `run-e2e.sh` after the TCP
// probe succeeds.

import { connectBridge } from "../apps/desktop/e2e/bridge.ts";

const TIMEOUT_MS = Number(process.env.APP_READY_TIMEOUT_MS ?? 30_000);
const POLL_INTERVAL_MS = 250;

const start = Date.now();
let bridge: Awaited<ReturnType<typeof connectBridge>> | null = null;

try {
  bridge = await connectBridge({ handshakeTimeoutMs: 5000 });
  while (Date.now() - start < TIMEOUT_MS) {
    // The bridge's TCP socket binds before the webview window registers, so
    // an early evalJs can throw "Window 'main' not found". That's transient —
    // swallow it and keep polling until the window exists and __DEV__ mounts.
    try {
      const t = await bridge.evalJs("typeof window.__DEV__");
      if (t === "object") {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`▶ Frontend ready after ${elapsed}s`);
        bridge.close();
        process.exit(0);
      }
    } catch {
      // window/webview not ready yet — retry below
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.error(
    `✖ Timed out waiting for window.__DEV__ to be exposed (${TIMEOUT_MS}ms)`,
  );
  bridge.close();
  process.exit(1);
} catch (err) {
  console.error(`✖ wait-app-ready failed: ${(err as Error).message}`);
  bridge?.close();
  process.exit(1);
}
