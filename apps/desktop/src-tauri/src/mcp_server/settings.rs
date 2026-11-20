//! `mcp-server.json`: the one switch for the external MCP server, whether to
//! mask secrets in what it returns. The Rust side is the authority: the file
//! is loaded before the endpoint accepts a call, anything missing, unreadable
//! or malformed means "mask", and only the `main` window can change it.
//! Turning masking off is the one change that needs the user: it asks through
//! a native dialog owned by the app (`Confirm`), so a webview alone cannot
//! lower the protection. Turning it on never asks. A "no" in that dialog pauses
//! every further request to turn masking off for `PAUSE` (answered like the
//! "no", without a dialog); the pause lives in the app, so reloading the page
//! does not clear it.
use super::{random_id, window::MAIN, Registry};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    },
    time::{Duration, Instant},
};

pub const FILE_NAME: &str = "mcp-server.json";
const MAX_FILE: u64 = 4096;
const ERROR: &str = "Could not update MCP server settings";
/// What the page is told when the user said no (or the pause answered for
/// them): a fixed code, not a failure.
pub const DECLINED: &str = "declined";
/// After a "no", requests to turn masking off are refused for this long.
pub(super) const PAUSE: Duration = Duration::from_secs(30);

/// Why `Policy::change` did not change anything.
#[derive(Debug)]
pub(super) enum Refused {
    /// The user said no, or an earlier no still pauses the question.
    Declined,
    Failed(io::Error),
}
impl From<io::Error> for Refused {
    fn from(error: io::Error) -> Self {
        Refused::Failed(error)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub mask_secrets: bool,
}
// Only a JSON object with exactly `maskSecrets: <bool>`. A derived
// `Deserialize` would also read a bare array (`[false]`) as this struct.
impl<'de> Deserialize<'de> for Settings {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Only;
        impl<'de> serde::de::Visitor<'de> for Only {
            type Value = Settings;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object with maskSecrets")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Settings, A::Error> {
                let mut mask = None;
                while let Some(key) = map.next_key::<String>()? {
                    if key != "maskSecrets" || mask.is_some() {
                        return Err(serde::de::Error::custom("unexpected field"));
                    }
                    mask = Some(map.next_value::<bool>()?);
                }
                mask.map(|mask_secrets| Settings { mask_secrets })
                    .ok_or_else(|| serde::de::Error::missing_field("maskSecrets"))
            }
        }
        deserializer.deserialize_map(Only)
    }
}
impl Default for Settings {
    fn default() -> Self {
        Self { mask_secrets: true }
    }
}

/// Missing, unreadable, oversized or malformed: the safe default (mask).
pub(super) fn load(path: &Path) -> Settings {
    let read = || -> io::Result<Vec<u8>> {
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(MAX_FILE + 1)
            .read_to_end(&mut bytes)?;
        Ok(bytes)
    };
    match read() {
        Ok(bytes) if bytes.len() as u64 <= MAX_FILE => {
            serde_json::from_slice(&bytes).unwrap_or_default()
        }
        _ => Settings::default(),
    }
}

/// Write a sibling temp file, flush it, then rename it over the target, so a
/// reader (or a crash) sees either the old file or the new one, never half.
pub(super) fn save(path: &Path, settings: Settings) -> io::Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    fs::create_dir_all(directory)?;
    let temporary = directory.join(format!(".{FILE_NAME}.{}.tmp", &random_id()?[..16]));
    let write = || -> io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec(&settings).map_err(io::Error::other)?)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    };
    write().inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })
}

/// What the one lock below also guards: the confirmation dialog and the pause.
#[derive(Default)]
struct Gate {
    // A confirmation dialog is open (one at a time).
    dialog: bool,
    // Until when a "no" keeps the question from being asked again.
    paused_until: Option<Instant>,
}

