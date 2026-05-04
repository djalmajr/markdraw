// Fault-injection wrapper around `@tauri-apps/api/core`'s invoke.
//
// In dev (and *only* in dev — the URL guard ensures release builds skip
// the wiring), this can wrap real invokes so a configurable fraction of
// IPC calls deterministically reject with an error. The point is to make
// the UI prove it handles errors: dialogs that should reopen, loading
// states that should clear, dirty-tab indicators that shouldn't lie.
//
// Activation: append `?chaos=N` to the dev URL, where N is a percentage
// from 1-100. With `?chaos=5`, ~5% of IPC calls fail with a synthetic
// error; the rest go through normally. Read on startup; persists for the
// session via window.__chaosRate.
//
// To opt a specific command OUT (e.g. read_file, where every keystroke
// re-renders): pass it in CHAOS_SAFE_COMMANDS below.
import { invoke as realInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";

const CHAOS_SAFE_COMMANDS = new Set<string>([
  // The Tauri plugins do their own retry logic; chaos here would be noise.
  "plugin:updater|check",
  "plugin:dialog|open",
]);

function readRate(): number {
  // SSR-safe + production-safe: window may not exist in tests, and a
  // production build serves over `tauri://` which doesn't carry chaos URLs.
  if (typeof window === "undefined") return 0;
  if (window.location.protocol !== "http:" && window.location.protocol !== "https:") {
    return 0;
  }
  const url = new URL(window.location.href);
  const raw = url.searchParams.get("chaos");
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, Math.max(0, n)) / 100;
}

const chaosRate = readRate();

let chaosCount = 0;

if (chaosRate > 0) {
  // eslint-disable-next-line no-console
  console.warn(
    `[chaos-invoke] enabled: ${(chaosRate * 100).toFixed(1)}% of IPC calls will fail with a synthetic error.`,
  );
}

export async function invoke<T>(
  cmd: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  if (chaosRate > 0 && !CHAOS_SAFE_COMMANDS.has(cmd) && Math.random() < chaosRate) {
    chaosCount += 1;
    const id = chaosCount;
    // eslint-disable-next-line no-console
    console.warn(`[chaos-invoke] #${id} synthetic failure of ${cmd}`);
    throw new Error(
      `[chaos] simulated IPC failure for "${cmd}" (call #${id}). Disable with the URL: remove ?chaos=...`,
    );
  }
  return realInvoke<T>(cmd, args, options);
}

export type { InvokeArgs, InvokeOptions };
