# Architecture overview

## Workspaces

```
asciimark/                    bun workspace root
├── apps/
│   ├── desktop/              Tauri 2 desktop app (Solid + Vite)
│   │   ├── src/              Solid frontend
│   │   └── src-tauri/        Rust backend (lib.rs)
│   ├── extension/            Browser extension (Chrome MV3)
│   └── site/                 Public marketing site (TanStack Router)
├── packages/
│   ├── core/                 Pure logic — markdown/asciidoc conversion,
│   │                         frontmatter, schemas, TOC, kroki, fonts
│   └── ui/                   Solid components shared across apps:
│                              composables (state stores), primitives
│                              (Kobalte-based), and domain components
│                              (editor, preview, file-tree, etc)
└── tools/
    └── loom-watcher-tests/   Concurrency permutation tests, isolated
                              from the Tauri build to avoid std::sync
                              clash with `loom::sync` shims.
```

## Code paths that matter

- **`packages/core/src/markdown.ts` and `convert-worker.ts`**: two
  copies of the markdown pipeline (main thread + Web Worker). Keep
  them in sync. The convert-worker is what runs in production for
  large docs; main-thread version is fallback / used by tests.
- **`packages/core/src/asciidoc.ts`**: asciidoctor.js bound to a custom
  include processor and xref preprocessor.
- **`apps/desktop/src-tauri/src/lib.rs`**: every IPC command, the
  recursive `read_dir`, the path-traversal guard, the watcher state.
  `pub fn` helpers are extracted so unit tests can hit them without
  spawning a Tauri runtime.
- **`packages/ui/src/composables/create-tab-store.ts`**: the tab store
  the user actually sees; signals + stack of closed tabs. Stateful
  property-based testing covers it under arbitrary command sequences.
- **`packages/ui/src/composables/create-app-state.ts`**: the rest of
  app state — fonts, theme, sidebar, navigation. NOT yet covered by
  tests beyond what tab-store touches.

## Worker boundaries

- Markdown / AsciiDoc conversion runs in a Web Worker
  (`convert-worker.ts?worker` wired in `apps/desktop/src/app.tsx`).
- The main thread does include resolution (depends on platform
  `readFile`), then ships the assembled body + cache to the worker.
- `tabStore.persistSession()` debounces 500ms before touching
  localStorage to avoid jank on rapid tab swaps.

## Native APIs (Rust)

- `notify` + `notify-debouncer-mini` for FSEvents/inotify/
  ReadDirectoryChangesW (cross-platform watcher).
- `trash` v5 for safe deletion.
- `objc2` only on macOS for the toggle-maximize animation; everything
  is `unsafe` FFI into AppKit. Miri does NOT model this code.
- `tauri-plugin-mcp-bridge` runs only under `#[cfg(debug_assertions)]`
  — release builds get stripped by LTO.

See [IPC contract](ipc.md) for the command list.
