use notify_debouncer_mini::{new_debouncer, DebouncedEvent};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

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
const ALWAYS_IGNORED_DIRS: &[&str] = &[
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
const HIDDEN_TOOL_DIRS: &[&str] = &[
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

fn read_dir_recursive(dir: &Path, base: &Path, include_hidden_entries: bool) -> Result<Vec<DirEntry>, String> {
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
    let full = PathBuf::from(&root).join(&relative_path);
    std::fs::read_to_string(&full).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_files_relative(root: String, paths: Vec<String>) -> Result<std::collections::HashMap<String, String>, String> {
    let root = PathBuf::from(&root);
    let mut result = std::collections::HashMap::new();
    for rel_path in paths {
        let full = root.join(&rel_path);
        if let Ok(content) = std::fs::read_to_string(&full) {
            result.insert(rel_path, content);
        }
    }
    Ok(result)
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
    let root_path = PathBuf::from(&root);
    let from = root_path.join(&old_relative);
    let to = root_path.join(&new_relative);

    // Sanity: source and destination must resolve inside the workspace root
    let root_canon = std::fs::canonicalize(&root_path).map_err(|e| e.to_string())?;
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

#[tauri::command]
async fn watch_paths(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    // Stop existing watcher
    if let Some(state) = app.try_state::<WatcherHolder>() {
        let mut lock = state.0.lock().map_err(|e| e.to_string())?;
        *lock = None;
    }

    let app_clone = app.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |events: Result<Vec<DebouncedEvent>, notify::Error>| {
            if let Ok(events) = events {
                let changed: Vec<String> = events
                    .iter()
                    .map(|e| e.path.to_string_lossy().replace('\\', "/"))
                    .collect();
                let _ = app_clone.emit("fs-change", WatchEvent { paths: changed });
            }
        },
    )
    .map_err(|e| e.to_string())?;

    // Watch each path
    let watcher = debouncer.watcher();
    for p in &paths {
        let _ = watcher.watch(Path::new(p), notify::RecursiveMode::NonRecursive);
    }

    // Store to prevent drop
    if let Some(state) = app.try_state::<WatcherHolder>() {
        let mut lock = state.0.lock().map_err(|e| e.to_string())?;
        *lock = Some(debouncer);
    }

    Ok(())
}

#[tauri::command]
async fn stop_watching(app: AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<WatcherHolder>() {
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

#[tauri::command]
fn print_webview(webview: tauri::Webview) -> Result<(), String> {
    webview.print().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(WatcherHolder(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            open_directory_dialog,
            read_dir,
            read_file,
            read_file_relative,
            read_files_relative,
            toggle_maximize_instant,
            print_webview,
            write_file,
            rename_file,
            watch_paths,
            stop_watching,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
