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
- [ ] Bidirectional scroll sync between editor and preview
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
