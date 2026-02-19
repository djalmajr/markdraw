# AsciiDoc Viewer - Backlog

## Planned Features

### Editing
- [ ] Inline editor for `.adoc` files (split view: editor + preview)
- [ ] Save changes back to filesystem via File System Access API
- [ ] Keyboard shortcuts (Ctrl+S to save, etc.)

### Scroll Sync
- [ ] Bidirectional scroll sync between editor and preview
- [ ] Source mapping from AsciiDoc lines to HTML elements

### Security
- [ ] Configurable safe mode (`unsafe`, `safe`, `server`, `secure`)
- [ ] HTML sanitization option for untrusted content
- [ ] Content Security Policy (CSP) headers
- [ ] Option to disable `include::` resolution

### Syntax Highlighting
- [ ] Integrate highlight.js or Prism.js for code blocks
- [ ] Theme selection for code highlighting

### Search
- [ ] Full-text search within file tree
- [ ] Search within preview content (Ctrl+F)

### Navigation
- [ ] Bookmarks / favorites
- [ ] Recent files list
- [ ] Multiple tabs for preview
- [ ] Back/forward navigation between files

### Diagrams
- [ ] Asciidoctor diagram support via Kroki API
- [ ] PlantUML, Mermaid, Ditaa rendering

### Export
- [ ] Direct PDF generation (html2pdf.js or similar)
- [ ] Export to EPUB
- [ ] Export to DocBook

### UI/UX
- [ ] Manual theme toggle (light/dark/auto)
- [ ] Configurable font size and family
- [ ] Customizable CSS for preview
- [ ] Keyboard navigation in file tree
- [ ] Drag and drop files
