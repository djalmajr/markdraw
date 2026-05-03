use notify_debouncer_mini::{new_debouncer, DebouncedEvent};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

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

pub fn read_dir_recursive(dir: &Path, base: &Path, include_hidden_entries: bool) -> Result<Vec<DirEntry>, String> {
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
        let rel_path = entry
            .path()
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
            let children = read_dir_recursive(&entry.path(), base, include_hidden_entries)?;
            entries.push(DirEntry {
                name,
                kind: "directory".into(),
                path: rel_path,
                children: Some(children),
            });
        } else if file_type.is_file() {
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
async fn read_dir(path: String, include_hidden_entries: Option<bool>) -> Result<Vec<DirEntry>, String> {
    let path = PathBuf::from(&path);
    read_dir_recursive(&path, &path, include_hidden_entries.unwrap_or(false))
}

#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
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

/// Resolve `relative` against `root` and confirm the result still lives
/// inside the canonicalized root. Returns the canonicalized target on
/// success; rejects symlink escapes, `..` traversal, and absolute paths
/// pointing outside the workspace.
pub fn resolve_within_root(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let target = root.join(relative);
    let root_canon = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let target_canon = std::fs::canonicalize(&target).map_err(|e| e.to_string())?;
    if !target_canon.starts_with(&root_canon) {
        return Err("path escapes workspace root".into());
    }
    Ok(target_canon)
}

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

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGPoint {
        pub x: f64,
        pub y: f64,
    }

    unsafe impl Encode for CGPoint {
        const ENCODING: Encoding =
            Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }

    unsafe impl RefEncode for CGPoint {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGSize {
        pub width: f64,
        pub height: f64,
    }

    unsafe impl Encode for CGSize {
        const ENCODING: Encoding =
            Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }

    unsafe impl RefEncode for CGSize {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGRect {
        pub origin: CGPoint,
        pub size: CGSize,
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

    pub fn interpolate_frame(from: CGRect, to: CGRect, t: f64) -> CGRect {
        CGRect {
            origin: CGPoint {
                x: from.origin.x + (to.origin.x - from.origin.x) * t,
                y: from.origin.y + (to.origin.y - from.origin.y) * t,
            },
            size: CGSize {
                width: from.size.width + (to.size.width - from.size.width) * t,
                height: from.size.height + (to.size.height - from.size.height) * t,
            },
        }
    }

    pub fn ease_out_cubic(t: f64) -> f64 {
        1.0 - (1.0 - t).powi(3)
    }

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

#[tauri::command]
fn print_webview(webview: tauri::Webview) -> Result<(), String> {
    webview.print().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // Dev-only: bind on 127.0.0.1 so the MCP bridge isn't exposed on the LAN.
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .build(),
        );
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
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
        }))
        .manage(WatcherHolder(Mutex::new(None)))
        .manage(DirWatcherHolder(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            open_directory_dialog,
            read_dir,
            read_file,
            read_file_relative,
            read_files_relative,
            get_startup_args,
            set_dock_visible,
            toggle_maximize_instant,
            print_webview,
            write_file,
            rename_file,
            trash_path,
            watch_paths,
            stop_watching,
            watch_dirs,
            stop_watching_dirs,
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
    fn read_dir_returns_directories_before_files_alphabetically() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        touch(&root.join("zebra.md"));
        touch(&root.join("apple.md"));
        fs::create_dir(root.join("zfolder")).unwrap();
        fs::create_dir(root.join("alpha-folder")).unwrap();

        let entries = read_dir_recursive(root, root, false).unwrap();
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

        let entries = read_dir_recursive(root, root, false).unwrap();
        assert_eq!(names(&entries), vec!["README.md"]);

        let entries = read_dir_recursive(root, root, true).unwrap();
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

        let entries = read_dir_recursive(root, root, true).unwrap();
        assert_eq!(names(&entries), vec!["README.md"]);
    }

    #[test]
    fn read_dir_hidden_tool_dirs_appear_only_when_hidden_flag_is_on() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::create_dir(root.join(".vscode")).unwrap();
        touch(&root.join("README.md"));

        let entries = read_dir_recursive(root, root, false).unwrap();
        assert_eq!(names(&entries), vec!["README.md"]);

        let entries = read_dir_recursive(root, root, true).unwrap();
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

        let entries = read_dir_recursive(root, root, false).unwrap();
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

        let entries = read_dir_recursive(root, root, false).unwrap();
        let a = entries.iter().find(|e| e.name == "a").unwrap();
        let b = a.children.as_ref().unwrap().iter().find(|e| e.name == "b").unwrap();
        let c = b.children.as_ref().unwrap().iter().find(|e| e.name == "c").unwrap();
        let leaf = &c.children.as_ref().unwrap()[0];
        assert_eq!(leaf.kind, "file");
        assert_eq!(leaf.path, "a/b/c/leaf.md");
    }

    #[test]
    fn read_dir_returns_error_on_missing_directory() {
        let dir = tempdir().unwrap();
        let bogus = dir.path().join("does-not-exist");
        let result = read_dir_recursive(&bogus, &bogus, false);
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
        let entries = read_dir_recursive(root, root, false).unwrap();
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
        let entries = read_dir_recursive(root, root, false).unwrap();
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

    fn collect_changes()
    -> (Arc<StdMutex<Vec<Vec<String>>>>, impl Fn(Vec<String>) + Send + 'static + Clone) {
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

        let result = read_dir_recursive(dir.path(), dir.path(), false);
        assert!(result.is_ok());
    }

    #[test]
    fn read_dir_sort_is_case_insensitive() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        touch(&root.join("Banana.md"));
        touch(&root.join("apple.md"));
        touch(&root.join("Cherry.md"));

        let entries = read_dir_recursive(root, root, false).unwrap();
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
}
