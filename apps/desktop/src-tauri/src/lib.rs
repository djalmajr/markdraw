use notify_debouncer_mini::{new_debouncer, DebouncedEvent};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

// AI provider API keys (OS keychain) + ai.json config IO (DJA-11E).
// Imported by simple name so the IPC-contract check (scripts/check-ipc-contract.sh)
// sees them as registered commands.
mod ai_keychain;
use ai_keychain::{
    ai_delete_api_key, ai_get_api_key, ai_read_config, ai_set_api_key, ai_write_config,
};

// MCP client manager — connect to N MCP servers over stdio/HTTP; the AI
// tool-calling loop discovers their tools via ai_mcp_list_tools and invokes
// them via ai_mcp_call_tool. Imported by simple name so the IPC-contract check
// (scripts/check-ipc-contract.sh) sees the commands as registered.
mod ai_mcp;
mod ai_mcp_oauth;
use ai_mcp::{
    ai_mcp_authorize, ai_mcp_call_tool, ai_mcp_cancel_call, ai_mcp_connect, ai_mcp_disconnect,
    ai_mcp_list_servers, ai_mcp_list_tools, McpManager,
};

// Discovers MCP servers other agent tools (Claude Code, Codex, OpenCode) already
// configure, at global + per-project scope, normalized for AsciiMark. Read-only;
// the JS host gates which tools to read and approves project servers.
mod mcp_discovery;
use mcp_discovery::mcp_discover;

// Streaming provider HTTP — Rust-side POST + SSE line framing over an ipc
// Channel (tauri-plugin-http buffers whole responses, so SSE never streamed).
mod ai_http;
use ai_http::{ai_http_stream, ai_http_stream_cancel, HttpStreamManager};

// Claude Code / Codex subscription via local CLI binaries (JSONL over Channel).
mod cli_agent;
use cli_agent::{
    cli_chat_cancel, cli_chat_stream, cli_detect_binary, cli_probe_subscription, CliStreamManager,
};

// Per-root workspace index (DJA-15): SQLite FTS5 keyword search + provider-
// supplied embedding vectors fused with RRF. Commands imported by simple name
// so the IPC-contract check (scripts/check-ipc-contract.sh) sees them.
mod ai_index;
use ai_index::{
    ai_index_delete, ai_index_search, ai_index_staleness, ai_index_status, ai_index_sync,
    IndexManager,
};

// `asciimark-preview://` custom scheme — serves an HTML file's directory as an
// isolated web origin so multi-file pages / SPAs preview with full fidelity
// (root-absolute paths, ES modules, importmaps, hash routing). Commands
// imported by simple name so the IPC-contract check sees them registered.
mod html_preview;
use html_preview::{html_preview_clear_overlay, html_preview_register, html_preview_set_overlay};

// Pure-Rust helpers split out of this file so the Miri sub-crate
// (`tools/miri-helpers-tests`) can exercise them without pulling in
// the full Tauri dep graph. The `ctor` macro inside
// `tauri-plugin-mcp-bridge` blocks Miri on the main crate; see
// `.cargo/config.toml` for the full status note.
pub mod pure_helpers;

#[derive(Serialize, Clone)]
pub struct DirEntry {
    pub name: String,
    pub kind: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<DirEntry>>,
}

#[derive(Serialize, Clone)]
pub struct WatchEvent {
    pub paths: Vec<String>,
}

/// Bulky directories that are ALWAYS skipped, regardless of "show hidden".
/// These are caches/build artifacts/dependencies that would freeze the tree
/// (and any subsequent re-renders) if we walked them. The user can still
/// access them outside the app.
pub const ALWAYS_IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "out",
    "target",
    "vendor",
    "__pycache__",
    "venv",
    "coverage",
    "tmp",
    "temp",
];

/// Hidden tooling directories that are skipped *only* when "show hidden" is
/// off. With show hidden enabled the user expects to see them.
pub const HIDDEN_TOOL_DIRS: &[&str] = &[
    ".git",
    ".next",
    ".nuxt",
    ".output",
    ".cache",
    ".turbo",
    ".svelte-kit",
    ".venv",
    ".idea",
    ".vscode",
    ".nyc_output",
];

/// Builds an `ignore::gitignore::Gitignore` matcher rooted at `base`.
/// The matcher reads `<base>/.gitignore` (the `ignore` crate also
/// honours nested `.gitignore` files automatically when paths under
/// `base` are queried). When no `.gitignore` file exists or the
/// matcher fails to build, returns the empty matcher — querying it
/// is always a no-op, which keeps callers branch-free.
pub fn build_gitignore_matcher(base: &Path) -> ignore::gitignore::Gitignore {
    let mut builder = ignore::gitignore::GitignoreBuilder::new(base);
    let gitignore_path = base.join(".gitignore");
    if gitignore_path.exists() {
        // `add` only returns an Option<Error> — we discard parse
        // errors in malformed files rather than failing the whole
        // `read_dir`. Worst case is the file tree shows entries the
        // user expected to be hidden, which they can recover from
        // by fixing the .gitignore.
        let _ = builder.add(gitignore_path);
    }
    builder.build().unwrap_or_else(|_| ignore::gitignore::Gitignore::empty())
}

