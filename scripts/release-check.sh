#!/usr/bin/env bash
# Run before tagging a release. The fast checks already ran in pre-push;
# this adds the heavy gates (mutation + benchmarks + UI render + E2E).
set -euo pipefail

cd "$(dirname "$0")/.."

step() {
  printf "\n\033[1;36m▶ %s\033[0m\n" "$1"
}

step "1/10 typecheck (all workspaces)"
bun run typecheck

step "2/10 bun test"
bun test

# Windows: test executables need the common-controls manifest embedded or they
# die at startup (STATUS_ENTRYPOINT_NOT_FOUND). The env var is scoped to the
# cargo test/coverage invocations ONLY — exported globally it would leak into
# the e2e gate's app build, where tauri-build already embeds a manifest and the
# duplicate fails the link (CVT1100 → LNK1123).
step "3/10 cargo test (incl. perf stress)"
(cd apps/desktop/src-tauri \
  && ASCIIMARK_EMBED_TEST_MANIFEST=1 cargo test --lib \
  && ASCIIMARK_EMBED_TEST_MANIFEST=1 cargo test --lib -- --ignored)

step "4/10 vitest (UI components)"
(cd packages/ui && bun run test:vitest)

# Builds the Starlight marketing/docs site and catches content/schema regressions
# before the post-merge "Deploy Site" CI job.
step "5/10 site frontend build (Starlight)"
bun run --filter @markdraw/site build

step "6/10 cargo coverage (Rust)"
(cd apps/desktop/src-tauri && ASCIIMARK_EMBED_TEST_MANIFEST=1 cargo llvm-cov --lib --summary-only)

step "7/10 conversion benchmarks (smoke)"
bun run packages/core/src/__bench__/conversion.bench.ts

step "8/10 stryker mutation testing on packages/core (~2 min)"
(cd packages/core && bunx stryker run)

step "9/10 E2E (spawns tauri dev, runs specs, tears down)"
bash scripts/run-e2e.sh

step "10/10 dependency audits (advisory: doesn't fail the gate)"
bun run audit:js || true
bun run audit:rust || true

printf "\n\033[1;32m✔ release-check passed\033[0m\n"
