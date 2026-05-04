# IPC contract

The desktop frontend (`apps/desktop/src`) talks to the Rust backend
(`apps/desktop/src-tauri/src/lib.rs`) through Tauri's `invoke()`.
Every command exposed in the Rust `tauri::generate_handler!` block
must have at least one frontend caller, and vice versa. Drift is
detected by `scripts/check-ipc-contract.sh` in pre-commit.

## Commands (16)

### Filesystem read

- `read_dir(path: String, includeHiddenEntries?: bool) → Vec<DirEntry>`
- `read_file(path: String) → String`
- `read_file_relative(root: String, relativePath: String) → String`
- `read_files_relative(root: String, paths: Vec<String>) → HashMap<String,String>`

### Filesystem write

- `write_file(path: String, content: String) → ()`
- `rename_file(root: String, oldRelative: String, newRelative: String) → ()`
- `trash_path(root: String, relative: String) → ()` — sends to OS trash via the `trash` crate

### Watcher

- `watch_paths(paths: Vec<String>) → ()` — non-recursive (single files / direct children)
- `watch_dirs(paths: Vec<String>) → ()` — recursive (whole tree)
- `stop_watching() → ()` and `stop_watching_dirs() → ()`

### Window / desktop

- `open_directory_dialog() → Option<String>` — uses tauri-plugin-dialog
- `set_dock_visible(visible: bool) → ()` — macOS only
- `print_webview() → ()` — invokes `webview.print()`
- `toggle_maximize_instant() → ()` — macOS animated; falls back to native maximize on Linux/Windows

### Startup

- `get_startup_args() → Vec<String>` — `argv[1..]` for cold-start file open

## Path-traversal guard

`rename_file` and `trash_path` route through `resolve_within_root`:

1. Canonicalize root.
2. Canonicalize candidate path (which follows symlinks).
3. Reject unless `candidate.starts_with(root)`.

This catches `../../etc/passwd` AND symlink escapes (a file in the
workspace pointing outside). The unit test
`resolve_within_root_rejects_symlink_escapes` plants a real symlink
to confirm.

## Drift detection

`scripts/check-ipc-contract.sh` greps:
- Rust handler list (`tauri::generate_handler!` block)
- Frontend invokes (`invoke<…>("name", …)` calls)

Reports:
- `✖ Frontend invokes 'X' but it is not registered` → fails the gate
- `⚠ Rust exposes 'Y' but no frontend caller` → warning (possibly dead)

The regex now tolerates generics with embedded commas
(`invoke<Record<string, string>>(…)`) — earlier versions split on the
first comma and falsely flagged `read_files_relative` as dead.
