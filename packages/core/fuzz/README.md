# Fuzz harnesses

Coverage-guided fuzzing of input parsers using Jazzer.js.

These harnesses are NOT unit tests — they explore mutation-driven inputs
looking for crashes, hangs (ReDoS), or thrown exceptions in code paths
that ingest untrusted text from disk or `localStorage`.

## Targets

| Harness                  | Function under test                          |
| ------------------------ | -------------------------------------------- |
| `frontmatter.fuzz.ts`    | `extractFrontmatter` (YAML + body split)     |
| `scan-includes.fuzz.ts`  | `scanIncludes` + `scanMarkdownIncludes`      |
| `xrefs.fuzz.ts`          | xref/`<<>>` regex preprocessor (asciidoc)    |
| `schemas.fuzz.ts`        | Valibot `tryParse` of JSON-tampered storage  |

## Running locally

```bash
bun run fuzz:frontmatter      # 30s budget, default
bun run fuzz:ci               # all targets, sequential
```

Findings (crashes, slow inputs) are written to `findings/`. Corpus seeds
(known-good interesting inputs) live in `corpus/` and are kept across runs.

## Platform support

Jazzer.js ships precompiled libFuzzer bindings for **Linux x64 / Node 18-20
LTS only**. It will fail to start on:
- macOS arm64 (no prebuilt binary)
- Bun runtime (FFI loader incompatibility)
- Node 22+

Locally on macOS, run the fast-check robustness sweeps (see
`__properties__/robustness.property.test.ts`) — they exercise the same
parsers with thousands of randomized inputs and run on Bun directly. They
do not have coverage-guided mutation, so the CI Jazzer.js job remains the
authoritative robustness gate.

## CI

`.github/workflows/nightly-quality.yml` runs `fuzz:ci` on Ubuntu / Node 20
nightly and on PRs labeled `fuzz`. Crash artifacts are uploaded as
`fuzz-findings`.
