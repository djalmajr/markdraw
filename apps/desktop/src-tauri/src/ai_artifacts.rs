use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

/// Upper bound on a single artifact blob. Artifacts hold large tool results;
/// this bounds disk use and the payload the frontend later reads back over IPC.
const MAX_ARTIFACT_BYTES: usize = 5 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactWriteResult {
    pub byte_length: usize,
    pub path: String,
}

fn safe_segment(input: &str) -> Result<String, String> {
    let value = input.trim();
    if value.is_empty() {
        return Err("artifact segment is required".to_string());
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("artifact segment may contain only letters, numbers, '-' and '_'".to_string());
    }
    Ok(value.to_string())
}

fn artifacts_dir<R: Runtime>(app: &AppHandle<R>, session_id: &str) -> Result<PathBuf, String> {
    let session = safe_segment(session_id)?;
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("ai-artifacts")
        .join(session))
}

fn remove_dir_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        std::fs::remove_dir_all(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_artifact_write<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    artifact_id: String,
    content: String,
) -> Result<ArtifactWriteResult, String> {
    let id = safe_segment(&artifact_id)?;
    if content.len() > MAX_ARTIFACT_BYTES {
        return Err(format!(
            "artifact too large: {} bytes (max {MAX_ARTIFACT_BYTES})",
            content.len()
        ));
    }
    let dir = artifacts_dir(&app, &session_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id}.json"));
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(ArtifactWriteResult {
        byte_length: content.len(),
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn ai_artifact_read<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    artifact_id: String,
) -> Result<String, String> {
    let id = safe_segment(&artifact_id)?;
    let path = artifacts_dir(&app, &session_id)?.join(format!("{id}.json"));
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_artifact_delete_session<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
) -> Result<(), String> {
    remove_dir_if_exists(&artifacts_dir(&app, &session_id)?)
}

#[tauri::command]
pub async fn ai_artifact_copy_session<R: Runtime>(
    app: AppHandle<R>,
    source_session_id: String,
    target_session_id: String,
) -> Result<(), String> {
    // Copying a session onto itself would wipe the target (== source) first and
    // then find nothing to copy back — a no-op that must not delete anything.
    if safe_segment(&source_session_id)? == safe_segment(&target_session_id)? {
        return Ok(());
    }
    let source = artifacts_dir(&app, &source_session_id)?;
    let target = artifacts_dir(&app, &target_session_id)?;
    remove_dir_if_exists(&target)?;
    if !source.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.file_type().map_err(|e| e.to_string())?;
        if !meta.is_file() {
            continue;
        }
        let target_path = target.join(entry.file_name());
        std::fs::copy(entry.path(), target_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
