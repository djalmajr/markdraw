# AsciiMark - Backlog

## Implemented Features

### Syntax Highlighting
- [x] Integrate highlight.js for code blocks
- [x] Dark mode code theme (github / github-dark-dimmed)

### Diagrams
- [x] Mermaid rendering (AsciiDoc `[mermaid]` block + Markdown fenced blocks)
- [x] Mermaid theme initialization based on current dark/light mode

### Navigation
- [x] Back/forward navigation via browser history (`pushState` + `popstate`)
- [x] Hash-based SPA routing (`#/path/to/file.adoc`)
- [x] Cross-reference (xref) link navigation between files

### Export
- [x] PDF export via `window.print()` with comprehensive print CSS

### UI/UX
- [x] Dark/light theme toggle (persisted in localStorage)
- [x] System color scheme detection on first load (before user toggle)
- [x] Resizable sidebar (drag-to-resize)
- [x] Sidebar toggle (show/hide)
- [x] Table of Contents sidebar with scroll-based active heading tracking
- [x] TOC toggle (show/hide)
- [x] Breadcrumb navigation in toolbar

### Document Processing
- [x] AsciiDoc rendering via `@asciidoctor/core`
- [x] Markdown rendering via `markdown-it` with 14 plugins (task lists, KaTeX math, GitHub alerts, footnotes, emoji, definition lists, abbreviations, sub/sup, ins, mark, advanced tables, custom containers)
- [x] Recursive `include::` resolution for AsciiDoc
- [x] Recursive `<!-- include: path -->` resolution for Markdown (with circular include detection)
- [x] KaTeX math rendering for Markdown

### File Management
- [x] File System Access API with `webkitdirectory` fallback
- [x] File tree with recursive directory structure
- [x] Directory handle persistence in IndexedDB (session restore)
- [x] Auto-refresh / file watching (polling-based, 2s interval)

### Chrome Extension
- [x] Manifest v3 with content scripts for `.adoc`/`.md` URL detection
- [x] Automatic rendering of AsciiDoc/Markdown files opened in browser
- [x] File access denied warning with instructions

---

## Planned Features

### Editing
- [x] Inline editor for `.adoc` files (split view: editor + preview)
- [x] Save changes back to filesystem via File System Access API
- [x] Keyboard shortcuts (Ctrl+S to save, etc.)

### Scroll Sync
- [x] Bidirectional scroll sync between editor and preview
- [ ] Source mapping from AsciiDoc lines to HTML elements

### Security
- [ ] Configurable safe mode (`unsafe`, `safe`, `server`, `secure`)
- [ ] HTML sanitization option for untrusted content (DOMPurify)
- [ ] Content Security Policy (CSP) headers
- [ ] Option to disable `include::` resolution

### Syntax Highlighting
- [x] Theme selection for code highlighting

### Search
- [x] Full-text search within file tree
- [x] Search within preview content (Ctrl+F overlay)

### Navigation
- [ ] Bookmarks / favorites
- [x] Recent files list
- [ ] Multiple tabs for preview
- [x] Back/forward navigation buttons in the UI

### Diagrams
- [x] Asciidoctor diagram support via Kroki API
- [x] PlantUML rendering
- [x] Ditaa rendering

### Export
- [x] Direct PDF generation (html2pdf.js or similar)
- [ ] Export to EPUB
- [ ] Export to DocBook

### UI/UX
- [x] System/auto theme option exposed in the UI
- [x] Configurable font size and family
- [ ] Customizable CSS for preview
- [x] Keyboard navigation in file tree
- [x] Drag and drop files

### Desktop App (Tauri)
- [x] Tauri scaffold com SolidJS frontend
- [x] File system nativo (read/write via Tauri API)
- [x] Save de arquivos editados (Ctrl+S direto no filesystem)
- [ ] Export to EPUB (via pandoc ou lib nativa)
- [ ] Export to DocBook
- [ ] Menus nativos (File, Edit, View, Help)
- [ ] Associação de tipos de arquivo (.adoc, .md) com o app
- [ ] Auto-update via Tauri updater
- [ ] Tray icon / menu bar (opcional)

### Infrastructure
- [x] Monorepo com workspaces (Bun)
- [ ] GitHub Pages para documentação pública
- [x] CI/CD para build da extensão e do desktop app

---

## Testing Backlog

