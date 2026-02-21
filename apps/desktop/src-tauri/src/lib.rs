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

const IGNORED_DIRS: &[&str] = &[
    "node_modules", ".git", "dist", "build", "out", "target",
    ".next", ".nuxt", ".output", ".cache", ".turbo", ".svelte-kit",
    "vendor", "__pycache__", ".venv", "venv", ".idea", ".vscode",
    "coverage", ".nyc_output", "tmp", "temp",
];

const SUPPORTED_EXTENSIONS: &[&str] = &[
    "adoc", "asciidoc", "asc", "ad", "md", "markdown", "mdown",
];

fn is_supported_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    SUPPORTED_EXTENSIONS.iter().any(|ext| lower.ends_with(&format!(".{}", ext)))
}

fn read_dir_recursive(dir: &Path, base: &Path) -> Result<Vec<DirEntry>, String> {
    let mut entries = Vec::new();
    let read = std::fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in read {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') {
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
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            let children = read_dir_recursive(&entry.path(), base)?;
            if !children.is_empty() {
                entries.push(DirEntry {
                    name,
                    kind: "directory".into(),
                    path: rel_path,
                    children: Some(children),
                });
            }
        } else if file_type.is_file() && is_supported_file(&name) {
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
async fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let path = PathBuf::from(&path);
    read_dir_recursive(&path, &path)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(WatcherHolder(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            open_directory_dialog,
            read_dir,
            read_file,
            read_file_relative,
            read_files_relative,
            write_file,
            watch_paths,
            stop_watching,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
