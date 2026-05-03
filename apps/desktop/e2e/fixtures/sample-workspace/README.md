# Sample workspace

Used by the E2E suite as a known-state workspace. The harness opens this
folder via `read_dir` and verifies the file tree shape.

- `notes.md` — small markdown doc
- `guide.adoc` — small AsciiDoc doc
- `node_modules/` — must be filtered out by `read_dir` even when present
- `.git/` — must be filtered when `include_hidden_entries` is false