### Done
- [x] `packages/core` unit tests (~98% line / 98% func coverage)
- [x] `packages/core` property-based tests (fast-check, ~7600 expect calls)
- [x] `packages/core` robustness sweeps (mirror das fuzz harnesses no Bun)
- [x] Schema validation runtime via Valibot (recent-files, recent-folders, favorites, tabs)
- [x] Mutation testing setup (StrykerJS) — score baseline 65.63%
- [x] Fuzz harnesses (Jazzer.js) — Linux/Node 20 only
- [x] Rust unit tests para `read_dir_recursive`, `read_file_relative`, `rename_file_impl`, `resolve_within_root` (path-traversal, symlink escape)
- [x] Rust mock-runtime tests (`tauri::test::MockRuntime`) — state lifecycle dos watchers
- [x] `make_watcher` unit tests (debounce real, recursive vs non-recursive, drop limpa callbacks)
- [x] Rust performance benches (`cargo bench --bench read_dir`) — flat 500/5k/25k, deep_50, wide_3x4/8x4, monorepo_like com node_modules
- [x] Rust performance gates (testes `#[ignore]`): 5k arquivos < 1s, node_modules skip < 50ms, 100 níveis de profundidade
- [x] Conversion benchmarks Bun (markdown/asciidoc small/large)
- [x] Vitest + vite-plugin-solid + unplugin-icons em `packages/ui` — 31 testes (5 primitivos + EmptyState)
- [x] E2E specs com `tauri-plugin-mcp-bridge` — `bridge.ts` WebSocket client + `workspace.tauri.test.ts` + `golden-path.webview.test.ts` (graceful skip quando bridge offline)
- [x] Pre-commit hook (Lefthook): typecheck + bun test + cargo test --lib + vitest paralelo (~2.5s)
- [x] `scripts/release-check.sh` — pipeline de 8 etapas para gate de release manual
- [x] Coverage Rust via `cargo-llvm-cov` (`bun run cov:rust:summary` → 57.57% line / 41.73% func)

### Pending — testes
- [ ] **Validar E2E end-to-end real**: subir `bun run dev:app` em terminal separado, rodar `cd apps/desktop && bun test e2e/specs`, confirmar que `bridge.invoke('read_dir', …)` retorna entries reais. Limitação do ambiente Claude Code impediu validação em sessão.
- [ ] Adicionar bench de E2E (latency real do `invoke` round-trip via webview)
- [ ] Render tests dos 13 componentes de domínio restantes em `packages/ui/src/components/*.tsx` (`editor`, `preview`, `file-tree`, `tab-bar`, `toolbar`, `editor-toolbar`, `content-toolbar`, `confirm-dialog`, `diagram-viewer`, `frontmatter-panel`, `search-overlay`, `file-tree-item`, `file-access-warning`)
- [ ] Render tests dos 7 primitivos UI restantes em `packages/ui/src/components/ui/` (`alert-dialog`, `context-menu`, `dropdown-menu`, `tabs`, `toast`, `tooltip`)
- [ ] Tests para `packages/ui/src/composables/create-app-state.ts` (atualmente só `create-tab-store` é testado)
- [ ] Coverage instrumentado para `packages/ui` — meta `> 80%` line nos primitivos
- [ ] Vitest watch mode no lefthook (rodar só os arquivos afetados em pre-commit, não a suite toda)
- [ ] `apps/desktop/src/**` — zero coverage de código de aplicação (lib/updater, lib/window-controls, etc.)
- [ ] `apps/extension/src/**` — zero coverage
- [ ] `apps/site/src/**` — zero coverage
- [ ] Tests para os comandos Tauri ainda sem cobertura: `open_directory_dialog`, `set_dock_visible`, `print_webview`, `toggle_maximize_instant`, `get_startup_args` — todos requerem APIs nativas ou dialog real, melhor cobrir via E2E
- [ ] Visual regression (screenshot diff) — deferred, tier 4
- [ ] Subir mutation score de 65.63% → 80% (escrever testes específicos pros sobreviventes — `markdown.ts` está em 45% no Stryker, é o pior alvo)
- [ ] Wire `bun run release:check` no `build-desktop.yml` antes do `tauri build` quando o usuário quiser voltar a usar CI para qualidade

### Pending — infra
- [ ] Workflow CI nightly opcional para Stryker + Jazzer.js (Linux runner) — atualmente só roda local via `bun run release:check`
- [ ] Adicionar `cargo-llvm-cov` ao `release-check.sh` com gate de threshold (falha se cair abaixo de N%)
- [ ] Documentar no `CLAUDE.md` Section 11 ou criar `TESTING.md` com o fluxo completo (hooks, scripts, conventions de `.test.ts` vs `.vtest.tsx`)
