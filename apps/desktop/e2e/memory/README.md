# Memory soak / leak detection

Uses [memlab](https://www.npmjs.com/package/memlab) (Meta) to drive the
Vite-served bundle in headless Chrome and detect retention patterns
across 3 heap snapshots: baseline, after-action, after-revert.

## Why this matters for AsciiMark

The desktop app stays open all day. The watcher (`make_watcher`) emits
`fs-change` continuously while a workspace is loaded — over 8 hours
that's tens of thousands of events. Tauri itself has a [known leak
issue](https://github.com/tauri-apps/tauri/issues/12724) when emits
accumulate without proper unsubscription, and our own listeners
(editor scroll, hash navigation, dnd handlers) are attached on each
component mount.

A weekly nightly run of this scenario flags the first commit that
introduces a regression — much cheaper than catching it from a user
report 4 versions later.

## Running

In one terminal:

```bash
bun run dev:app   # serves Vite on :2444
```

In another:

```bash
bun run test:memlab
```

memlab will:
1. Open the URL in headless Chrome.
2. Take a baseline heap snapshot.
3. Run the `action` (30 simulated edit/save cycles).
4. Take a snapshot after the action.
5. Run `back` (reset to clean state).
6. Take a final snapshot.
7. Diff and emit retention findings.

Expected output: zero leak findings on a clean tree. A finding looks like
`30 [Object] objects were allocated but never released`.

## Status

The scenario file is wired but **the app needs to expose `e2e:simulate-edit`
and `e2e:reset` event listeners** for the action to drive real state
changes. Without them, memlab measures noise. This is captured in
`BACKLOG.md` as a follow-up.
