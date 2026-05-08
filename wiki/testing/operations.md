---
title: "Testing — how to run everything"
audience: dev
sources:
  - repo:./package.json
  - repo:./lefthook.yml
  - repo:./scripts/release-check.sh
  - repo:./scripts/release-smoke.sh
  - repo:./scripts/coverage-snapshot.sh
updated: 2026-05-04
tags: [testing, runbook, lefthook, scripts]
status: stable
---

# Testing — how to run everything

Single page that lists every gate this repo ships with. Conceptual rationale lives in [strategies](strategies.md); this file is the operations reference.

> If a gate isn't listed here, it doesn't exist.
> If a script isn't here, treat it as deprecated.

## Daily workflow

| Command | Time | What it covers |
|---|---|---|
| `bun test` | <1s | Unit + properties + metamorphic + diff + conformance + golden + replay (188 tests) |
| `bun run test:vitest` *(in `packages/ui`)* | ~1.5s | Solid render tests (48): 11 primitives + EmptyState + 17 cobrindo editor / preview / file-tree |
| `bun run test:rust` | <1s warm | Cargo unit + mock_app + proptest (28 tests, 7 ignored) |
| `bun run typecheck` | ~3s | tsc strict in all workspaces |
| `bun run lint:rust` | ~2s warm | clippy --all-targets -D warnings |
| `bun run test:contract` | <1s | IPC drift between Rust commands and frontend invokes |

The `pre-commit` hook runs **all of the above in parallel** (~3s). See
`lefthook.yml`.

## Per-feature gates

| Command | Time | What it does |
|---|---|---|
| `bun run test:approve` | <1s | Regenerate golden HTML in `__golden__/outputs/` after intentional rendering changes |
| `bun run test:bench` | ~7s | Markdown / AsciiDoc conversion bench. Captures baseline on first run, fails on regression > 25% on subsequent runs |
| `BENCH_UPDATE_BASELINE=1 bun run test:bench` | ~7s | Accept the current numbers as the new baseline |
| `bun run test:rust:stress` | ~2s | Perf gates marked `#[ignore]`: 5k files < 1s, node_modules skip < 50ms, 100 levels deep |
| `bun run test:loom` | ~2s | Permutation-exhaustive concurrency test on the `WatcherHolder` Mutex |
| `bun run test:miri` | n/a | Configured but blocked by a `ctor` macro in `tauri-plugin-mcp-bridge`. See `.cargo/config.toml` |
| `bun run cov:rust` | ~1min | cargo-llvm-cov HTML report (opens in browser) |
| `bun run cov:rust:summary` | ~30s | Coverage summary in terminal |
| `bun run coverage:snapshot` | ~2min | Capture Bun + Rust coverage snapshot, diff against `packages/core/__coverage__/baseline.json`. Fails if any metric drops > 2pp |
| `COVERAGE_UPDATE_BASELINE=1 bun run coverage:snapshot` | ~2min | Accept new coverage as the floor |
| `bun run type-coverage` | ~10s | Strict-mode type coverage on `packages/core` (threshold 95%) |
| `bun run audit` | ~3s | `bun audit --prod` + `cargo audit`. Last run surfaced 23 advisories (all moderate, all transitive in dev tooling) — no critical/high. The `happy-dom < 20.0.0` RCE, `vite ≤ 7.3.1` file-read, and `mermaid <= 11.x` DOMPurify chain were all bumped on commit `1e2b725`. |

## Mutation, fuzzing, soak

| Command | Time | Where it runs |
|---|---|---|
| `bun run test:mutation` *(in `packages/core`)* | ~2min | StrykerJS mutation testing on TS core |
| `bun run test:mutation:rust` | ~5-10min | `cargo-mutants` on Rust pure helpers |
| `bun run fuzz:frontmatter` *(in `packages/core`)* | 30s budget | Jazzer.js (Linux/Node 20 only) |
| `bun run fuzz:scan-includes` *(idem)* | 30s | idem |
| `bun run fuzz:xrefs` *(idem)* | 30s | idem |
| `bun run fuzz:schemas` *(idem)* | 30s | idem |
| `bun run fuzz:ci` *(idem)* | ~2min | All four sequential |
| `bun run test:memlab` *(in `apps/desktop`)* | depends | memlab soak — needs `bun run dev:app` running on :2444 |

### Mutation testing — when to run

`cargo-mutants` is **manual / on-demand**, not a pre-push gate. Benchmark (2026-05-08) measured 4m 28s worst-case across 57 mutants, with 11 surviving. A blocking gate would force every dev to wait minutes per push *and* block any push touching the helper zone of `lib.rs` until those 11 are addressed (tracked separately).

Run `bun run test:mutation:rust` when:

- You modified logic in the helper zone of `apps/desktop/src-tauri/src/lib.rs` (lines 57-403 — `read_dir`, `read_file`, `find_in_files`, `write_file`, `rename_file`, `trash_path`, `read_dir_recursive`, etc.)
- You added a new function inside the same zone and want to verify the tests cover it
- You're prepping a release and want a clean coverage baseline

The agents (Claude Code, Codex, OpenCode) ship a small **suggestion hook**
in `.claude/hooks/`, `.codex/hooks/`, and `.opencode/plugins/` — when the
agent is about to invoke `git push` and the diff `origin/main..HEAD`
touches the helper zone, the hook prints a one-line reminder. The hook
never blocks; the call is yours.

References: Linear DJA-36 (decision rationale + benchmark) · Linear DJA-43
(close the 11 surviving mutations as a pre-requisite for revisiting the
gate).

## E2E

