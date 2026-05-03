# Desktop E2E suite

Two complementary harnesses live here:

1. **`specs/*.tauri.test.ts`** — IPC-driven tests that spawn `tauri dev`
   and exercise Rust commands directly via the `tauri-plugin-mcp-bridge`
   (already enabled in `apps/desktop/src-tauri/src/lib.rs` under
   `#[cfg(debug_assertions)]`). Validates the *backend contract* without
   needing to drive the webview.
2. **`specs/*.webview.test.ts`** — full UX smoke tests that drive the
   webview through `mcp__hypothesi_tauri-mcp-server__webview_*` tools.
   Useful for golden-path flows (open folder → click file → preview shows
   up → edit → save → close tab).

`fixtures/sample-workspace/` is a deterministic workspace shared by both
harnesses. Always read fixtures by absolute path resolved at runtime.

## Running locally

The MCP-driven harness needs a running `tauri dev` instance with the MCP
bridge bound on `127.0.0.1` (default). Start the app first:

```bash
bun run dev:app
```

Then in another terminal:

```bash
bun run e2e
```

## CI

Not wired into CI yet — these specs need a display server and a built
Tauri runtime. The plan is to add a `desktop-e2e` job to `test.yml` that
runs only on `main` and on PRs that touch `apps/desktop/**` or
`packages/ui/**`.
