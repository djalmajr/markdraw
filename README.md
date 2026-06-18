# Markdraw

A local-first viewer and editor for AsciiDoc and Markdown — runs as
a desktop app (Tauri) or a Chrome extension. Diagrams, math, split
panes, workspace symbol search, backlinks, and a keyboard-first
navigation layer; everything renders locally without telemetry.

## Install

* **Desktop** — pre-built signed installers for macOS (arm64 + x64),
  Linux (AppImage + .deb), and Windows (MSI + EXE) at
  [github.com/djalmajr/asciimark](https://github.com/djalmajr/asciimark/releases/latest).
  Auto-update wired in via the Tauri updater.
* **Chrome extension** —
  [Chrome Web Store listing](https://chromewebstore.google.com/detail/asciimark/dmcihjkjbeckainfkaddpkeghlllmkbk).
  Renders `.adoc` and `.md` URLs directly in the tab.
* **Website** — [djalmajr.github.io/asciimark](https://djalmajr.github.io/asciimark/)
  (downloads, guide, privacy).

## What's inside

* AsciiDoc (Asciidoctor) and Markdown (markdown-it, 14 plugins).
* Mermaid + Kroki diagrams. KaTeX math.
* `include::` resolution (recursive) and Markdown transclude.
* Split panes (Cmd/Ctrl+\\) — independent tabs, editor mode, TOC
  per pane.
* VS Code–style preview tabs (italic until edited or pinned).
* Quick Open (Cmd/Ctrl+P), Command Palette (⇧+P), Go to Heading
  (⇧+O), Workspace Symbols (⌥+O), Find in Files (⇧+F),
  Reader/Zen mode (.).
* Backlinks panel + workspace-wide heading search across every doc.
* Multi-root workspaces, recent files/folders, favorites.
* Mac/Linux/Windows file-system watcher with debouncing.
* Local-first: no analytics, no telemetry, no Markdraw backend.

## Status

Active development. v0.10.0 shipped in May 2026; v0.11.0 in flight.
Roadmap visible inside the wiki/private repo; public AI Assistant
integration tracked openly.

## Privacy

See [privacy policy](https://djalmajr.github.io/asciimark/privacy.html).
TL;DR: no data leaves your machine except (1) the document URL you
explicitly point the viewer at, (2) Kroki diagram blocks sent as
plain text to `kroki.io` for SVG rendering, (3) the GitHub Releases
poll done by the desktop auto-updater.

## Tech stack

[Tauri 2](https://v2.tauri.app) (desktop runtime),
[SolidJS](https://solidjs.com) (UI),
[Vite](https://vitejs.dev),
[Tailwind CSS](https://tailwindcss.com),
[Kobalte](https://kobalte.dev) (UI primitives),
[@asciidoctor/core](https://github.com/asciidoctor/asciidoctor.js),
[markdown-it](https://github.com/markdown-it/markdown-it),
[Prism](https://prismjs.com),
[Mermaid](https://mermaid.js.org),
[KaTeX](https://katex.org).

## Repo layout

```
asciimark/
├── apps/
│   ├── desktop/       # Tauri desktop app (the primary target)
│   ├── extension/     # Chrome extension
│   └── site/          # djalmajr.github.io/asciimark (SolidJS)
├── packages/
│   ├── core/          # AsciiDoc/Markdown conversion + schemas
│   ├── ui/            # Shared SolidJS components + styles
│   └── i18n/          # paraglide-js catalog (en / pt-BR / es)
└── tools/             # Stand-alone test crates (loom, miri)
```

## Source-available, not open source

The source is public so anyone can audit security or report bugs,
but the code is **not licensed for reuse, redistribution, or
competing products**. See [LICENSE](./LICENSE) and
[LICENSING.md](./LICENSING.md) for the precise terms.

To use Markdraw: install one of the official binaries linked above.
That's free, forever.

For commercial licensing (embedding, redistribution, source under
different terms), reach out: djalmajr@gmail.com.

"Markdraw" and the Markdraw logo are trademarks of Djalma Júnior.

## Contributing

Issues and pull requests are welcome. By opening a PR you grant
Djalma Júnior an irrevocable, perpetual, royalty-free license to
incorporate the contribution under any terms (see `LICENSE`).
