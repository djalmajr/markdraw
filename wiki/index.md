# AsciiMark — wiki

Local knowledge base. Sourced from this repo only; agents use it via
QMD semantic search instead of grepping the source tree blindly.

## Topics

- [Testing strategies](testing/strategies.md) — rationale per technique
- [Testing operations](testing/operations.md) — how to run every gate
- [Architecture overview](architecture/overview.md) — apps + packages
- [Performance targets](performance/targets.md) — perf gates and benches
- [Release flow](release/flow.md) — bump → tag → publish
- [IPC contract](architecture/ipc.md) — Rust ↔ Solid commands
- [Test conventions](testing/conventions.md) — naming, layout, markers

## How the wiki is indexed

`scripts/wiki-init.ts install` configured a local QMD collection
called `asciimark` rooted at `./wiki`. Run `qmd update` to reindex
after edits, `qmd embed` to refresh embeddings.

## Boundaries

- The wiki is **prose**: rationale, decisions, conventions, indexes.
- Code lives outside the wiki. Code-level docs (`README.md` in
  subdirs) are reference; the wiki points at them.
- Issues are still the source of truth for individual plan/work items
  (`gh issue list --repo djalmajr/asciimark`); the wiki is for the
  durable knowledge that survives the issue.
