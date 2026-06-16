#!/usr/bin/env bash
# Fast pre-tag gate (~30s vs release-check.sh's ~3min). Skips Stryker
# mutation testing and the full E2E roundtrip — keep those for the
# nightly / release-check run. This script is what you'd hook to a
# pre-tag hook or run before a `git tag v…`.
#
#   bun run release:smoke
set -euo pipefail

cd "$(dirname "$0")/.."

step() {
  printf "\n\033[1;36m▶ %s\033[0m\n" "$1"
}

step "1/7 typecheck"
bun run typecheck

step "2/7 bun test"
bun test

step "3/7 cargo test --lib"
(cd apps/desktop/src-tauri && cargo test --lib)

step "4/7 clippy --all-targets -D warnings"
(cd apps/desktop/src-tauri && cargo clippy --all-targets -- -D warnings)

step "5/7 vitest (UI)"
(cd packages/ui && bun run test:vitest)

# Builds the marketing site — the one packages/ui consumer whose Vite config has
# NO unplugin-icons. A `~icons/*` import sneaking into a shared component (which
# the desktop build resolves fine) breaks here, so it's caught pre-merge instead
# of by the "Deploy Site" CI job afterward. Fast (vite-only, no Rust).
step "6/7 site frontend build (plugin-less packages/ui consumer)"
bun run --filter @asciimark/site build

step "7/7 IPC contract"
bash scripts/check-ipc-contract.sh

printf "\n\033[1;32m✔ release-smoke passed (heavy gates skipped — run release:check for full)\033[0m\n"
