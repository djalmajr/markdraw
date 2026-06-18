# Memory soak / leak detection

Uses [memlab](https://www.npmjs.com/package/memlab) (Meta) to drive
the Vite-served bundle in headless Chromium and detect retention
patterns across three heap snapshots: baseline, end-of-action, and
end-of-revert.

## Why this matters for Markdraw

The desktop app stays open all day. The watcher (`make_watcher`)
emits `fs-change` continuously while a workspace is loaded — over
8 hours that's tens of thousands of events. Tauri itself has a
[known leak issue](https://github.com/tauri-apps/tauri/issues/12724)
when emits accumulate without proper unsubscription, and our own
listeners (editor scroll, hash navigation, dnd handlers) are
attached on each component mount.

A weekly local run of this scenario flags the first commit that
introduces a regression — much cheaper than catching it from a
user report four versions later. We deliberately keep this OFF the
pre-commit / pre-push gates: memlab takes ~30s per run and benefits
from a beefier machine than GitHub Actions.

## Running

In one terminal, start Vite (no Tauri — memlab can't drive the
native WKWebView):

```bash
bun run dev:app
```

In another:

```bash
bun run test:memlab
```

memlab will:

1. Open `http://127.0.0.1:2444/` in headless Chromium.
2. Run `setup` to validate that `__DEV__` hooks are wired.
3. Take a baseline heap snapshot.
4. Run `action` — 100 dispatch cycles that fire
   `e2e:simulate-edit`, pushing content through the editor +
   convert pipeline + `fs-change` listener path.
5. Take a snapshot after the action.
6. Run `back` — dispatches `e2e:reset` to clear the active editor
   buffer.
7. Take a final snapshot.
8. Diff and emit retention findings, filtered by `leakFilter`.

## Reading the output

memlab prints one finding per retained object that passed the
filter, plus a summary line. Healthy output looks like:

```
0 leak(s) found
```

Each finding entry includes:

* **Retainer chain** — which object is keeping the leaked one
  alive. Usually points at a closure or array stored in a
  long-lived signal.
* **Retained size** — how many bytes the leak holds (transitively).
  Multiply by `ITERATIONS` for the worst case on a real session.

## Threshold (`leakFilter`)

A Solid `Computation` node is ~200 bytes; an editor model frame is
~2 KB. The scenario sets a 5 KB floor on retained size so the
filter ignores normal GC churn and only fires on objects heavier
than "a few signal wrappers".

To tighten the filter while debugging, edit
`leakFilter` in `scenario.cjs` and drop the floor.

## When it fails

1. Confirm Vite is on `:2444` — memlab connects there directly
   (without Tauri the IPC mocks are no-ops, which is fine for
   memory measurement).
2. Re-run the same scenario twice. If the second run is clean, the
   first finding was likely warm-up cache and not a real leak.
3. If a real leak fires, inspect the retainer chain. Most regressions
   point at one of:
   * an event listener registered in `onMount` without an
     `onCleanup`,
   * a signal subscriber kept alive by an `effect()` outside a
     reactive root,
   * a closure captured by a debounced callback that holds a
     stale `state` reference.

## Status

The scenario is wired and the `e2e:simulate-edit` / `e2e:reset`
hooks are exposed by `apps/desktop/src/app.tsx` (inside the
`__DEV__` block — production builds strip them via
`#[cfg(debug_assertions)]` on the Rust side and the
`import.meta.env.DEV` guard on the JS side).
