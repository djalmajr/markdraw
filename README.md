# AsciiMark

A viewer for AsciiDoc and Markdown files with syntax highlighting, diagrams, math, and more. Works as a Chrome extension that auto-renders `.adoc`/`.md` URLs, or as a standalone web app for browsing local directories. All processing happens locally in your browser.

## Features

- **AsciiDoc & Markdown** - Full rendering with `@asciidoctor/core` and `markdown-it` (14 plugins)
- **Syntax highlighting** - Code blocks via highlight.js with dark mode support
- **Mermaid diagrams** - Rendered inline with theme support on initial render
- **KaTeX math** - LaTeX expressions in Markdown
- **Include resolution** - Recursive `include::` (AsciiDoc) and `<!-- include: path -->` (Markdown)
- **File tree** - Browse local directories via File System Access API (with fallback)
- **Table of Contents** - Auto-generated sidebar with scroll tracking
- **Auto-refresh** - Polls for file changes (2s interval)
- **Dark/light theme** - Toggle with system preference on first load
- **PDF export** - Via browser print with optimized print styles
- **Session restore** - Reopens last directory on reload (IndexedDB)
- **SPA routing** - Hash-based navigation with browser back/forward support
- **Chrome Extension** - Auto-detects `.adoc`/`.md` files opened in the browser

## Documentation

Full user guide and privacy policy available at [djalmajr.github.io/asciimark](https://djalmajr.github.io/asciimark/).

## Monorepo Structure

```
asciimark/
├── packages/
│   ├── core/          # Shared logic (AsciiDoc/Markdown conversion, utils)
│   └── ui/            # Shared SolidJS components and styles
├── apps/
│   ├── extension/     # Chrome Extension
│   └── desktop/       # Tauri Desktop App (planned)
└── docs/              # GitHub Pages site
```

## Getting Started

### Prerequisites

- [Bun](https://bun.sh)

### Install

```sh
bun install
```

### Development (Chrome Extension)

```sh
bun run dev:ext
```

Opens a local dev server with hot reload.

### Build (Chrome Extension)

```sh
bun run build:ext
```

Outputs to `apps/extension/dist/`. Load this folder as an unpacked extension in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `apps/extension/dist/` folder

### Usage

- **Open a folder** - Click "Open Folder" to browse local `.adoc` and `.md` files
- **Extension mode** - Navigate to any `.adoc` or `.md` file URL and it renders automatically
- **For `file://` URLs** - Enable "Allow access to file URLs" in the extension settings

## Tech Stack

- [SolidJS](https://solidjs.com) - UI framework
- [Vite](https://vitejs.dev) - Build tool
- [Tailwind CSS](https://tailwindcss.com) - Styling
- [Kobalte](https://kobalte.dev) - Accessible UI primitives
- [@asciidoctor/core](https://github.com/asciidoctor/asciidoctor.js) - AsciiDoc processor
- [markdown-it](https://github.com/markdown-it/markdown-it) - Markdown processor
- [highlight.js](https://highlightjs.org) - Syntax highlighting
- [Mermaid](https://mermaid.js.org) - Diagrams
- [KaTeX](https://katex.org) - Math rendering (via markdown-it-katex)

## Privacy

All processing is local. No data is collected or transmitted. See [PRIVACY.md](PRIVACY.md) or the [online privacy policy](https://djalmajr.github.io/asciimark/privacy.html).

## License

MIT