| Command | What it does |
|---|---|
| `bun run dev:app` *(terminal A)* | Starts Tauri dev. Bridge listens on `ws://127.0.0.1:9223` |
| `cd apps/desktop && bun test e2e/specs` *(terminal B)* | Runs the WebSocket-driven specs. Specs auto-skip in ~58ms when the bridge is unreachable |
| `bash scripts/run-e2e.sh` | Spawns dev:app, waits for the bridge, runs specs, kills the process group |
| `?chaos=10` URL param in `dev:app` | Activates IPC fault injection — ~10% of `invoke()` calls reject with a synthetic error. See `apps/desktop/src/lib/__chaos__/README.md` |

## Release pipeline

| Command | Time | When |
|---|---|---|
| `bun run release:smoke` | ~30s | Before `git tag v…`. Typecheck + bun test + cargo test + clippy + vitest + IPC contract |
| `bun run release:check` | ~3min | Full gate, 9 steps: typecheck → bun test → cargo test (incl. `--ignored` perf gates) → vitest → cargo-llvm-cov summary → conversion benchmarks (vs baseline) → StrykerJS mutation testing → E2E (spawns `tauri dev`) → `bun audit` + `cargo audit` (advisory) |

## CI

Only **build + deploy** run in CI:

- `.github/workflows/build-desktop.yml` — multi-platform Tauri bundles, signing, publishes to `djalmajr/asciimark-releases`
- `.github/workflows/deploy-site.yml` — GitHub Pages

Tests run **locally** via Lefthook (pre-commit + pre-push). To opt into
running them in CI later, the gate of choice is `release:smoke` or
`release:check` invoked from `build-desktop.yml`.

## File-naming conventions

| Pattern | Runner |
|---|---|
| `*.test.ts`, `*.test.tsx` | `bun test` |
| `*.vtest.tsx` | `vitest` (Solid render) |
| `*.property.test.ts` | `bun test` (fast-check sweeps) |
| `*.fuzz.ts` | Jazzer.js (`bun run fuzz:*`) |
| `*.bench.ts` | `bun run test:bench` |
| `*.spec.ts` | reserved — bun discovers these too |

The `.vtest.tsx` distinction exists because both runners' default globs
match `.test.*` and `.spec.*`. Vitest is JSX-aware; bun isn't (with
Solid). Don't blur the line.

## Where things live

```
packages/core/src/
  __properties__/          fast-check (frontmatter, tabs, recent-files,
                           utils, robustness, i18n)
  __metamorphic__/         transformation invariants
  __diff__/                differential vs marked
  __conformance__/         CommonMark spec.json runner
  __golden__/              approval testing fixtures + .html locks
  __regressions__/         pinned counterexamples from past failures
  __bench__/               conversion bench + baseline.json
  __coverage__/            coverage baseline + last-run.json
  fuzz/                    Jazzer.js harnesses

apps/desktop/
  src-tauri/
    src/lib.rs             #[cfg(test)] mod tests — unit + mock_app
                           + proptest + perf-gate + ignored stress
    benches/read_dir.rs    criterion bench
    .cargo/mutants.toml    cargo-mutants config
    .cargo/config.toml     Miri config (deferred — see file)
  src/lib/chaos-invoke.ts  fault injection wrapper
  e2e/                     E2E specs + fixtures + memlab scenario

packages/ui/src/
  components/ui/*.vtest.tsx        primitive render tests
  components/empty-state.vtest.tsx domain component tests
  composables/__property__/        stateful PBT (createTabStore)

tools/loom-watcher-tests/  Loom permutation tests (sub-crate)
wiki/testing/strategies.md Strategy doc & rationale
```

## Strategies index → file

| Strategy | Where |
|---|---|
| Unit (Bun + Cargo) | inline in source |
| Property-based (TS) | `packages/core/src/__properties__/` |
| Property-based (Rust) | `apps/desktop/src-tauri/src/lib.rs` `proptest!` block |
| Stateful PBT | `packages/ui/src/composables/__property__/` |
| Metamorphic | `packages/core/src/__metamorphic__/` |
| Differential | `packages/core/src/__diff__/markdown-vs-marked.test.ts` |
| Conformance suite | `packages/core/src/__conformance__/` |
| Approval / golden | `packages/core/src/__golden__/` |
| Replay (pinned) | `packages/core/src/__regressions__/` |
| Mutation (TS) | `packages/core/stryker.config.json` |
| Mutation (Rust) | `apps/desktop/src-tauri/.cargo/mutants.toml` |
| Fuzzing | `packages/core/fuzz/` |
| Render (Solid) | `packages/ui/src/**/*.vtest.tsx` |
| E2E | `apps/desktop/e2e/` |
| Loom | `tools/loom-watcher-tests/` |
| Miri | `apps/desktop/src-tauri/.cargo/config.toml` (blocked) |
| Soak (memlab) | `apps/desktop/e2e/memory/` |
| Chaos (IPC) | `apps/desktop/src/lib/chaos-invoke.ts` |
| IPC contract | `scripts/check-ipc-contract.sh` |
| Bench regression | `packages/core/src/__bench__/conversion.bench.ts` |
| Coverage snapshot | `scripts/coverage-snapshot.sh` |
| Type coverage | `packages/core` `bun run type-coverage` |
| Schema validation (runtime) | `packages/core/src/schemas.ts` (Valibot) |
| Lint (Rust) | `cargo clippy --all-targets -- -D warnings` |
| Audit | `bun audit` + `cargo audit` |

For rationale (why each technique was adopted or rejected, what bugs
each catches), see [strategies.md](strategies.md).
