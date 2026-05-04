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
