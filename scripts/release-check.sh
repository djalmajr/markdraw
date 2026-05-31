#!/usr/bin/env bash
# Run before tagging a release. The fast checks already ran in pre-push;
# this adds the heavy gates (mutation + benchmarks + UI render + E2E).
set -euo pipefail

cd "$(dirname "$0")/.."

step() {
  printf "\n\033[1;36m▶ %s\033[0m\n" "$1"
}

step "1/9 typecheck (all workspaces)"
bun run typecheck

step "2/9 bun test"
bun test

step "3/9 cargo test (incl. perf stress)"
(cd apps/desktop/src-tauri && cargo test --lib && cargo test --lib -- --ignored)

step "4/9 vitest (UI components)"
(cd packages/ui && bun run test:vitest)

step "5/9 cargo coverage (Rust)"
(cd apps/desktop/src-tauri && cargo llvm-cov --lib --summary-only)

step "6/9 conversion benchmarks (smoke)"
bun run packages/core/src/__bench__/conversion.bench.ts

step "7/9 stryker mutation testing on packages/core (~2 min)"
(cd packages/core && bunx stryker run)

step "8/9 E2E (spawns tauri dev, runs specs, tears down)"
bash scripts/run-e2e.sh

step "9/9 dependency audits (advisory: doesn't fail the gate)"
bun run audit:js || true
bun run audit:rust || true

printf "\n\033[1;32m✔ release-check passed\033[0m\n"