pub(super) struct Policy {
    mask: AtomicBool,
    path: OnceLock<PathBuf>,
    // The one lock for everything that decides or writes the setting: "is the
    // value already off, is the question paused, may a dialog open" is decided
    // under it, "write the file, then publish the value" happens under it, and
    // so does "publish the pause, then free the dialog". A change that turns
    // masking off holds it only to decide and to write, never while the native
    // dialog is on screen, so turning masking on stays available.
    write: Mutex<Gate>,
    // Bumped when the page reloads: a confirmation that was already open for
    // the old page grants nothing.
    epoch: AtomicU64,
    pause: Duration,
}
impl Default for Policy {
    fn default() -> Self {
        // Until the file says otherwise, mask.
        Self {
            mask: AtomicBool::new(true),
            path: OnceLock::new(),
            write: Mutex::default(),
            epoch: AtomicU64::new(0),
            pause: PAUSE,
        }
    }
}
impl Policy {
    fn gate(&self) -> MutexGuard<'_, Gate> {
        self.write.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// The value one request uses, read once at its start.
    pub(super) fn mask(&self) -> bool {
        self.mask.load(Ordering::Acquire)
    }
    pub(super) fn get(&self) -> Settings {
        Settings {
            mask_secrets: self.mask(),
        }
    }
    pub(super) fn configure(&self, path: PathBuf) {
        let settings = load(&path);
        let _guard = self.gate();
        if self.path.set(path).is_ok() {
            self.mask.store(settings.mask_secrets, Ordering::Release);
        }
    }
    pub(super) fn set(&self, settings: Settings) -> io::Result<()> {
        let path = self
            .path
            .get()
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        self.set_with(settings, |settings| save(path, settings))
    }
    pub(super) fn page_reloading(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
    }
    /// Apply a change from the page. Turning masking off asks `confirm` first
    /// (a blocking native dialog) and writes only on a yes, with the same page
    /// and no other dialog open. A no, and any request inside the pause that a
    /// no starts, is `Declined` and opens nothing; anything else that fails is
    /// `Failed`. Nothing changes in either case. Turning it off when it is
    /// already off (read under the lock, so a concurrent turn-on cannot slip
    /// in between) is a request with nothing to do: it asks nothing and writes
    /// nothing.
    pub(super) fn change(
        &self,
        settings: Settings,
        confirm: impl FnOnce() -> bool,
    ) -> Result<(), Refused> {
        self.change_with(settings, Instant::now, confirm)
    }
    /// `change` with the clock given, so the pause is testable to the instant.
    pub(super) fn change_with(
        &self,
        settings: Settings,
        clock: impl Fn() -> Instant,
        confirm: impl FnOnce() -> bool,
    ) -> Result<(), Refused> {
        if settings.mask_secrets {
            return Ok(self.set(settings)?);
        }
        let denied = || io::Error::from(io::ErrorKind::PermissionDenied);
        let path = self
            .path
            .get()
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        let epoch = {
            let mut gate = self.gate();
            if !self.mask() {
                return Ok(());
            }
            if gate.paused_until.is_some_and(|until| clock() < until) {
                return Err(Refused::Declined);
            }
            if gate.dialog {
                return Err(denied().into());
            }
            gate.dialog = true;
            self.epoch.load(Ordering::Acquire)
        };
        // A dialog that panics is a "no": the reservation must not stay held.
        let granted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(confirm))
            .inspect_err(|_| eprintln!("Markdraw MCP settings confirmation failed"))
            .unwrap_or(false);
        let mut gate = self.gate();
        if !granted {
            // The pause starts when the user answered, and is published before
            // the dialog is freed, in one step: no request sees a free dialog
            // without the pause.
            gate.paused_until = Some(clock() + self.pause);
            gate.dialog = false;
            return Err(Refused::Declined);
        }
        gate.dialog = false;
        if self.epoch.load(Ordering::Acquire) != epoch {
            return Err(denied().into());
        }
        save(path, settings)?;
        self.mask.store(settings.mask_secrets, Ordering::Release);
        Ok(())
    }
    pub(super) fn set_with(
        &self,
        settings: Settings,
        persist: impl FnOnce(Settings) -> io::Result<()>,
    ) -> io::Result<()> {
        let _guard = self.gate();
        persist(settings)?;
        self.mask.store(settings.mask_secrets, Ordering::Release);
        Ok(())
    }
}

#[tauri::command]
pub fn mcp_server_get_settings<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    registry: tauri::State<'_, Arc<Registry>>,
) -> Result<Settings, String> {
    if webview.label() != MAIN {
        return Err(ERROR.into());
    }
    Ok(registry.policy.get())
}

#[tauri::command]
pub async fn mcp_server_set_settings<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    settings: Settings,
    registry: tauri::State<'_, Arc<Registry>>,
) -> Result<(), String> {
    if webview.label() != MAIN {
        return Err(ERROR.into());
    }
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        registry
            .policy
            .change(settings, || registry.confirm.disable_masking())
    })
    .await
    .map_err(|_| ERROR.to_string())?
    .map_err(|refused| match refused {
        Refused::Declined => DECLINED.to_owned(),
        Refused::Failed(error) => {
            // The page gets fixed text; the cause (its kind, never a path) is kept here.
            eprintln!("Markdraw MCP settings not changed ({:?})", error.kind());
            ERROR.to_owned()
        }
    })
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
