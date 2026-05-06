# Changelog

Demo release log used by the marketing screenshots.

## 0.10.0 — Workspace navigation

- **Backlinks panel** in the right gutter. Lists every workspace
  doc that references the active file via Markdown link, AsciiDoc
  xref, or AsciiDoc `include::`.
- **Workspace Symbol Search** (`Cmd/Ctrl+Alt+O`) — fuzzy-match
  headings across every doc in the workspace, jump in one click.
- **Reader / Zen mode** (`Cmd/Ctrl+.`) — collapses the chrome,
  centers the preview at a comfortable reading width.
- **Word count + reading time** in the status bar, computed
  against the rendered HTML so `include::` and transcludes are
  factored in.

## 0.9.x — Tabs and split

- VSCode-style preview tabs: italic until pinned, replaced on
  single-click, kept on edit / dblclick / drag.
- TOC right gutter is segmented into Summary and References.
- Mermaid first-render flake fixed: pre-warm + paint-frame await.

## 0.8.x — Multi-pane

- Split editor (`Cmd/Ctrl+\`).
- Per-pane tab list, editor mode, and TOC selection.

## 0.7.x — Workspace basics

- Multi-root workspaces.
- Quick Open, Command Palette, Find in Files.
