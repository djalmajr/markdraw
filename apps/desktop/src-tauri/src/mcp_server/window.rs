//! The one webview the MCP server talks to: the window labelled `main`.
//! Requests for live state and approvals are events to that window only; the
//! answers come back through Tauri commands that check the caller's label.
use serde_json::Value;
use std::sync::{Arc, RwLock};
use tauri::{Emitter, EventTarget, Manager, Runtime};

pub const MAIN: &str = "main";

pub trait MainEmitter: Send + Sync {
    /// Deliver `event` to the `main` window only. `false` when that window
    /// does not exist or the event could not be delivered.
    fn emit(&self, event: &str, payload: Value) -> bool;
}

struct TauriMain<R: Runtime>(tauri::AppHandle<R>);
impl<R: Runtime> MainEmitter for TauriMain<R> {
    fn emit(&self, event: &str, payload: Value) -> bool {
        self.0.get_webview_window(MAIN).is_some()
            && self
                .0
                .emit_to(EventTarget::labeled(MAIN), event, payload)
                .is_ok()
    }
}

pub fn tauri_main<R: Runtime>(app: tauri::AppHandle<R>) -> Arc<dyn MainEmitter> {
    Arc::new(TauriMain(app))
}

#[derive(Default)]
pub(super) struct Window(RwLock<Option<Arc<dyn MainEmitter>>>);
impl Window {
    pub(super) fn attach(&self, emitter: Arc<dyn MainEmitter>) {
        *self.0.write().unwrap_or_else(|e| e.into_inner()) = Some(emitter);
    }
    pub(super) fn emit(&self, event: &str, payload: Value) -> bool {
        let emitter = self.0.read().unwrap_or_else(|e| e.into_inner()).clone();
        emitter.is_some_and(|emitter| emitter.emit(event, payload))
    }
}

/// The user's confirmation of the one change that lowers the MCP server's
/// protection (masking off), asked by the app itself in a native dialog, so a
/// compromised webview cannot grant it.
pub trait Confirm: Send + Sync {
    /// `true` only when the user chose to turn masking off. Blocks until the
    /// user answers.
    fn disable_masking(&self) -> bool;
}

struct Texts {
    title: &'static str,
    body: &'static str,
    confirm: &'static str,
    cancel: &'static str,
}
fn texts(locale: &str) -> Texts {
    let locale = locale.to_ascii_lowercase();
    if locale.starts_with("pt") {
        Texts {
            title: "Desativar a máscara de segredos do servidor MCP",
            body: "Clientes MCP locais passarão a receber chaves, tokens e senhas em texto claro nos arquivos, na busca e no estado do editor. Desativar só se você confia em todos os clientes MCP que roda neste computador.",
            confirm: "Desativar",
            cancel: "Cancelar",
        }
    } else if locale.starts_with("es") {
        Texts {
            title: "Desactivar el enmascaramiento de secretos del servidor MCP",
            body: "Los clientes MCP locales recibirán claves, tokens y contraseñas en texto claro en los archivos, la búsqueda y el estado del editor. Desactívalo solo si confías en todos los clientes MCP que ejecutas en este equipo.",
            confirm: "Desactivar",
            cancel: "Cancelar",
        }
    } else {
        Texts {
            title: "Turn off secret masking for the MCP server",
            body: "Local MCP clients will receive keys, tokens and passwords in clear text in files, search results and the editor state. Turn this off only if you trust every MCP client you run on this computer.",
            confirm: "Turn off",
            cancel: "Cancel",
        }
    }
}
fn system_locale() -> String {
    ["LC_ALL", "LC_MESSAGES", "LANGUAGE", "LANG"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

struct TauriConfirm<R: Runtime>(tauri::AppHandle<R>);
impl<R: Runtime> Confirm for TauriConfirm<R> {
    fn disable_masking(&self) -> bool {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let text = texts(&system_locale());
        self.0
            .dialog()
            .message(text.body)
            .title(text.title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                text.confirm.to_owned(),
                text.cancel.to_owned(),
            ))
            .blocking_show()
    }
}

pub fn tauri_confirm<R: Runtime>(app: tauri::AppHandle<R>) -> Arc<dyn Confirm> {
    Arc::new(TauriConfirm(app))
}

/// Where the confirmation lives. Until one is attached nothing can be
/// confirmed, so the change is refused.
#[derive(Default)]
pub(super) struct Confirmer(RwLock<Option<Arc<dyn Confirm>>>);
impl Confirmer {
    pub(super) fn attach(&self, confirm: Arc<dyn Confirm>) {
        *self.0.write().unwrap_or_else(|e| e.into_inner()) = Some(confirm);
    }
    pub(super) fn disable_masking(&self) -> bool {
        let confirm = self.0.read().unwrap_or_else(|e| e.into_inner()).clone();
        confirm.is_some_and(|confirm| confirm.disable_masking())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_dialog_text_follows_the_system_language() {
        assert!(texts("pt_BR.UTF-8").title.contains("Desativar"));
        assert!(texts("es_ES.UTF-8").title.contains("Desactivar"));
        assert!(texts("en_US.UTF-8").title.contains("Turn off"));
        assert!(texts("").title.contains("Turn off"));
    }
}
