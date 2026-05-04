# Chaos / fault injection

The `chaos-invoke.ts` wrapper at `apps/desktop/src/lib/chaos-invoke.ts`
intercepts every `invoke()` call when the dev URL contains `?chaos=N`.
It deterministically rejects ~N% of calls with a synthetic error.

## Why

The desktop app's UI layers are wired to Tauri commands that, in
production, almost never fail. A `read_file` returns. A `write_file`
returns. The watcher delivers events. So error-handling code paths
go untested. When something *does* fail (full disk, network hiccup,
file deleted out from under the editor), bugs surface that no test
caught.

This wrapper lets a developer:

1. Open `http://127.0.0.1:2444/?chaos=10` in `bun run dev:app`.
2. Use the app normally.
3. ~10% of IPCs fail. The console logs each synthetic failure.
4. Watch for stuck spinners, lost dirty-state, double-fired events,
   or unrecovered dialogs.

## Adoption

To use, replace `import { invoke } from "@tauri-apps/api/core"` with
`import { invoke } from "~/lib/chaos-invoke"` in any `lib/*.ts` that
makes IPC calls. The signature is identical; in production, the URL
gate (only `http://`/`https://` enables chaos, never `tauri://`)
makes the wrapper a no-op.

The CHAOS_SAFE_COMMANDS set in `chaos-invoke.ts` exempts commands
where chaos creates noise rather than signal (e.g., `plugin:updater|check`,
which has its own retry).

## Status

Wrapper is wired but call sites still import directly from
`@tauri-apps/api/core`. Migrating site-by-site is captured in
`BACKLOG.md` — until then, chaos is **opt-in per file** rather than
global. That's intentional: a wholesale switch would force every
test fixture to handle chaos errors, polluting unrelated test paths.
