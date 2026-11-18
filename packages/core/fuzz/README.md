# Fuzz harnesses

Coverage-guided fuzzing of input parsers using Jazzer.js.

These harnesses are NOT unit tests — they explore mutation-driven inputs
looking for crashes, hangs (ReDoS), or thrown exceptions in code paths
that ingest untrusted text from disk or `localStorage`.

## Targets

| Harness                  | Function under test                          |
| ------------------------ | -------------------------------------------- |
| `frontmatter.fuzz.mjs`    | `extractFrontmatter` (YAML + body split)     |
| `scan-includes.fuzz.mjs`  | `scanIncludes` + `scanMarkdownIncludes`      |
| `xrefs.fuzz.mjs`          | xref/`<<>>` regex preprocessor (asciidoc)    |
| `schemas.fuzz.mjs`        | Valibot `tryParse` of JSON-tampered storage  |

## Running locally

```bash
bun run fuzz:frontmatter      # 30s budget, default
bun run fuzz:ci               # all targets, sequential
```

Findings (crashes, slow inputs) are written to `findings/`. Corpus seeds
(known-good interesting inputs) live in `corpus/` and are kept across runs.

### Why the harnesses are `.mjs`, not `.ts`

The Jazzer.js CLI loads the named target literally and appends `.js` to any
path that does not already end in `.js`/`.mjs`/`.cjs`, and it does not
transpile TypeScript — so a `.ts` target is never found (`...fuzz.ts.js`).
The harnesses are therefore plain ESM `.mjs` files that import the `src/*.ts`
modules directly; Node's built-in type stripping erases those annotations.
That requires **Node >= 22.18** (type stripping on by default).

## Platform support

Jazzer.js ships precompiled libFuzzer bindings for **Linux**; the verified
configuration here is Linux x64 with Node 26. It will fail to start on:
- macOS arm64 (no prebuilt binary)
- Bun runtime (FFI loader incompatibility) — the `jazzer` script runs under Node

Node >= 22.18 is required because the harnesses import TypeScript sources
(see above).

Locally on macOS, run the fast-check robustness sweeps (see
`__properties__/robustness.property.test.ts`) — they exercise the same
parsers with thousands of randomized inputs and run on Bun directly. They
do not have coverage-guided mutation, so a Jazzer.js run on Linux remains
the authoritative robustness check.

## CI

No CI workflow runs the fuzzers today. Run `bun run fuzz:ci` locally on
Linux with Node >= 22.18 (see Platform support above).