pub fn read_dir_recursive(
    dir: &Path,
    base: &Path,
    include_hidden_entries: bool,
    ignore_matcher: Option<&ignore::gitignore::Gitignore>,
) -> Result<Vec<DirEntry>, String> {
    let mut entries = Vec::new();
    let read = std::fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in read {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();

        // Hidden files (dotfiles) — skipped unless the user wants to see them.
        if name.starts_with('.') && !include_hidden_entries {
            continue;
        }

        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let rel_path = entry_path
            .strip_prefix(base)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");

        if file_type.is_dir() {
            // Bulky build/cache/deps dirs: ALWAYS skipped — these would freeze
            // the UI if walked, and aren't useful in a markdown editor.
            if ALWAYS_IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            // Tool dotfile dirs (.git, .vscode, …): skipped unless show hidden.
            if !include_hidden_entries && HIDDEN_TOOL_DIRS.contains(&name.as_str()) {
                continue;
            }
            // Gitignore — applied AFTER the hard-coded skip lists so the
            // worst-case freeze guards keep firing even when the user
            // toggled the gitignore filter off.
            if let Some(matcher) = ignore_matcher {
                if matcher.matched(&entry_path, true).is_ignore() {
                    continue;
                }
            }
            let children = read_dir_recursive(&entry_path, base, include_hidden_entries, ignore_matcher)?;
            entries.push(DirEntry {
                name,
                kind: "directory".into(),
                path: rel_path,
                children: Some(children),
            });
        } else if file_type.is_file() {
            if let Some(matcher) = ignore_matcher {
                if matcher.matched(&entry_path, false).is_ignore() {
                    continue;
                }
            }
            entries.push(DirEntry {
                name,
                kind: "file".into(),
                path: rel_path,
                children: None,
            });
        }
    }

    entries.sort_by(|a, b| {
        if a.kind != b.kind {
            if a.kind == "directory" {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    Ok(entries)
}

#[tauri::command]
async fn open_directory_dialog(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog().file().blocking_pick_folder();
    Ok(path.map(|p| p.to_string()))
}

#[tauri::command]
async fn save_file_dialog(
    app: AppHandle,
    default_dir: Option<String>,
    default_name: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut builder = app.dialog().file().set_file_name(&default_name);
    if let Some(dir) = default_dir {
        // Ensure the suggested directory exists so the dialog opens into it
        // (e.g. a not-yet-created `.asciimark/chats`). Best-effort.
        let _ = std::fs::create_dir_all(&dir);
        builder = builder.set_directory(std::path::PathBuf::from(&dir));
    }
    let path = builder
        .add_filter("Markdown", &["md", "markdown"])
        .blocking_save_file();
    Ok(path.map(|p| p.to_string()))
}

#[tauri::command]
async fn read_dir(
    path: String,
    include_hidden_entries: Option<bool>,
    respect_gitignore: Option<bool>,
) -> Result<Vec<DirEntry>, String> {
    let path = PathBuf::from(&path);
    let matcher = if respect_gitignore.unwrap_or(false) {
        Some(build_gitignore_matcher(&path))
    } else {
        None
    };
    read_dir_recursive(
        &path,
        &path,
        include_hidden_entries.unwrap_or(false),
        matcher.as_ref(),
    )
}

#[tauri::command]
async fn find_in_files(
    root: String,
    query: String,
    case_sensitive: Option<bool>,
    include_hidden_entries: Option<bool>,
) -> Result<Vec<FileMatch>, String> {
    let root = PathBuf::from(&root);
    find_in_files_impl(
        &root,
        &query,
        case_sensitive.unwrap_or(false),
        include_hidden_entries.unwrap_or(false),
    )
}

#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Read one environment variable from the host process, for `{env:VAR}`
/// references in AI / MCP config (resolved at connect time, never persisted).
/// Returns `None` when unset. Note: a macOS app launched from Finder inherits a
/// limited environment, so `{env:}` is mainly a dev convenience — prefer
/// `{keychain:id}` for real secrets.
#[tauri::command]
fn ai_read_env(name: String) -> Option<String> {
    std::env::var(name).ok()
}

#[tauri::command]
async fn read_file_relative(root: String, relative_path: String) -> Result<String, String> {
    read_file_relative_impl(&PathBuf::from(&root), &relative_path)
}

#[tauri::command]
async fn read_files_relative(root: String, paths: Vec<String>) -> Result<std::collections::HashMap<String, String>, String> {
    Ok(read_files_relative_impl(&PathBuf::from(&root), &paths))
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    // Create parent dirs first so callers can write into not-yet-existing
    // folders (e.g. `.asciimark/plans/`) without a separate mkdir round-trip.
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, &content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_file(
    root: String,
    old_relative: String,
    new_relative: String,
) -> Result<(), String> {
    rename_file_impl(&PathBuf::from(&root), &old_relative, &new_relative)
}

#[tauri::command]
async fn trash_path(root: String, relative: String) -> Result<(), String> {
    let target_canon = resolve_within_root(&PathBuf::from(&root), &relative)?;
    trash::delete(&target_canon).map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_file(root: String, relative: String) -> Result<(), String> {
    create_file_impl(&PathBuf::from(&root), &relative)
}

#[tauri::command]
async fn create_dir(root: String, relative: String) -> Result<(), String> {
    create_dir_impl(&PathBuf::from(&root), &relative)
}

#[tauri::command]
async fn copy_path(
    src_root: String,
    from_relative: String,
    dst_root: String,
    to_relative: String,
) -> Result<(), String> {
    copy_path_impl(
        &PathBuf::from(&src_root),
        &from_relative,
        &PathBuf::from(&dst_root),
        &to_relative,
    )
}

#[tauri::command]
async fn move_path(
    src_root: String,
    src_relative: String,
    dst_root: String,
    dst_relative: String,
) -> Result<(), String> {
    move_path_impl(
        &PathBuf::from(&src_root),
        &src_relative,
        &PathBuf::from(&dst_root),
        &dst_relative,
    )
}

/// Read a file by joining `relative` to `root`. Public for testing.
pub fn read_file_relative_impl(root: &Path, relative: &str) -> Result<String, String> {
    let full = root.join(relative);
    std::fs::read_to_string(&full).map_err(|e| e.to_string())
}

/// Read multiple files relative to root, silently skipping unreadable ones.
pub fn read_files_relative_impl(
    root: &Path,
    paths: &[String],
) -> std::collections::HashMap<String, String> {
    let mut result = std::collections::HashMap::new();
    for rel_path in paths {
        let full = root.join(rel_path);
        if let Ok(content) = std::fs::read_to_string(&full) {
            result.insert(rel_path.clone(), content);
        }
    }
    result
}

/// One line that matches a Find-in-Files query. `path` is workspace-relative
/// with forward slashes (matches `DirEntry::path`). `line_number` is
/// 0-indexed so the frontend can feed it directly to the editor's
/// scrollToLine prop. `column_start`/`column_end` are UTF-16 code-unit offsets
/// inside `line_text` — matching JS `String.slice`, which the frontend uses to
/// highlight — so the mark lines up on accented / multi-byte lines.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct FileMatch {
    pub path: String,
    pub line_number: usize,
    pub line_text: String,
    pub column_start: usize,
    pub column_end: usize,
}

/// Cap on results per query. Exists to bound the IPC response size and to
/// keep the UI list rendering tractable. The frontend shows a
/// "+N more matches" hint when this fires.
pub const FIND_IN_FILES_RESULT_LIMIT: usize = 500;
/// Files larger than this are skipped — Find in Files is for prose, not
/// for grep-ing through node bundles or generated assets that escaped the
/// IGNORED_DIRS list.
pub const FIND_IN_FILES_FILE_SIZE_LIMIT: u64 = 1_000_000;
/// Heuristic: NUL byte in the first 8KB → treat as binary, skip.
const FIND_IN_FILES_BINARY_PROBE: usize = 8 * 1024;

/// Walk `root` recursively and collect every line that contains `query`.
/// Honors `case_sensitive`; an empty query short-circuits to an empty
/// result. Hidden / always-ignored directories are skipped on the same
/// terms as `read_dir_recursive`. Stops as soon as `FIND_IN_FILES_RESULT_LIMIT`
/// matches have been accumulated. Public for testability.
pub fn find_in_files_impl(
    root: &Path,
    query: &str,
    case_sensitive: bool,
    include_hidden_entries: bool,
) -> Result<Vec<FileMatch>, String> {
    let mut results = Vec::new();
    if query.is_empty() {
        return Ok(results);
    }

    let needle: String = if case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };

    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if results.len() >= FIND_IN_FILES_RESULT_LIMIT {
            break;
        }
        let read = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue, // skip unreadable subtree, don't fail the whole search
        };
        for entry in read.flatten() {
            if results.len() >= FIND_IN_FILES_RESULT_LIMIT {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && !include_hidden_entries {
                continue;
            }
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if ALWAYS_IGNORED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                if !include_hidden_entries && HIDDEN_TOOL_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push(entry.path());
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let path = entry.path();
            let metadata = match path.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if metadata.len() > FIND_IN_FILES_FILE_SIZE_LIMIT {
                continue;
            }
            let bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            // Binary heuristic: NUL byte in the prefix.
            let probe_end = bytes.len().min(FIND_IN_FILES_BINARY_PROBE);
            if bytes[..probe_end].contains(&0u8) {
                continue;
            }
            let content = match String::from_utf8(bytes) {
                Ok(s) => s,
                Err(_) => continue, // non-UTF-8: skip silently
            };

            let rel_path = match path.strip_prefix(root) {
                Ok(p) => p.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };

            for (line_number, line) in content.lines().enumerate() {
                if results.len() >= FIND_IN_FILES_RESULT_LIMIT {
                    break;
                }
                let haystack: String = if case_sensitive {
                    line.to_string()
                } else {
                    line.to_lowercase()
                };
                let byte_col = match haystack.find(&needle) {
                    Some(c) => c,
                    None => continue,
                };
                // Emit UTF-16 code-unit offsets (what JS `String.slice` indexes),
                // NOT byte offsets — otherwise the frontend highlight drifts
                // right on lines with accents / em-dashes before the match.
                // `byte_col` is a char boundary (it came from `find`), so the
                // prefix slice is always valid.
                let column_start = haystack[..byte_col].encode_utf16().count();
                let column_end = column_start + needle.encode_utf16().count();
                results.push(FileMatch {
                    path: rel_path.clone(),
                    line_number,
                    line_text: line.to_string(),
                    column_start,
                    column_end,
                });
            }
        }
    }

    Ok(results)
}

/// Resolve `relative` against `root` and confirm the result still lives
/// inside the canonicalized root. Returns the canonicalized target on
/// success; rejects symlink escapes, `..` traversal, and absolute paths
/// pointing outside the workspace.
///
/// The implementation lives in `pure_helpers::resolve_within_root` so
/// the Miri sub-crate can exercise the path-traversal logic without
/// dragging in the Tauri/objc2 dep graph. This re-export keeps the
/// public API stable for the rest of the crate.
pub use pure_helpers::resolve_within_root;

/// Move a file inside a workspace root, validating that both endpoints stay
/// inside `root` and refusing to clobber an existing destination.
pub fn rename_file_impl(
    root: &Path,
    old_relative: &str,
    new_relative: &str,
) -> Result<(), String> {
    let from = root.join(old_relative);
    let to = root.join(new_relative);

    let root_canon = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let from_canon = std::fs::canonicalize(&from).map_err(|e| e.to_string())?;
    if !from_canon.starts_with(&root_canon) {
        return Err("rename source escapes workspace root".into());
    }

    let to_parent = to.parent().ok_or_else(|| "invalid destination".to_string())?;
    let to_parent_canon = std::fs::canonicalize(to_parent).map_err(|e| e.to_string())?;
    if !to_parent_canon.starts_with(&root_canon) {
        return Err("rename destination escapes workspace root".into());
    }

    if to.exists() {
        return Err("destination already exists".into());
    }

    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Reject traversal/absolute paths, create the parent directory chain, and
/// return the canonicalized parent — guaranteed to live inside `root`.
pub fn ensure_parent_within_root(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if rel.file_name().is_none()
        || rel.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err("invalid path".into());
    }
    let root_canon = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let target = root_canon.join(rel);
    let parent = target.parent().ok_or_else(|| "invalid destination".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let parent_canon = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !parent_canon.starts_with(&root_canon) {
        return Err("destination escapes workspace root".into());
    }
    Ok(parent_canon)
}

/// Create an empty file at `relative` inside `root`, creating parent dirs as
/// needed. Validates traversal and refuses to overwrite an existing file.
pub fn create_file_impl(root: &Path, relative: &str) -> Result<(), String> {
    let parent_canon = ensure_parent_within_root(root, relative)?;
    let name = Path::new(relative)
        .file_name()
        .ok_or_else(|| "invalid file name".to_string())?;
    let target = parent_canon.join(name);
    if target.exists() {
        return Err("file already exists".into());
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Create a directory at `relative` inside `root`, creating parent dirs as
/// needed. Validates traversal and refuses to overwrite an existing entry.
pub fn create_dir_impl(root: &Path, relative: &str) -> Result<(), String> {
    let parent_canon = ensure_parent_within_root(root, relative)?;
    let name = Path::new(relative)
        .file_name()
        .ok_or_else(|| "invalid directory name".to_string())?;
    let target = parent_canon.join(name);
    if target.exists() {
        return Err("directory already exists".into());
    }
    std::fs::create_dir(&target).map_err(|e| e.to_string())
}

/// Copy the file or directory at `from_rel` (inside `src_root`) to `to_rel`
/// (inside `dst_root`). Works within a single root and across two different
/// workspace roots. Directories are copied recursively. Validates both
/// endpoints and refuses to overwrite an existing destination (the caller
/// chooses a free `to_rel`, e.g. `name (1).md`).
pub fn copy_path_impl(
    src_root: &Path,
    from_rel: &str,
    dst_root: &Path,
    to_rel: &str,
) -> Result<(), String> {
    let from = src_root.join(from_rel);
    let src_root_canon = std::fs::canonicalize(src_root).map_err(|e| e.to_string())?;
    let from_canon = std::fs::canonicalize(&from).map_err(|e| e.to_string())?;
    if !from_canon.starts_with(&src_root_canon) {
        return Err("copy source escapes workspace root".into());
    }

    let parent_canon = ensure_parent_within_root(dst_root, to_rel)?;
    let name = Path::new(to_rel)
        .file_name()
        .ok_or_else(|| "invalid destination name".to_string())?;
    let to = parent_canon.join(name);
    if to.exists() {
        return Err("destination already exists".into());
    }

    // Refuse to copy a directory into its own subtree (would recurse forever).
    if from_canon.is_dir() && to.starts_with(&from_canon) {
        return Err("cannot copy a folder into itself".into());
    }

    if from_canon.is_dir() {
        copy_dir_recursive(&from_canon, &to)
    } else {
        std::fs::copy(&from_canon, &to).map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Move the file or directory at `src_rel` (inside `src_root`) to `dst_rel`
/// (inside `dst_root`). Works within a single root and across two different
/// workspace roots. Validates both endpoints, refuses to overwrite, and falls
/// back to copy+remove when a plain rename fails (e.g. cross-filesystem).
pub fn move_path_impl(
    src_root: &Path,
    src_rel: &str,
    dst_root: &Path,
    dst_rel: &str,
) -> Result<(), String> {
    let from = src_root.join(src_rel);
    let src_root_canon = std::fs::canonicalize(src_root).map_err(|e| e.to_string())?;
    let from_canon = std::fs::canonicalize(&from).map_err(|e| e.to_string())?;
    if !from_canon.starts_with(&src_root_canon) {
        return Err("move source escapes workspace root".into());
    }

    let parent_canon = ensure_parent_within_root(dst_root, dst_rel)?;
    let name = Path::new(dst_rel)
        .file_name()
        .ok_or_else(|| "invalid destination name".to_string())?;
    let to = parent_canon.join(name);
    if to.exists() {
        return Err("destination already exists".into());
    }

    // Refuse to move a directory into its own subtree.
    if from_canon.is_dir() && to.starts_with(&from_canon) {
        return Err("cannot move a folder into itself".into());
    }

    // Fast path: a plain rename. Falls back to copy+remove across filesystems.
    if std::fs::rename(&from_canon, &to).is_ok() {
        return Ok(());
    }
    if from_canon.is_dir() {
        copy_dir_recursive(&from_canon, &to)?;
        std::fs::remove_dir_all(&from_canon).map_err(|e| e.to_string())
    } else {
        std::fs::copy(&from_canon, &to).map_err(|e| e.to_string())?;
        std::fs::remove_file(&from_canon).map_err(|e| e.to_string())
    }
}

/// Recursively copy `from` (a directory) to `to`, creating `to` and mirroring
/// the subtree. Assumes `to` does not yet exist.
fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let dest = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

struct WatcherHolder(
    Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>>,
);

struct DirWatcherHolder(
    Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>>,
);

/// Build a debouncing watcher over `paths`. `recursive` selects RecursiveMode
/// (false → just the file/dir itself; true → all descendants). `on_change`
/// receives the list of changed paths (forward-slash normalized) per debounced
/// batch. Returns the debouncer so the caller keeps it alive.
pub fn make_watcher<F>(
    paths: &[String],
    debounce: Duration,
    recursive: bool,
    on_change: F,
) -> Result<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>, String>
where
    F: Fn(Vec<String>) + Send + 'static,
{
    let mut debouncer = new_debouncer(debounce, move |events: Result<Vec<DebouncedEvent>, notify::Error>| {
        if let Ok(events) = events {
            let changed: Vec<String> = events
                .iter()
                .map(|e| e.path.to_string_lossy().replace('\\', "/"))
                .collect();
            on_change(changed);
        }
    })
    .map_err(|e| e.to_string())?;

    let mode = if recursive {
        notify::RecursiveMode::Recursive
    } else {
        notify::RecursiveMode::NonRecursive
    };

    let watcher = debouncer.watcher();
    for p in paths {
        let _ = watcher.watch(Path::new(p), mode);
    }

    Ok(debouncer)
}

#[tauri::command]
async fn watch_paths<R: Runtime>(app: AppHandle<R>, paths: Vec<String>) -> Result<(), String> {
    // Stop existing watcher
    if let Some(state) = app.try_state::<WatcherHolder>() {
        let mut lock = state.0.lock().map_err(|e| e.to_string())?;
        *lock = None;
    }

    let app_clone = app.clone();
    let debouncer = make_watcher(
        &paths,
        Duration::from_millis(500),
        false,
        move |changed| {
            let _ = app_clone.emit("fs-change", WatchEvent { paths: changed });
        },
    )?;

    // Store to prevent drop
    if let Some(state) = app.try_state::<WatcherHolder>() {
        let mut lock = state.0.lock().map_err(|e| e.to_string())?;
        *lock = Some(debouncer);
    }

    Ok(())
}

#[tauri::command]
async fn stop_watching<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(state) = app.try_state::<WatcherHolder>() {
        let mut lock = state.0.lock().map_err(|e| e.to_string())?;
        *lock = None;
    }
    Ok(())
}

#[tauri::command]
async fn watch_dirs<R: Runtime>(app: AppHandle<R>, paths: Vec<String>) -> Result<(), String> {
    if let Some(state) = app.try_state::<DirWatcherHolder>() {
        let mut lock = state.0.lock().map_err(|e| e.to_string())?;
        *lock = None;
    }

    let app_clone = app.clone();
    let debouncer = make_watcher(
        &paths,
        Duration::from_millis(800),
        true,
        move |changed| {
            let _ = app_clone.emit("fs-tree-change", WatchEvent { paths: changed });
        },
    )?;

    if let Some(state) = app.try_state::<DirWatcherHolder>() {
        let mut lock = state.0.lock().map_err(|e| e.to_string())?;
        *lock = Some(debouncer);
    }

    Ok(())
}

#[tauri::command]
async fn stop_watching_dirs<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(state) = app.try_state::<DirWatcherHolder>() {
        let mut lock = state.0.lock().map_err(|e| e.to_string())?;
        *lock = None;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos_maximize {
    use objc2::encode::{Encode, Encoding, RefEncode};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    // The geometry types and the arithmetic helpers live in
    // `crate::pure_helpers` so the Miri sub-crate can exercise them
    // without the objc2 dependency. The `unsafe impl Encode` blocks
    // below stay here because (a) only the macOS build needs the
    // FFI encoding metadata, and (b) the orphan rule requires the
    // impl to live in the same crate as the type (which pure_helpers
    // provides — `Encode`/`RefEncode` are from objc2 but the structs
    // are local to this crate).
    pub use crate::pure_helpers::{
        ease_out_cubic, interpolate_frame, Point as CGPoint, Rect as CGRect, Size as CGSize,
    };

    unsafe impl Encode for CGPoint {
        const ENCODING: Encoding =
            Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }

    unsafe impl RefEncode for CGPoint {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
    }

    unsafe impl Encode for CGSize {
        const ENCODING: Encoding =
            Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }

    unsafe impl RefEncode for CGSize {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
    }

    unsafe impl Encode for CGRect {
        const ENCODING: Encoding =
            Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
    }

    unsafe impl RefEncode for CGRect {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
    }

    pub static SAVED_FRAME: Mutex<Option<CGRect>> = Mutex::new(None);
    pub static IS_ANIMATING: AtomicBool = AtomicBool::new(false);

    pub const STEPS: u64 = 12;
    pub const DURATION_MS: u64 = 200;

    extern "C" {
        pub static _dispatch_main_q: u8;
        pub fn dispatch_async_f(
            queue: *const u8,
            context: *mut std::ffi::c_void,
            work: extern "C" fn(*mut std::ffi::c_void),
        );
    }

    pub struct AnimStep {
        pub ns_window: *mut objc2::runtime::AnyObject,
        pub frame: CGRect,
        pub is_last: bool,
    }

    unsafe impl Send for AnimStep {}

    pub extern "C" fn apply_frame(context: *mut std::ffi::c_void) {
        unsafe {
            let step = Box::from_raw(context as *mut AnimStep);
            let _: () = objc2::msg_send![
                step.ns_window,
                setFrame: step.frame,
                display: true,
                animate: false
            ];
            if step.is_last {
                let _: () = objc2::msg_send![step.ns_window, release];
                IS_ANIMATING.store(false, Ordering::SeqCst);
            }
        }
    }

}

#[cfg(target_os = "macos")]
#[tauri::command]
fn toggle_maximize_instant(webview: tauri::Webview) -> Result<(), String> {
    use macos_maximize::*;
    use std::sync::atomic::Ordering;

    if IS_ANIMATING.load(Ordering::SeqCst) {
        return Ok(());
    }
    IS_ANIMATING.store(true, Ordering::SeqCst);

    webview
        .with_webview(|wv| {
            unsafe {
                let ns_window: *mut objc2::runtime::AnyObject = wv.ns_window().cast();
                let current_frame: CGRect = objc2::msg_send![ns_window, frame];

                let target_frame = {
                    let mut saved = SAVED_FRAME.lock().unwrap();
                    if let Some(prev_frame) = saved.take() {
                        prev_frame
                    } else {
                        *saved = Some(current_frame);
                        let screen: *mut objc2::runtime::AnyObject =
                            objc2::msg_send![ns_window, screen];
                        objc2::msg_send![screen, visibleFrame]
                    }
                };

                let _: *mut objc2::runtime::AnyObject = objc2::msg_send![ns_window, retain];
                let ns_window_addr = ns_window as usize;

                std::thread::spawn(move || {
                    let ns_window = ns_window_addr as *mut objc2::runtime::AnyObject;
                    let sleep_ms = std::time::Duration::from_millis(DURATION_MS / STEPS);

                    for i in 0..STEPS {
                        let is_last = i == STEPS - 1;
                        let frame = if is_last {
                            target_frame
                        } else {
                            let t = (i + 1) as f64 / STEPS as f64;
                            interpolate_frame(current_frame, target_frame, ease_out_cubic(t))
                        };

                        let step = Box::new(AnimStep { ns_window, frame, is_last });
                        dispatch_async_f(
                            std::ptr::addr_of!(_dispatch_main_q),
                            Box::into_raw(step) as *mut std::ffi::c_void,
                            apply_frame,
                        );

                        if !is_last {
                            std::thread::sleep(sleep_ms);
                        }
                    }
                });
            }
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn toggle_maximize_instant(window: tauri::Window) -> Result<(), String> {
    if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

/// Return command-line args passed to the process (for file-open on cold start).
/// On Windows/Linux, double-clicking an associated file passes the path as argv[1].
#[tauri::command]
fn get_startup_args() -> Vec<String> {
    std::env::args().skip(1).collect()
}

/// Show or hide the dock icon on macOS by changing the activation policy.
/// `Accessory` removes the app from the dock; `Regular` brings it back.
#[cfg(target_os = "macos")]
#[tauri::command]
fn set_dock_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    // Dev keeps the dock icon (never the hidden "tray"/accessory mode) so the
    // dev instance stays visible and distinct from a running prod build.
    let visible = if cfg!(debug_assertions) { true } else { visible };
    let policy = if visible {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };
    app.set_activation_policy(policy).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn set_dock_visible() -> Result<(), String> {
    Ok(())
}

/// Dev-only: stamp a "DEV" badge on the macOS dock icon so the dev instance is
/// visually distinct from a running prod build (Tauri exposes no badge API).
#[cfg(all(debug_assertions, target_os = "macos"))]
fn set_dev_dock_badge() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    use objc2_foundation::NSString;
    if let Some(mtm) = MainThreadMarker::new() {
        let app = NSApplication::sharedApplication(mtm);
        let label = NSString::from_str("DEV");
        app.dockTile().setBadgeLabel(Some(&label));
    }
}

#[tauri::command]
fn print_webview(webview: tauri::Webview) -> Result<(), String> {
    webview.print().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // Dev-only: bind on 127.0.0.1 so the MCP bridge isn't exposed on the LAN.
    // Uses the plugin's default port (9223) so `@hypothesi/tauri-mcp-server`
    // connects with no extra configuration.
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .base_port(9223)
                .build(),
        );
    }

    // Single-instance ONLY in release. In dev the plugin is skipped so a dev
    // build coexists with a running prod build (same identifier) without the
    // lock collision that forwards args + steals focus + reloads the other
    // instance. Dev keeps the prod identifier, so its AI config (ai.json) is
    // shared/preserved — no fallback to the Mock provider.
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // When a second instance opens with file args, emit an event
            // so the frontend can navigate to the file.
            if let Some(path) = argv.get(1) {
                let _ = app.emit("open-file", path.clone());
            }
            // Focus the existing window and restore dock icon
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .setup(|app| {
            // Dev: mark the dock icon with a "DEV" badge (runs on the main thread).
            #[cfg(all(debug_assertions, target_os = "macos"))]
            set_dev_dock_badge();
            // macOS-only: make the green traffic-light button do ZOOM
            // (= classic "maximize") instead of entering native
            // fullscreen. The default behaviour hides the entire
            // title bar — including the close/min/max buttons — and
            // since AsciiMark already has its own reader/zen mode
            // (Cmd+. / F11), losing system fullscreen is a fair
            // trade for keeping the traffic lights always visible
            // after a maximize gesture.
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                use objc2::runtime::AnyObject;
                if let Ok(handle) = window.ns_window() {
                    let ns_window = handle as *mut AnyObject;
                    // NSWindowCollectionBehaviorFullScreenNone =
                    //   1 << 9. Bitwise-OR with the existing flags
                    //   so other Tauri-managed collection behaviour
                    //   (like ignoring exposé) survives the patch.
                    const FULL_SCREEN_NONE: usize = 1 << 9;
                    unsafe {
                        let current: usize =
                            objc2::msg_send![ns_window, collectionBehavior];
                        let next = current | FULL_SCREEN_NONE;
                        let _: () =
                            objc2::msg_send![ns_window, setCollectionBehavior: next];
                    }
                }
            }
            // Windows-only: drop the native window frame. `titleBarStyle:
            // "Overlay"` in the config is a macOS-only setting, so Windows
            // keeps native decorations — and the app already draws its own
            // caption buttons there (`<WindowControls />` in app.tsx), which
            // showed BOTH sets of min/max/close. Disabling decorations at
            // runtime avoids duplicating the whole `app.windows` array into a
            // tauri.windows.conf.json (platform configs replace arrays whole).
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(false);
            }
            let _ = app;
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        // Serve `asciimark-preview://<token>/<path>` from a registered HTML
        // file's directory (isolated origin; path-traversal guarded). See
        // html_preview.rs for the isolation model.
        .register_uri_scheme_protocol(html_preview::SCHEME, |ctx, request| {
            html_preview::serve(ctx.app_handle(), request)
        })
        .manage(WatcherHolder(Mutex::new(None)))
        .manage(DirWatcherHolder(Mutex::new(None)))
        .manage(McpManager::default())
        .manage(HttpStreamManager::default())
        .manage(CliStreamManager::default())
        .manage(IndexManager::default())
        .manage(html_preview::HtmlPreviewState::default())
        .invoke_handler(tauri::generate_handler![
            open_directory_dialog,
            save_file_dialog,
            read_dir,
            read_file,
            read_file_relative,
            read_files_relative,
            find_in_files,
            get_startup_args,
            set_dock_visible,
            toggle_maximize_instant,
            print_webview,
            write_file,
            rename_file,
            trash_path,
            create_file,
            create_dir,
            copy_path,
            move_path,
            watch_paths,
            stop_watching,
            watch_dirs,
            stop_watching_dirs,
            ai_set_api_key,
            ai_get_api_key,
            ai_delete_api_key,
            ai_read_env,
            ai_read_config,
            ai_write_config,
            ai_mcp_connect,
            ai_mcp_authorize,
            ai_mcp_disconnect,
            ai_mcp_list_servers,
            mcp_discover,
            ai_mcp_list_tools,
            ai_mcp_call_tool,
            ai_mcp_cancel_call,
            ai_http_stream,
            ai_http_stream_cancel,
            cli_detect_binary,
            cli_probe_subscription,
            cli_chat_stream,
            cli_chat_cancel,
            ai_index_status,
            ai_index_staleness,
            ai_index_sync,
            ai_index_search,
            ai_index_delete,
            html_preview_register,
            html_preview_set_overlay,
            html_preview_clear_overlay,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // macOS: when the OS asks the app to open a file (double-click on
            // an associated .md/.adoc), Tauri delivers it as RunEvent::Opened.
            // We forward the path to the frontend via an event.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        if let Some(path_str) = path.to_str() {
                            let _ = _app.emit("open-file", path_str.to_string());
                        }
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"").unwrap();
    }

    fn names(entries: &[DirEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn create_file_makes_an_empty_file() {
        let dir = tempdir().unwrap();
        create_file_impl(dir.path(), "notes.md").unwrap();
        let p = dir.path().join("notes.md");
        assert!(p.exists());
        assert_eq!(fs::read_to_string(&p).unwrap(), "");
    }

    #[test]
    fn create_file_makes_parent_dirs() {
        let dir = tempdir().unwrap();
        create_file_impl(dir.path(), "a/b/c.md").unwrap();
        assert!(dir.path().join("a/b/c.md").exists());
    }

    #[test]
    fn create_file_refuses_to_overwrite() {
        let dir = tempdir().unwrap();
        touch(&dir.path().join("x.md"));
        fs::write(dir.path().join("x.md"), b"keep").unwrap();
        let err = create_file_impl(dir.path(), "x.md").unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        assert_eq!(fs::read_to_string(dir.path().join("x.md")).unwrap(), "keep");
    }

    #[test]
    fn create_file_rejects_parent_traversal() {
        let dir = tempdir().unwrap();
        let err = create_file_impl(dir.path(), "../escape.md").unwrap_err();
        assert_eq!(err, "invalid path");
        assert!(!dir.path().parent().unwrap().join("escape.md").exists());
    }

    #[test]
    fn create_file_rejects_absolute_path() {
        let dir = tempdir().unwrap();
        let err = create_file_impl(dir.path(), "/tmp/escape.md").unwrap_err();
        assert_eq!(err, "invalid path");
    }

    #[test]
    fn create_dir_makes_nested_dirs() {
        let dir = tempdir().unwrap();
        create_dir_impl(dir.path(), "a/b/c").unwrap();
        assert!(dir.path().join("a/b/c").is_dir());
    }

    #[test]
    fn create_dir_refuses_to_overwrite() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("d")).unwrap();
        let err = create_dir_impl(dir.path(), "d").unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
    }

    #[test]
    fn create_dir_rejects_traversal() {
        let dir = tempdir().unwrap();
        let err = create_dir_impl(dir.path(), "../evil").unwrap_err();
        assert_eq!(err, "invalid path");
    }

    #[test]
    fn copy_file_duplicates_content() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), b"hello").unwrap();
        copy_path_impl(dir.path(), "a.md", dir.path(), "a (1).md").unwrap();
        assert_eq!(fs::read(dir.path().join("a (1).md")).unwrap(), b"hello");
        // original is untouched.
        assert_eq!(fs::read(dir.path().join("a.md")).unwrap(), b"hello");
    }

    #[test]
    fn copy_file_into_subdir_creates_parents() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), b"x").unwrap();
        copy_path_impl(dir.path(), "a.md", dir.path(), "sub/deep/a.md").unwrap();
        assert!(dir.path().join("sub/deep/a.md").exists());
    }

    #[test]
    fn copy_dir_recursively_mirrors_subtree() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src/inner")).unwrap();
        fs::write(dir.path().join("src/top.md"), b"1").unwrap();
        fs::write(dir.path().join("src/inner/leaf.md"), b"2").unwrap();
        copy_path_impl(dir.path(), "src", dir.path(), "src-copy").unwrap();
        assert_eq!(fs::read(dir.path().join("src-copy/top.md")).unwrap(), b"1");
        assert_eq!(fs::read(dir.path().join("src-copy/inner/leaf.md")).unwrap(), b"2");
    }

    #[test]
    fn copy_refuses_to_overwrite_existing_destination() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), b"x").unwrap();
        fs::write(dir.path().join("b.md"), b"y").unwrap();
        let err = copy_path_impl(dir.path(), "a.md", dir.path(), "b.md").unwrap_err();
        assert_eq!(err, "destination already exists");
    }

    #[test]
    fn copy_refuses_directory_into_itself() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("docs")).unwrap();
        let err = copy_path_impl(dir.path(), "docs", dir.path(), "docs/copy").unwrap_err();
        assert_eq!(err, "cannot copy a folder into itself");
    }

    #[test]
    fn copy_across_roots_duplicates_into_other_workspace() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        fs::write(a.path().join("note.md"), b"hi").unwrap();
        copy_path_impl(a.path(), "note.md", b.path(), "note.md").unwrap();
        // original stays in A, copy lands in B.
        assert_eq!(fs::read(a.path().join("note.md")).unwrap(), b"hi");
        assert_eq!(fs::read(b.path().join("note.md")).unwrap(), b"hi");
    }

    #[test]
    fn move_within_root_relocates_file() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("a.md"), b"x").unwrap();
        move_path_impl(dir.path(), "a.md", dir.path(), "sub/a.md").unwrap();
        assert!(!dir.path().join("a.md").exists());
        assert_eq!(fs::read(dir.path().join("sub/a.md")).unwrap(), b"x");
    }

    #[test]
    fn move_across_roots_relocates_and_removes_source() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        fs::write(a.path().join("note.md"), b"hi").unwrap();
        move_path_impl(a.path(), "note.md", b.path(), "note.md").unwrap();
        assert!(!a.path().join("note.md").exists());
        assert_eq!(fs::read(b.path().join("note.md")).unwrap(), b"hi");
    }

    #[test]
    fn move_across_roots_relocates_a_directory_tree() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        fs::create_dir_all(a.path().join("docs/inner")).unwrap();
        fs::write(a.path().join("docs/inner/leaf.md"), b"1").unwrap();
        move_path_impl(a.path(), "docs", b.path(), "docs").unwrap();
        assert!(!a.path().join("docs").exists());
        assert_eq!(fs::read(b.path().join("docs/inner/leaf.md")).unwrap(), b"1");
    }

    #[test]
    fn move_refuses_to_overwrite_existing_destination() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), b"x").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/a.md"), b"y").unwrap();
        let err = move_path_impl(dir.path(), "a.md", dir.path(), "sub/a.md").unwrap_err();
        assert_eq!(err, "destination already exists");
    }

    #[test]
    fn read_dir_returns_directories_before_files_alphabetically() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        touch(&root.join("zebra.md"));
        touch(&root.join("apple.md"));
        fs::create_dir(root.join("zfolder")).unwrap();
        fs::create_dir(root.join("alpha-folder")).unwrap();

        let entries = read_dir_recursive(root, root, false, None).unwrap();
        assert_eq!(names(&entries), vec!["alpha-folder", "zfolder", "apple.md", "zebra.md"]);
        assert!(entries[0].children.is_some(), "directories should carry a children vec");
        assert!(entries[2].children.is_none(), "files must not carry children");
    }

    #[test]
    fn read_dir_skips_dotfiles_when_hidden_flag_is_off() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        touch(&root.join(".secret"));
        touch(&root.join("README.md"));

        let entries = read_dir_recursive(root, root, false, None).unwrap();
        assert_eq!(names(&entries), vec!["README.md"]);

        let entries = read_dir_recursive(root, root, true, None).unwrap();
        assert_eq!(names(&entries), vec![".secret", "README.md"]);
    }

    #[test]
    fn read_dir_always_skips_bulky_dirs_even_with_hidden_on() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        for ignored in ALWAYS_IGNORED_DIRS {
            fs::create_dir(root.join(ignored)).unwrap();
            touch(&root.join(ignored).join("inside.md"));
        }
        touch(&root.join("README.md"));

        let entries = read_dir_recursive(root, root, true, None).unwrap();
        assert_eq!(names(&entries), vec!["README.md"]);
    }

    #[test]
    fn read_dir_hidden_tool_dirs_appear_only_when_hidden_flag_is_on() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::create_dir(root.join(".vscode")).unwrap();
        touch(&root.join("README.md"));

        let entries = read_dir_recursive(root, root, false, None).unwrap();
        assert_eq!(names(&entries), vec!["README.md"]);

        let entries = read_dir_recursive(root, root, true, None).unwrap();
        let entry_names = names(&entries);
        assert!(entry_names.contains(&".git"));
        assert!(entry_names.contains(&".vscode"));
        assert!(entry_names.contains(&"README.md"));
    }

    #[test]
    fn read_dir_returns_relative_paths_with_forward_slashes() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("docs")).unwrap();
        touch(&root.join("docs").join("guide.adoc"));

        let entries = read_dir_recursive(root, root, false, None).unwrap();
        let docs = entries.iter().find(|e| e.name == "docs").unwrap();
        let children = docs.children.as_ref().unwrap();
        assert_eq!(children.len(), 1);
        let guide = &children[0];
        assert_eq!(guide.path, "docs/guide.adoc");
        assert!(!guide.path.contains('\\'));
    }

    #[test]
    fn read_dir_recurses_into_nested_directories() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let deep = root.join("a").join("b").join("c");
        fs::create_dir_all(&deep).unwrap();
        touch(&deep.join("leaf.md"));

        let entries = read_dir_recursive(root, root, false, None).unwrap();
        let a = entries.iter().find(|e| e.name == "a").unwrap();
        let b = a.children.as_ref().unwrap().iter().find(|e| e.name == "b").unwrap();
        let c = b.children.as_ref().unwrap().iter().find(|e| e.name == "c").unwrap();
        let leaf = &c.children.as_ref().unwrap()[0];
        assert_eq!(leaf.kind, "file");
        assert_eq!(leaf.path, "a/b/c/leaf.md");
    }

    #[test]
    fn read_dir_respects_gitignore_when_matcher_is_supplied() {
        // Mutation captured: dropping either the file-level or
        // directory-level `matcher.matched(...).is_ignore()` check in
        // `read_dir_recursive` makes the corresponding assertion below
        // fail. Two separate checks → two separate assertions.
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(".gitignore"), b"ignored/\n*.log\n").unwrap();
        fs::create_dir(root.join("ignored")).unwrap();
        touch(&root.join("ignored").join("inside.md"));
        touch(&root.join("debug.log"));
        touch(&root.join("README.md"));

        let matcher = build_gitignore_matcher(root);
        let entries = read_dir_recursive(root, root, false, Some(&matcher)).unwrap();
        let entry_names = names(&entries);
        assert!(entry_names.contains(&"README.md"), "kept entries: {:?}", entry_names);
        assert!(!entry_names.contains(&"ignored"), "directory rule must skip the dir entry");
        assert!(!entry_names.contains(&"debug.log"), "file rule must skip matching files");
    }

    #[test]
    fn read_dir_ignores_gitignore_when_matcher_is_none() {
        // Mutation captured: a "matcher is always applied" bug (e.g. an
        // internal `unwrap_or_else(|| build_gitignore_matcher(base))`)
        // would filter even with the user-facing toggle off. Probing
        // with `None` confirms the gitignore path is opt-in.
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(".gitignore"), b"debug.log\n").unwrap();
        touch(&root.join("debug.log"));
        touch(&root.join("README.md"));

        let entries = read_dir_recursive(root, root, false, None).unwrap();
        let entry_names = names(&entries);
        assert!(entry_names.contains(&"debug.log"));
        assert!(entry_names.contains(&"README.md"));
    }

    #[test]
    fn read_dir_gitignore_with_empty_matcher_filters_nothing() {
        // Workspaces without a `.gitignore` end up with an empty
        // matcher (per `build_gitignore_matcher`'s no-file fallback).
        // The toggle being ON for such a workspace must be a no-op,
        // not surprise the user by hiding random entries.
        let dir = tempdir().unwrap();
        let root = dir.path();
        touch(&root.join("notes.md"));
        touch(&root.join("debug.log"));

        let matcher = build_gitignore_matcher(root);
        let entries = read_dir_recursive(root, root, false, Some(&matcher)).unwrap();
        assert_eq!(names(&entries), vec!["debug.log", "notes.md"]);
    }

    #[test]
    fn read_dir_returns_error_on_missing_directory() {
        let dir = tempdir().unwrap();
        let bogus = dir.path().join("does-not-exist");
        let result = read_dir_recursive(&bogus, &bogus, false, None);
        assert!(result.is_err());
    }

    /// Performance gate: a flat directory of 5,000 files MUST complete in
    /// under 1 second on any reasonable machine. The bench at
    /// `benches/read_dir.rs` gives finer-grained timings; this test only
    /// guards against accidental O(n²) regressions and stack overflows.
    /// Marked `#[ignore]` so cold runs of `cargo test` stay fast — opt in
    /// with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn read_dir_handles_5000_files_under_1s() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        for i in 0..5_000 {
            fs::write(root.join(format!("note-{i:05}.md")), b"# x\n").unwrap();
        }

        let start = std::time::Instant::now();
        let entries = read_dir_recursive(root, root, false, None).unwrap();
        let elapsed = start.elapsed();

        assert_eq!(entries.len(), 5_000, "all files should be visible");
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "5k flat files took {elapsed:?} — possible regression",
        );
    }

    /// Validates the IGNORED_DIRS filter is the early-exit path the bench
    /// assumes: 10k files inside `node_modules` must NOT contribute to the
    /// walked file count, otherwise the function would degrade to O(N) on
    /// the dependency directory rather than skip it in O(1).
    #[test]
    #[ignore]
    fn read_dir_skips_node_modules_in_o1() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("README.md"), b"# top\n").unwrap();

        let nm = root.join("node_modules");
        fs::create_dir(&nm).unwrap();
        for i in 0..10_000 {
            fs::write(nm.join(format!("pkg-{i:05}.json")), b"{}\n").unwrap();
        }

        let start = std::time::Instant::now();
        let entries = read_dir_recursive(root, root, false, None).unwrap();
        let elapsed = start.elapsed();

        assert_eq!(entries.len(), 1, "only README.md should be visible");
        assert!(
            elapsed < std::time::Duration::from_millis(50),
            "skipping node_modules took {elapsed:?} — filter regressed",
        );
    }

    // ── Watcher tests (no AppHandle needed) ──────────────────────────────
    //
    // The make_watcher function is the testable core: it accepts a callback
    // and a mode flag. We exercise it directly with a Vec<Vec<String>>
    // collector so we don't need a Tauri runtime to validate that file events
    // really do propagate through the debouncer.

    use std::sync::{Arc, Mutex as StdMutex};

    type ChangeBuffer = Arc<StdMutex<Vec<Vec<String>>>>;

    fn collect_changes() -> (ChangeBuffer, impl Fn(Vec<String>) + Send + 'static + Clone) {
        let buf: Arc<StdMutex<Vec<Vec<String>>>> = Arc::new(StdMutex::new(Vec::new()));
        let buf_clone = buf.clone();
        let cb = move |changed: Vec<String>| {
            buf_clone.lock().unwrap().push(changed);
        };
        (buf, cb)
    }

    fn wait_for_event(buf: &Arc<StdMutex<Vec<Vec<String>>>>, timeout: Duration) -> bool {
        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            if !buf.lock().unwrap().is_empty() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    #[ignore]
    fn make_watcher_dispatches_changes_with_short_debounce() {
        let dir = tempdir().unwrap();
        let watched = dir.path().to_path_buf();

        let (buf, cb) = collect_changes();
        let _debouncer = make_watcher(
            &[watched.to_string_lossy().into()],
            Duration::from_millis(100),
            false,
            cb,
        )
        .unwrap();

        // Give the OS-level watcher a moment to attach before mutating.
        std::thread::sleep(Duration::from_millis(150));
        fs::write(watched.join("hello.md"), b"# new\n").unwrap();

        assert!(
            wait_for_event(&buf, Duration::from_secs(3)),
            "expected at least one change event within 3s",
        );
        let batches = buf.lock().unwrap();
        let any_path = batches.iter().flatten().any(|p| p.contains("hello.md"));
        assert!(any_path, "change event must include the modified path; got {batches:?}");
    }

    #[test]
    #[ignore]
    fn make_watcher_recursive_picks_up_nested_changes() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();

        let (buf, cb) = collect_changes();
        let _debouncer = make_watcher(
            &[root.to_string_lossy().into()],
            Duration::from_millis(100),
            true,
            cb,
        )
        .unwrap();

        std::thread::sleep(Duration::from_millis(150));
        fs::write(sub.join("nested.md"), b"# nested\n").unwrap();

        assert!(
            wait_for_event(&buf, Duration::from_secs(3)),
            "recursive mode must surface descendant changes",
        );
    }

    #[test]
    #[ignore]
    fn make_watcher_non_recursive_ignores_grandchild_changes() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();

        let (buf, cb) = collect_changes();
        let _debouncer = make_watcher(
            &[root.to_string_lossy().into()],
            Duration::from_millis(100),
            false,
            cb,
        )
        .unwrap();

        std::thread::sleep(Duration::from_millis(150));
        // Write inside the subdir. Non-recursive mode watches only `root`
        // itself; modifying a grandchild should NOT raise an event.
        fs::write(sub.join("nested.md"), b"# nested\n").unwrap();

        // Wait long enough that any deferred event would have fired.
        std::thread::sleep(Duration::from_millis(400));
        let batches = buf.lock().unwrap();
        let any_nested = batches
            .iter()
            .flatten()
            .any(|p| p.contains("nested.md"));
        assert!(
            !any_nested,
            "non-recursive watcher leaked a descendant event: {batches:?}",
        );
    }

    // ── Property-based tests (proptest) ──────────────────────────────────
    //
    // Mirrors what fast-check does for the JS code in
    // `packages/core/src/__properties__/`. proptest generates random
    // inputs and shrinks failures to a minimal counterexample.
    //
    // Targets pure helpers — anything that touches a tempdir would slow
    // down each iteration to syscall speed, defeating the point.

    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: 200,
            failure_persistence: None, // we don't need .proptest-regressions
            ..ProptestConfig::default()
        })]

        /// `resolve_within_root` must NEVER return a path outside the root
        /// for ANY relative input that produces a successful resolution.
        /// We model this with a tempdir + a randomly-shaped relative
        /// (with optional `..` segments). The contract: success implies
        /// in-root; rejection or canonicalize error is always allowed.
        #[test]
        fn prop_resolve_within_root_never_escapes(
            segments in prop::collection::vec(
                prop::string::string_regex("[a-z][a-z0-9]{0,5}").unwrap(),
                0..6,
            ),
            dotdots in 0u8..6,
        ) {
            let dir = tempdir().unwrap();
            let root = dir.path().join("workspace");
            fs::create_dir(&root).unwrap();
            // Plant a file that DEFINITELY exists so canonicalize succeeds.
            fs::write(root.join("anchor.md"), b"x").unwrap();

            let mut parts: Vec<String> = (0..dotdots).map(|_| "..".to_string()).collect();
            parts.extend(segments.into_iter());
            let relative = if parts.is_empty() { "anchor.md".to_string() } else { parts.join("/") };

            match resolve_within_root(&root, &relative) {
                Ok(canon) => {
                    let root_canon = std::fs::canonicalize(&root).unwrap();
                    prop_assert!(
                        canon.starts_with(&root_canon),
                        "resolve_within_root accepted {relative:?} but {canon:?} is outside {root_canon:?}",
                    );
                }
                Err(_) => {
                    // Rejection is always acceptable.
                }
            }
        }

        /// `read_dir_recursive` returns entries sorted with directories
        /// before files, both groups case-insensitive ascending. This
        /// must hold for any randomly-generated tree.
        #[test]
        fn prop_read_dir_sort_invariant(
            files in prop::collection::vec(
                prop::string::string_regex("[a-zA-Z]{1,8}\\.md").unwrap(),
                0..10,
            ),
            dirs in prop::collection::vec(
                prop::string::string_regex("[a-zA-Z]{1,8}").unwrap(),
                0..6,
            ),
        ) {
            let dir = tempdir().unwrap();
            let root = dir.path();
            for f in &files {
                let _ = fs::write(root.join(f), b"x");
            }
            for d in &dirs {
                let _ = fs::create_dir(root.join(d));
            }

            let entries = match read_dir_recursive(root, root, false, None) {
                Ok(e) => e,
                Err(_) => return Ok(()), // tempdir collisions in the random set are fine
            };

            // Directories must come before files.
            let first_file_idx = entries.iter().position(|e| e.kind == "file");
            let last_dir_idx = entries.iter().rposition(|e| e.kind == "directory");
            if let (Some(first_file), Some(last_dir)) = (first_file_idx, last_dir_idx) {
                prop_assert!(
                    last_dir < first_file,
                    "directories must precede files: entries = {:?}",
                    entries.iter().map(|e| (&e.kind, &e.name)).collect::<Vec<_>>(),
                );
            }

            // Within each group, names ascend case-insensitively.
            let mut last_dir_name: Option<String> = None;
            let mut last_file_name: Option<String> = None;
            for e in &entries {
                let prev = if e.kind == "directory" { &mut last_dir_name } else { &mut last_file_name };
                let lower = e.name.to_lowercase();
                if let Some(p) = prev {
                    prop_assert!(
                        p.as_str() <= lower.as_str(),
                        "{} kind not sorted: {:?} > {:?}",
                        e.kind, p, lower,
                    );
                }
                *prev = Some(lower);
            }
        }

        /// `rename_file_impl` either moves the file (and the source no
        /// longer exists) or fails (and the source is unchanged). Never
        /// both, never neither.
        #[test]
        fn prop_rename_file_atomicity(
            src in prop::string::string_regex("[a-z]{1,8}").unwrap(),
            dst in prop::string::string_regex("[a-z]{1,8}").unwrap(),
        ) {
            let dir = tempdir().unwrap();
            let root = dir.path();
            let src_name = format!("{src}.md");
            let dst_name = format!("{dst}.md");
            fs::write(root.join(&src_name), b"content").unwrap();

            let result = rename_file_impl(root, &src_name, &dst_name);
            let src_exists = root.join(&src_name).exists();
            let dst_exists = root.join(&dst_name).exists();

            match result {
                Ok(()) => {
                    if src_name != dst_name {
                        prop_assert!(!src_exists, "successful rename must remove source");
                    }
                    prop_assert!(dst_exists, "successful rename must create destination");
                }
                Err(_) => {
                    prop_assert!(src_exists, "failed rename must leave source intact");
                }
            }
        }

        /// `find_in_files_impl` invariants under random workspace shape:
        ///   - the result list size is always ≤ FIND_IN_FILES_RESULT_LIMIT.
        ///   - every match's path stays inside the root (no escapes).
        ///   - every match's column slice equals the (case-folded) query.
        ///   - line_number / column_start / column_end are consistent with
        ///     the recorded `line_text`.
        #[test]
        fn prop_find_in_files_invariants(
            file_count in 0usize..6,
            line_count in 0usize..40,
            query in prop::string::string_regex("[a-z]{1,5}").unwrap(),
            case_sensitive in any::<bool>(),
        ) {
            let dir = tempdir().unwrap();
            let root = dir.path();
            for i in 0..file_count {
                let lines: Vec<String> = (0..line_count)
                    .map(|j| {
                        if (i + j) % 3 == 0 {
                            format!("prefix {query} suffix line {j}")
                        } else {
                            format!("noise content line {j}")
                        }
                    })
                    .collect();
                fs::write(root.join(format!("f{i}.md")), lines.join("\n")).unwrap();
            }

            let matches = find_in_files_impl(root, &query, case_sensitive, false).unwrap();
            prop_assert!(matches.len() <= FIND_IN_FILES_RESULT_LIMIT);

            let needle = if case_sensitive { query.clone() } else { query.to_lowercase() };

            for m in &matches {
                // Path is workspace-relative — must not contain `..` or
                // start with `/`.
                prop_assert!(!m.path.contains(".."));
                prop_assert!(!m.path.starts_with('/'));

                // Column offsets are consistent with line_text.
                prop_assert!(m.column_start <= m.line_text.len());
                prop_assert!(m.column_end <= m.line_text.len());
                prop_assert!(m.column_end > m.column_start);

                // The slice at the recorded columns matches the (case-folded) query.
                let slice = &m.line_text[m.column_start..m.column_end];
                let folded = if case_sensitive { slice.to_string() } else { slice.to_lowercase() };
                prop_assert_eq!(folded, needle.clone());
            }
        }
    }

    #[test]
    fn make_watcher_dropping_debouncer_stops_callbacks() {
        let dir = tempdir().unwrap();
        let watched = dir.path().to_path_buf();
        let (buf, cb) = collect_changes();

        {
            let _debouncer = make_watcher(
                &[watched.to_string_lossy().into()],
                Duration::from_millis(100),
                false,
                cb,
            )
            .unwrap();
            // Drop happens here.
        }

        std::thread::sleep(Duration::from_millis(150));
        fs::write(watched.join("after-drop.md"), b"# after\n").unwrap();
        std::thread::sleep(Duration::from_millis(400));

        let batches = buf.lock().unwrap();
        let any_after = batches
            .iter()
            .flatten()
            .any(|p| p.contains("after-drop.md"));
        assert!(
            !any_after,
            "watcher must be inert after debouncer is dropped: {batches:?}",
        );
    }

    // ── Mock-runtime tests (state lifecycle through Tauri's IPC) ─────────
    //
    // We exercise the holder pattern via a real (mocked) app: invoking the
    // commands through Tauri's IPC layer is what production does, so the
    // state-lifecycle bugs that hide in `app.try_state::<...>()` only show
    // up when called from a managed AppHandle.

    use tauri::test::{mock_app, MockRuntime};
    use tauri::{Listener, Manager};

    fn build_test_app() -> tauri::App<MockRuntime> {
        let app = mock_app();
        app.manage(WatcherHolder(Mutex::new(None)));
        app.manage(DirWatcherHolder(Mutex::new(None)));
        app
    }

    #[test]
    fn watch_paths_command_stores_debouncer_and_stop_clears_it() {
        let app = build_test_app();
        let dir = tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();

        let handle = app.handle().clone();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        runtime.block_on(async {
            watch_paths(handle.clone(), vec![path.clone()]).await.unwrap();
        });
        {
            let holder = app.state::<WatcherHolder>();
            assert!(holder.0.lock().unwrap().is_some(), "debouncer must be stored");
        }

        runtime.block_on(async {
            stop_watching(handle.clone()).await.unwrap();
        });
        {
            let holder = app.state::<WatcherHolder>();
            assert!(holder.0.lock().unwrap().is_none(), "stop must clear state");
        }
    }

    #[test]
    fn watch_dirs_command_uses_separate_state_holder() {
        let app = build_test_app();
        let dir = tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();

        let handle = app.handle().clone();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        runtime.block_on(async {
            watch_dirs(handle.clone(), vec![path.clone()]).await.unwrap();
        });
        // Both holders coexist, but only DirWatcherHolder should be populated.
        let dir_holder = app.state::<DirWatcherHolder>();
        let path_holder = app.state::<WatcherHolder>();
        assert!(dir_holder.0.lock().unwrap().is_some());
        assert!(
            path_holder.0.lock().unwrap().is_none(),
            "watch_dirs must NOT touch the path-watcher slot",
        );

        runtime.block_on(async {
            stop_watching_dirs(handle.clone()).await.unwrap();
        });
        assert!(dir_holder.0.lock().unwrap().is_none());
    }

    #[test]
    #[ignore]
    fn watch_paths_command_emits_fs_change_event_on_modification() {
        let app = build_test_app();
        let dir = tempdir().unwrap();
        let watched = dir.path().to_path_buf();
        let received: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let received_clone = received.clone();

        app.listen("fs-change", move |event| {
            let payload = event.payload().to_string();
            received_clone.lock().unwrap().push(payload);
        });

        let handle = app.handle().clone();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        runtime.block_on(async {
            watch_paths(
                handle.clone(),
                vec![watched.to_string_lossy().into()],
            )
            .await
            .unwrap();
        });

        // The default debounce is 500 ms. Wait a beat for the OS watcher to
        // attach, then mutate.
        std::thread::sleep(Duration::from_millis(200));
        fs::write(watched.join("a.md"), b"# new\n").unwrap();

        // 500 ms debounce + slack. Macos fsevent occasionally takes longer
        // on the first event after attach.
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(3) {
            if !received.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let events = received.lock().unwrap();
        assert!(
            events.iter().any(|p| p.contains("a.md")),
            "expected a fs-change event payload mentioning a.md; got {events:?}",
        );
    }

    /// Deep recursion must not stack-overflow. Use 100 levels with very short
    /// names to stay under macOS PATH_MAX (~1 KiB) while still proving the
    /// recursion isn't unbounded.
    #[test]
    #[ignore]
    fn read_dir_survives_100_levels_deep() {
        let dir = tempdir().unwrap();
        let mut path = dir.path().to_path_buf();
        for _ in 0..100 {
            path = path.join("d");
            fs::create_dir(&path).unwrap();
        }
        fs::write(path.join("leaf.md"), b"# leaf\n").unwrap();

        let result = read_dir_recursive(dir.path(), dir.path(), false, None);
        assert!(result.is_ok());
    }

    #[test]
    fn read_dir_sort_is_case_insensitive() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        touch(&root.join("Banana.md"));
        touch(&root.join("apple.md"));
        touch(&root.join("Cherry.md"));

        let entries = read_dir_recursive(root, root, false, None).unwrap();
        assert_eq!(names(&entries), vec!["apple.md", "Banana.md", "Cherry.md"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn ease_out_cubic_clamped_to_endpoints() {
        use macos_maximize::ease_out_cubic;
        assert!((ease_out_cubic(0.0) - 0.0).abs() < 1e-9);
        assert!((ease_out_cubic(1.0) - 1.0).abs() < 1e-9);
        // monotonic increasing
        let mut prev = 0.0;
        for i in 1..=10 {
            let v = ease_out_cubic(i as f64 / 10.0);
            assert!(v > prev);
            prev = v;
        }
    }

    #[test]
    fn read_file_relative_returns_content() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("note.md"), "hello").unwrap();
        let content = read_file_relative_impl(root, "note.md").unwrap();
        assert_eq!(content, "hello");
    }

    #[test]
    fn read_file_relative_returns_err_for_missing_file() {
        let dir = tempdir().unwrap();
        let result = read_file_relative_impl(dir.path(), "missing.md");
        assert!(result.is_err());
    }

    #[test]
    fn read_files_relative_silently_skips_missing_files() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.md"), "A").unwrap();
        fs::write(root.join("b.md"), "B").unwrap();
        let map = read_files_relative_impl(
            root,
            &["a.md".into(), "missing.md".into(), "b.md".into()],
        );
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("a.md"), Some(&"A".to_string()));
        assert_eq!(map.get("b.md"), Some(&"B".to_string()));
        assert!(!map.contains_key("missing.md"));
    }

    #[test]
    fn resolve_within_root_accepts_in_root_files() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("file.md"), "x").unwrap();
        let resolved = resolve_within_root(root, "file.md").unwrap();
        assert!(resolved.ends_with("file.md"));
    }

    #[test]
    fn resolve_within_root_rejects_dotdot_escape() {
        let dir = tempdir().unwrap();
        let parent = dir.path();
        let root = parent.join("workspace");
        fs::create_dir(&root).unwrap();
        // Place a sibling file OUTSIDE the workspace; canonicalize would resolve
        // `../sibling.md` to it. The contract is: must reject.
        fs::write(parent.join("sibling.md"), "secret").unwrap();
        let result = resolve_within_root(&root, "../sibling.md");
        assert!(matches!(result, Err(ref msg) if msg.contains("escapes workspace root")));
    }

    #[test]
    fn resolve_within_root_rejects_absolute_paths_pointing_elsewhere() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        // /etc on macOS canonicalizes to a real path that does not start with the
        // tmp root. PathBuf::join with an absolute path replaces the base, which
        // is exactly the attack we must defeat.
        let result = resolve_within_root(root, "/etc/hosts");
        // Either the path resolves outside (rejected with our message) or
        // canonicalize fails. Both are acceptable — the invariant is "never
        // returns a path that bypasses the root".
        match result {
            Err(msg) => assert!(msg.contains("escapes workspace root") || !msg.is_empty()),
            Ok(canon) => panic!("expected rejection, got {canon:?}"),
        }
    }

    #[test]
    fn resolve_within_root_rejects_symlink_escapes() {
        let dir = tempdir().unwrap();
        let parent = dir.path();
        let root = parent.join("workspace");
        fs::create_dir(&root).unwrap();
        let outside = parent.join("outside.md");
        fs::write(&outside, "secret").unwrap();

        // Best-effort: symlink may fail on filesystems that don't allow it
        // (e.g., FAT). Skip the assertion in that case.
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(&outside, root.join("link.md")).unwrap();
            let result = resolve_within_root(&root, "link.md");
            assert!(matches!(result, Err(ref msg) if msg.contains("escapes workspace root")));
        }
    }

    #[test]
    fn rename_file_impl_renames_inside_root() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.md"), "content").unwrap();
        rename_file_impl(root, "a.md", "b.md").unwrap();
        assert!(!root.join("a.md").exists());
        assert!(root.join("b.md").exists());
        assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "content");
    }

    #[test]
    fn rename_file_impl_rejects_source_outside_root() {
        let dir = tempdir().unwrap();
        let parent = dir.path();
        let root = parent.join("workspace");
        fs::create_dir(&root).unwrap();
        fs::write(parent.join("outside.md"), "x").unwrap();
        let result = rename_file_impl(&root, "../outside.md", "stolen.md");
        assert!(matches!(result, Err(ref msg) if msg.contains("escapes workspace root")));
        // Source must still exist — the call must NOT have moved anything.
        assert!(parent.join("outside.md").exists());
    }

    #[test]
    fn rename_file_impl_rejects_destination_outside_root() {
        let dir = tempdir().unwrap();
        let parent = dir.path();
        let root = parent.join("workspace");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a.md"), "x").unwrap();
        let result = rename_file_impl(&root, "a.md", "../escaped.md");
        assert!(result.is_err());
        // Source unchanged.
        assert!(root.join("a.md").exists());
        assert!(!parent.join("escaped.md").exists());
    }

    #[test]
    fn rename_file_impl_refuses_to_clobber_existing_destination() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.md"), "A").unwrap();
        fs::write(root.join("b.md"), "B").unwrap();
        let result = rename_file_impl(root, "a.md", "b.md");
        assert!(matches!(result, Err(ref msg) if msg.contains("destination already exists")));
        // Both files unchanged.
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "A");
        assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "B");
    }

    #[test]
    fn rename_file_impl_returns_err_for_missing_source() {
        let dir = tempdir().unwrap();
        let result = rename_file_impl(dir.path(), "missing.md", "renamed.md");
        assert!(result.is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn interpolate_frame_endpoints() {
        use macos_maximize::{interpolate_frame, CGPoint, CGRect, CGSize};
        let a = CGRect {
            origin: CGPoint { x: 0.0, y: 0.0 },
            size: CGSize { width: 100.0, height: 100.0 },
        };
        let b = CGRect {
            origin: CGPoint { x: 100.0, y: 100.0 },
            size: CGSize { width: 300.0, height: 300.0 },
        };
        let mid = interpolate_frame(a, b, 0.5);
        assert!((mid.origin.x - 50.0).abs() < 1e-9);
        assert!((mid.size.width - 200.0).abs() < 1e-9);

        let end = interpolate_frame(a, b, 1.0);
        assert!((end.origin.x - 100.0).abs() < 1e-9);
        assert!((end.size.height - 300.0).abs() < 1e-9);
    }

    // ── find_in_files_impl ──────────────────────────────────────────────

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn find_in_files_returns_one_match_per_line_containing_query() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        write_file(&root.join("a.md"), "alpha\nbeta\ngamma\nbeta again\n");
        write_file(&root.join("b.md"), "no match here");

        let matches = find_in_files_impl(root, "beta", true, false).unwrap();
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].line_number, 1);
        assert_eq!(matches[0].line_text, "beta");
        assert_eq!(matches[0].column_start, 0);
        assert_eq!(matches[0].column_end, 4);
        assert_eq!(matches[1].line_number, 3);
        assert_eq!(matches[1].line_text, "beta again");
    }

    #[test]
    fn find_in_files_empty_query_returns_no_results() {
        // Mutation captured: removing the early return would walk the
        // entire tree and produce a Match per line. The result MUST be
        // empty for the empty query — UI relies on this to avoid
        // spamming the panel while the user is still typing.
        let dir = tempdir().unwrap();
        let root = dir.path();
        write_file(&root.join("a.md"), "anything\nat all\n");

        assert_eq!(find_in_files_impl(root, "", true, false).unwrap(), vec![]);
    }

    #[test]
    fn find_in_files_case_sensitivity_toggle_changes_results() {
        // Mutation captured: ignoring the `case_sensitive` flag (always
        // case-insensitive or always case-sensitive) breaks one of the
        // two assertions below.
        let dir = tempdir().unwrap();
        let root = dir.path();
        write_file(&root.join("a.md"), "Apple\napple\nAPPLE\n");

        let sensitive = find_in_files_impl(root, "Apple", true, false).unwrap();
        assert_eq!(sensitive.len(), 1);
        assert_eq!(sensitive[0].line_number, 0);

        let insensitive = find_in_files_impl(root, "Apple", false, false).unwrap();
        assert_eq!(insensitive.len(), 3);
    }

    #[test]
    fn find_in_files_skips_always_ignored_dirs() {
        // node_modules / target etc. must never be searched even with
        // include_hidden_entries=true — they would freeze the IPC.
        let dir = tempdir().unwrap();
        let root = dir.path();
        write_file(&root.join("node_modules").join("dep.md"), "needle inside dep\n");
        write_file(&root.join("real.md"), "needle inside real\n");

        let matches = find_in_files_impl(root, "needle", true, true).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "real.md");
    }

    #[test]
    fn find_in_files_respects_include_hidden_for_dotdirs() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        write_file(&root.join(".git").join("HEAD"), "needle\n");
        write_file(&root.join("real.md"), "needle\n");

        let off = find_in_files_impl(root, "needle", true, false).unwrap();
        assert_eq!(off.len(), 1);
        assert_eq!(off[0].path, "real.md");

        let on = find_in_files_impl(root, "needle", true, true).unwrap();
        assert_eq!(on.len(), 2);
    }

    #[test]
    fn find_in_files_skips_files_larger_than_size_limit() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let big = "needle\n".repeat((FIND_IN_FILES_FILE_SIZE_LIMIT as usize / 7) + 100);
        write_file(&root.join("big.md"), &big);
        write_file(&root.join("small.md"), "needle\n");

        let matches = find_in_files_impl(root, "needle", true, false).unwrap();
        // Only small.md was scanned.
        assert!(matches.iter().all(|m| m.path == "small.md"));
        assert_eq!(matches.len(), 1);
    }

    #[test]
    fn find_in_files_skips_binary_files() {
        // Mutation captured: dropping the NUL-byte probe would attempt to
        // UTF-8 decode the binary blob, fail, and skip — but it would
        // first DO the decode work. We assert no result, which holds
        // either way. So this test is really documenting the
        // intent: skip without full decode.
        let dir = tempdir().unwrap();
        let root = dir.path();
        let mut bin = b"head\x00needle\x00tail\n".to_vec();
        bin.extend_from_slice(&[0u8; 200]);
        fs::write(root.join("blob.bin"), bin).unwrap();
        write_file(&root.join("text.md"), "needle\n");

        let matches = find_in_files_impl(root, "needle", true, false).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "text.md");
    }

    #[test]
    fn find_in_files_emits_paths_with_forward_slashes() {
        // Windows uses backslashes; the contract with the frontend is
        // forward slashes everywhere (matches `read_dir_recursive`).
        let dir = tempdir().unwrap();
        let root = dir.path();
        write_file(&root.join("a").join("b").join("c.md"), "needle\n");

        let matches = find_in_files_impl(root, "needle", true, false).unwrap();
        assert_eq!(matches.len(), 1);
        assert!(!matches[0].path.contains('\\'));
        assert_eq!(matches[0].path, "a/b/c.md");
    }

    #[test]
    fn find_in_files_caps_at_result_limit() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        // 600 lines that all match — well above the 500 cap.
        let content = "needle\n".repeat(600);
        write_file(&root.join("big.md"), &content);

        let matches = find_in_files_impl(root, "needle", true, false).unwrap();
        assert_eq!(matches.len(), FIND_IN_FILES_RESULT_LIMIT);
    }

    #[test]
    fn find_in_files_column_offsets_point_at_the_match() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        write_file(&root.join("a.md"), "prefix needle suffix\n");

        let matches = find_in_files_impl(root, "needle", true, false).unwrap();
        assert_eq!(matches.len(), 1);
        let m = &matches[0];
        // Offsets are UTF-16 code units (what the frontend's String.slice uses).
        let units: Vec<u16> = m.line_text.encode_utf16().collect();
        assert_eq!(String::from_utf16(&units[m.column_start..m.column_end]).unwrap(), "needle");
    }

    #[test]
    fn find_in_files_column_offsets_are_utf16_on_accented_lines() {
        // Regression: byte offsets made the highlight drift right on lines with
        // accents / em-dashes before the match (a global "GVC" search
        // highlighting "Pip" in "GVC/Pipeline").
        let dir = tempdir().unwrap();
        let root = dir.path();
        write_file(&root.join("a.md"), "US — Visualização — GVC/Pipeline\n");
        let matches = find_in_files_impl(root, "GVC", false, false).unwrap();
        assert_eq!(matches.len(), 1);
        let m = &matches[0];
        // Slicing the UTF-16 view (as JS String.slice does) yields exactly "GVC".
        let units: Vec<u16> = m.line_text.encode_utf16().collect();
        assert_eq!(String::from_utf16(&units[m.column_start..m.column_end]).unwrap(), "GVC");
        // The UTF-16 start is strictly less than the byte index (multi-byte
        // chars precede the match) — proving offsets aren't bytes.
        assert!(m.column_start < m.line_text.find("GVC").unwrap());
    }

    // ── Tauri-command body mutation guards (Linear DJA-43) ─────────────
    //
    // Each test below invokes a `#[tauri::command] async fn` directly so
    // that `cargo mutants` cannot replace its body with `Ok(...)` and have
    // every helper-level test still pass. The guards close the gap that
    // surfaced in the 2026-05-08 mutation-testing benchmark (DJA-36):
    // 11 mutations in this file survived because no test was actually
    // observing the side-effect or the returned content, only that the
    // lower-level `_impl` function did the right thing.

    #[tokio::test]
    async fn read_dir_command_returns_real_entries() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        touch(&root.join("alpha.md"));
        touch(&root.join("bravo.md"));

        let entries = super::read_dir(root.to_string_lossy().to_string(), None, None)
            .await
            .unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"alpha.md"), "expected alpha.md in {:?}", names);
        assert!(names.contains(&"bravo.md"), "expected bravo.md in {:?}", names);
        // Ok(vec![]) mutation would make the assertions above fail.
        assert!(!entries.is_empty(), "Ok(vec![]) mutation must not pass");
    }

    #[tokio::test]
    async fn find_in_files_command_returns_real_matches() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        write_file(&root.join("a.md"), "needle\n");

        let matches = super::find_in_files(
            root.to_string_lossy().to_string(),
            "needle".to_string(),
            Some(true),
            None,
        )
        .await
        .unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "a.md");
        assert_eq!(matches[0].line_text, "needle");
    }

    #[tokio::test]
    async fn read_file_command_returns_actual_content() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let file_path = root.join("hello.txt");
        write_file(&file_path, "asciimark-mutation-guard\n");

        let content = super::read_file(file_path.to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(content, "asciimark-mutation-guard\n");
        assert!(!content.is_empty(), "Ok(String::new()) mutation must not pass");
        assert_ne!(content, "xyzzy", "Ok(\"xyzzy\".into()) mutation must not pass");
    }

    #[tokio::test]
    async fn read_file_relative_command_returns_actual_content() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        write_file(&root.join("rel.txt"), "relative-content\n");

        let content = super::read_file_relative(
            root.to_string_lossy().to_string(),
            "rel.txt".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(content, "relative-content\n");
        assert!(!content.is_empty(), "Ok(String::new()) mutation must not pass");
        assert_ne!(content, "xyzzy", "Ok(\"xyzzy\".into()) mutation must not pass");
    }

    #[tokio::test]
    async fn write_file_command_actually_writes_to_disk() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let file_path = root.join("out.txt");
        let payload = "asciimark-write-guard\n";

        super::write_file(
            file_path.to_string_lossy().to_string(),
            payload.to_string(),
        )
        .await
        .unwrap();
        let read_back = fs::read_to_string(&file_path).unwrap();
        assert_eq!(read_back, payload, "Ok(()) mutation would skip the write");
    }

    #[tokio::test]
    async fn rename_file_command_actually_moves_file() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        write_file(&root.join("old.md"), "x");

        super::rename_file(
            root.to_string_lossy().to_string(),
            "old.md".to_string(),
            "new.md".to_string(),
        )
        .await
        .unwrap();
        assert!(!root.join("old.md").exists(), "old path should be gone");
        assert!(root.join("new.md").exists(), "new path should exist");
        assert_eq!(fs::read_to_string(root.join("new.md")).unwrap(), "x");
    }

    #[tokio::test]
    async fn trash_path_command_validates_path_escape() {
        // The OS trash service is unreliable in headless environments, so we
        // exercise the `resolve_within_root` pre-flight guard that
        // `trash_path` runs *before* calling `trash::delete`. The Ok(())
        // mutation skips this guard entirely and would erroneously succeed.
        let dir = tempdir().unwrap();
        let root = dir.path();
        write_file(&root.join("inside.md"), "x");

        let escape = super::trash_path(
            root.to_string_lossy().to_string(),
            "../escape.md".to_string(),
        )
        .await;
        assert!(
            escape.is_err(),
            "trash_path must reject path-escaping inputs; Ok(()) mutation would pass"
        );
    }

    #[test]
    fn find_in_files_skips_files_with_nul_byte_in_first_8k_probe() {
        // Guard for `const FIND_IN_FILES_BINARY_PROBE: usize = 8 * 1024;`
        // (line ~227). Mutating `*` to `+` flips the probe size from 8192
        // to 1032. A NUL planted at offset 5000 is within 8 KiB but outside
        // 1 KiB; the current code skips the file, the mutated code does
        // not — and would surface the planted "needle" further down.
        let dir = tempdir().unwrap();
        let root = dir.path();
        let mut bytes = vec![b' '; 8000];
        bytes[5000] = 0u8;
        bytes[6000..6006].copy_from_slice(b"needle");
        fs::write(root.join("planted.bin"), &bytes).unwrap();

        let matches = find_in_files_impl(root, "needle", true, false).unwrap();
        assert!(
            matches.is_empty(),
            "binary probe must catch NUL within first 8 KiB; \
             mutation 8*1024 -> 8+1024 (=1032) would miss the NUL at offset 5000 and match the planted needle"
        );
    }

    #[test]
    fn find_in_files_processes_file_at_exact_size_limit() {
        // Guard for `if metadata.len() > FIND_IN_FILES_FILE_SIZE_LIMIT`
        // (line ~290). Mutating `>` to `>=` would skip files at *exactly*
        // the limit; this fixture sits the file at the boundary so the
        // mutation flips the visible result.
        let dir = tempdir().unwrap();
        let root = dir.path();
        let mut content = String::from("needle\n");
        let pad = FIND_IN_FILES_FILE_SIZE_LIMIT as usize - content.len();
        content.push_str(&"a".repeat(pad));
        assert_eq!(
            content.len() as u64,
            FIND_IN_FILES_FILE_SIZE_LIMIT,
            "fixture must sit exactly at the boundary"
        );
        write_file(&root.join("at-limit.md"), &content);

        let matches = find_in_files_impl(root, "needle", true, false).unwrap();
        assert_eq!(
            matches.len(),
            1,
            "file at exactly FIND_IN_FILES_FILE_SIZE_LIMIT must be processed; \
             mutation > -> >= would skip it"
        );
    }
}
