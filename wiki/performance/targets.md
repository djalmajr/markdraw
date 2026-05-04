# Performance targets

Every number here is a perf gate, not a guideline. Regressions
beyond the documented threshold fail `release-check` (or the bench
gate in pre-commit-adjacent runs).

## `read_dir_recursive` (Rust, native)

Hard gates (in `apps/desktop/src-tauri/src/lib.rs`, `#[ignore]` —
opt in via `cargo test -- --ignored`):

| Scenario | Limit |
|---|---:|
| 5,000 flat files | < 1 s |
| 10k files inside `node_modules` (filtered) | < 50 ms |
| 100-level deep recursion | survives without stack overflow |

Soft baselines (criterion bench in `benches/read_dir.rs`, Apple
Silicon reference):

| Cenário | Mediana |
|---|---:|
| flat 500 | 611 µs |
| flat 5,000 | 7.0 ms |
| flat 25,000 | 40.6 ms |
| wide 8×4 (~28k) | 130.8 ms |
| monorepo (3.2k visible + 10k filtered) | 4.7 ms |

Filter design: the `IGNORED_DIRS` early-exit cuts before recursing,
so a `node_modules` of any size is O(1) at this layer.

## Markdown / AsciiDoc conversion (TS)

Bench at `packages/core/src/__bench__/conversion.bench.ts`. Captures
`baseline.json` per `(platform, runtime)`. Fails if any scenario
regresses by more than `BENCH_REGRESSION_PCT` (default 25%).

Reference numbers (Apple Silicon, post-fix that eliminated the
double parse):

| Doc | Mean |
|---|---:|
| Markdown small (~10 headings) | 4.6 ms |
| Markdown large (~80 headings) | 67.3 ms |
| AsciiDoc small | 6.5 ms |
| AsciiDoc large | 42.4 ms |

To accept a slowdown intentionally:

```bash
BENCH_UPDATE_BASELINE=1 bun run test:bench
```

## CommonMark conformance (TS)

Floor 60% (gate). Current 81.0%. Per-section breakdown is reported
to stdout on every run; the lowest sections are intentional drifts
from spec because of plugins (`markdown-it-anchor` adds IDs that
spec output lacks; `breaks: true` redefines `\n` semantics).

## Type coverage (TS)

Floor 95% on `packages/core`. Current 96.45%. Untyped pockets are
`JSON.parse` results that ought to round-trip through Valibot
schemas — captured as a follow-up in `BACKLOG.md`.

## Test runtime budgets

| Gate | Budget |
|---|---:|
| Pre-commit (parallel, 6 jobs) | ≤ 5 s on developer machines |
| `release:smoke` | ≤ 1 min |
| `release:check` | ≤ 5 min |

Pre-commit is the most expensive number people see often — keep it
under 5s. If a new gate would push it over, move the gate into
release-smoke.
