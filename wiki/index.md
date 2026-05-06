# AsciiMark — wiki

Local knowledge base. Sourced from this repo only; agents use it via
QMD semantic search instead of grepping the source tree blindly.

## Topics

- [Testing strategies](testing/strategies.md) — rationale per technique
- [Testing operations](testing/operations.md) — how to run every gate
- [Architecture overview](architecture/overview.md) — apps + packages
- [i18n architecture](architecture/i18n.md) — Paraglide + Solid adapter, `(useLocale(), m.foo())` pattern, locale detection, parity gate
- [Desktop updater](architecture/desktop-updater.md) — pending-update signal, custom scrollable modal (vs native `ask()`), tray-close coordination
- [Keyboard shortcuts — three-source rule](architecture/keyboard-shortcuts.md) — every binding lands in catalog + handler + command palette in the same change; OS-reserved keys table
- [Preview pipeline](architecture/preview-pipeline.md) — render order (sanitize → highlight → swap → paint → mermaid/kroki), mermaid first-render fix, cross-file nav → TOC active sync
- [Performance targets](performance/targets.md) — perf gates and benches
- [Release flow](release/flow.md) — desktop: bump → tag → publish (Tauri auto-update)
- [Extension release](release/extension.md) — Chrome Web Store: bump → build → zip → upload
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
