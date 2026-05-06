---
title: "Test conventions"
audience: dev
sources:
  - repo:./packages/core/src
  - repo:./packages/ui/src
  - repo:./apps/desktop/src-tauri/src
updated: 2026-05-04
tags: [testing, conventions, naming, file-layout]
status: stable
---

# Test conventions

## File naming

| Pattern | Runner | Why this name |
|---|---|---|
| `*.test.ts`, `*.test.tsx` | `bun test` | Default discovery for the Bun runner |
| `*.vtest.tsx` | `vitest` (Solid render) | Bun's discovery would otherwise grab `.test.tsx` and choke on the Solid JSX runtime; the distinct extension keeps the two runners apart |
| `*.property.test.ts` | `bun test` | fast-check sweeps; same runner but the suffix makes "what does this test" obvious in the dir listing |
| `*.fuzz.ts` | Jazzer.js | These are entry points (not test files); Jazzer.js calls them directly |
| `*.bench.ts` | bun runtime | `bun run …`, not test discovery |
| `*.spec.ts` | `bun test` | Reserved — avoid for new code so the conventions stay tight |

## Directory layout (packages/core)

| Directory | Holds |
|---|---|
| `src/__properties__/` | fast-check property tests |
| `src/__metamorphic__/` | invariants under transformation |
| `src/__diff__/` | differential testing vs reference impls |
| `src/__conformance__/` | spec.json runners |
| `src/__golden__/{inputs,outputs}/` | approval / golden master fixtures |
| `src/__regressions__/` | pinned counterexamples from past failures |
| `src/__bench__/` | benchmarks + baseline.json |
| `src/__coverage__/` | coverage snapshot + baseline.json |
| `fuzz/` | Jazzer.js harnesses |

The leading double-underscore is intentional: it groups the test-only
directories visually and avoids the chance of one being mistaken for a
runtime module.

## Markers

- `#[ignore]` in Rust tests = perf or watcher tests that depend on
  real-time timing. Run via `cargo test -- --ignored`.
- `#[cfg_attr(miri, ignore)]` in Rust tests = excluded from Miri
  because they touch the filesystem or rely on wall-clock.
- `it.skip(...)` in Bun tests = pending work, with a comment linking
  the issue. Don't skip silently.

## Replay testing rule

When a property test catches a real failure, paste the shrunk
counterexample into `__regressions__/replay.test.ts` with
`examples: [[…]]`. The property test keeps exploring; the replay
pins the exact input that once broke.

## Approval testing rule

Diff in a `__golden__/outputs/*.html` is a hard fail. Regenerate the
golden ONLY with `APPROVE=1 bun run test:approve`, and the resulting
diff must be reviewed in the same commit as the rendering change that
prompted it.

## Tests must name the mutation they kill

Every non-trivial test gets a one-line comment describing the
**source mutation it would catch**. This is the bar for "test with
value" — if you can't name a code change that would flip the test
from green to red, the test is decoration and should be deleted.

Examples that pass the bar:

```tsx
// Mutation captured: dropping the `onChange` prop on the Toggle
// would leave the click silent and the spy never fires.
it("clicking the TOC toggle invokes onToggleToc exactly once", () => { … });

// Mutation: removing `!props.hasRoot` from the toc-hidden classList
// would put the empty gutter next to the dropzone EmptyState.
it("hides the panel on the home screen even when toggle is on", () => { … });
```

Tests that just say *"the component renders"*, *"foo is defined"*,
or *"props are passed"* without an associated mutation are
[forbidden test shapes](./strategies.md#forbidden-test-shapes) and
should be replaced or removed.

## Component extraction for testability

When a piece of UI is hard to cover because the host component is
too large to mount in a vtest (`AppShell`, page-level routes, etc.),
the right move is structural — **extract a child component with a
small prop surface and test that**. See
[Round 6 of the strategies log](./strategies.md#round-6--extract-small-components-so-the-regression-has-somewhere-to-live)
for the canonical TOC-panel example. The pattern:

1. Identify the smallest set of props that captures the behaviour.
2. Move the JSX + classList rules into a new `*.tsx` file.
3. Cover those props with `*.vtest.tsx` cases that name the mutation
   each one kills (see rule above).

The cost of skipping this step is invisible — it's the regression
test you don't write because the host setup is too painful.
