//! OS keychain storage for AI provider API keys, plus read/write of the AI
//! config file (DJA-11E).
//!
//! API keys NEVER touch the config JSON or localStorage — they live only in the
//! platform secure store (macOS Keychain, Windows Credential Manager, Linux
//! Secret Service) via the cross-platform `keyring` crate. The `ai.json` config
//! holds the provider catalog WITHOUT keys.

use tauri::{AppHandle, Manager};

/// Keychain service name; the account is the provider id (e.g. "anthropic").
/// Uses the app's own reverse-DNS identifier — a namespace we actually control
/// (`dev.djalmajr.asciimark`) — instead of `com.asciimark` (we don't own
/// asciimark.com).
const SERVICE: &str = "dev.djalmajr.asciimark";

/// Pre-rename service name. Read once for a lazy migration so users who stored
/// keys under the old service don't have to re-enter them (see ai_get_api_key).
const LEGACY_SERVICE: &str = "com.asciimark.ai";

fn entry(provider_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, provider_id).map_err(|e| e.to_string())
}

fn legacy_entry(provider_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(LEGACY_SERVICE, provider_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_set_api_key(provider_id: String, key: String) -> Result<(), String> {
    entry(&provider_id)?
        .set_password(&key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_get_api_key(provider_id: String) -> Result<Option<String>, String> {
    match entry(&provider_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        // Not under the current service — try the pre-rename one and migrate the
        // key forward, so the old `com.asciimark.ai` item is read at most once.
        Err(keyring::Error::NoEntry) => match legacy_entry(&provider_id)?.get_password() {
            Ok(password) => {
                // Best-effort migration: copy into the new service, drop the old.
                let _ = entry(&provider_id)?.set_password(&password);
                let _ = legacy_entry(&provider_id)?.delete_credential();
                Ok(Some(password))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        },
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn ai_delete_api_key(provider_id: String) -> Result<(), String> {
    // Deleting a key that isn't there is a no-op, not an error. Clear both the
    // current and legacy services so a migrated-but-not-yet-read key can't linger.
    let del = |e: keyring::Entry| match e.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    };
    del(entry(&provider_id)?)?;
    del(legacy_entry(&provider_id)?)?;
    Ok(())
}

/// `<app_config_dir>/ai.json` — the provider catalog (never the keys).
fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("ai.json"))
}

#[tauri::command]
pub async fn ai_read_config(app: AppHandle) -> Result<Option<String>, String> {
    let path = config_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn ai_write_config(app: AppHandle, contents: String) -> Result<(), String> {
    let path = config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // These hit the real OS keychain (macOS prompts for access; Linux needs a
    // running Secret Service), so they are #[ignore]d in CI and run locally
    // with `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn set_get_delete_round_trip() {
        let id = "asciimark-test-provider".to_string();
        ai_set_api_key(id.clone(), "secret-123".to_string())
            .await
            .unwrap();
        assert_eq!(
            ai_get_api_key(id.clone()).await.unwrap(),
            Some("secret-123".to_string())
        );
        ai_delete_api_key(id.clone()).await.unwrap();
        assert_eq!(ai_get_api_key(id.clone()).await.unwrap(), None);
        // delete is idempotent
        ai_delete_api_key(id).await.unwrap();
    }
}
