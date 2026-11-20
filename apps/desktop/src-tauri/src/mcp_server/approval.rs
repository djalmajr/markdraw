//! Per-operation approval gate for future MCP writes. No tool uses it yet, so
//! nothing here can be reached by an MCP client; it is the checkpoint a write
//! tool will have to pass. It fails closed: anything other than the user's
//! explicit answer, in time, from the `main` window, is a refusal.
//!
//! Guarantees, and what they rest on: an approval answers exactly one request
//! (the id is consumed by the first answer, under the same lock that looks it
//! up, and an answer is refused once the request's deadline has passed even if
//! the waiting task has not yet noticed); at most `MAX_QUEUE` requests wait at
//! once; a request that ends without an answer (deadline, queue full, client
//! gone, page reload, shutdown) tells the UI with `mcp-approval-resolved` so it
//! can drop the dialog. The origin shown to the
//! user is "a local, authenticated MCP client": the token proves the local
//! user, not which program is calling.
use super::{
    random_id,
    window::{Window, MAIN},
    Registry,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub(super) const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
pub(super) const MAX_QUEUE: usize = 4;
const MAX_OPERATION: usize = 64;
const MAX_TARGET: usize = 1024;
const MAX_SUMMARY: usize = 2048;
const REFUSED: &str = "Could not answer MCP approval";

#[derive(Debug, PartialEq, Eq)]
#[must_use]
pub(super) enum Decision {
    /// Valid for the one execution this request described.
    Approved,
    Denied,
}

struct Waiting {
    sender: tokio::sync::oneshot::Sender<bool>,
    deadline: Instant,
}

pub(super) struct Gate {
    pending: Mutex<HashMap<String, Waiting>>,
    timeout: Duration,
    queue: usize,
    closed: AtomicBool,
}
impl Default for Gate {
    fn default() -> Self {
        Self::with_limits(APPROVAL_TIMEOUT, MAX_QUEUE)
    }
}

/// Exactly `{ "id": string, "approved": boolean }`, as a JSON object: a
/// derived `Deserialize` would also read a positional sequence.
fn approved(response: &Value) -> Option<bool> {
    let map = response.as_object()?;
    if map.len() != 2 || !map.get("id")?.is_string() {
        return None;
    }
    map.get("approved")?.as_bool()
}

/// Dropped with the request (client disconnected, task cancelled): the id stops
/// being answerable, and the UI is told if it was still waiting.
struct Cancel<'a> {
    gate: &'a Gate,
    window: &'a Window,
    id: &'a str,
}
impl Drop for Cancel<'_> {
    fn drop(&mut self) {
        if self.gate.take(self.id).is_some() {
            self.gate.resolved(self.window, self.id, "cancelled");
        }
    }
}

impl Gate {
    pub(super) fn with_limits(timeout: Duration, queue: usize) -> Self {
        Self {
            pending: Mutex::default(),
            timeout,
            queue,
            closed: AtomicBool::new(false),
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Waiting>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn take(&self, id: &str) -> Option<Waiting> {
        self.lock().remove(id)
    }
    fn resolved(&self, window: &Window, id: &str, outcome: &str) {
        window.emit(
            "mcp-approval-resolved",
            json!({"id": id, "outcome": outcome}),
        );
    }
    /// Ask the user. Always resolves, and to `Denied` on every failure.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) async fn request(
        &self,
        window: &Window,
        operation: &str,
        target: &str,
        summary: &str,
    ) -> Decision {
        if operation.len() > MAX_OPERATION
            || target.len() > MAX_TARGET
            || summary.len() > MAX_SUMMARY
        {
            return Decision::Denied;
        }
        let Ok(id) = random_id() else {
            return Decision::Denied;
        };
        let (sender, mut receiver) = tokio::sync::oneshot::channel();
        let deadline = Instant::now() + self.timeout;
        {
            let mut pending = self.lock();
            if self.closed.load(Ordering::Acquire) {
                return Decision::Denied;
            }
            if pending.len() >= self.queue {
                // Never shown, but the UI is told it ended, so a request it
                // somehow heard of cannot stay on screen.
                drop(pending);
                self.resolved(window, &id, "cancelled");
                return Decision::Denied;
            }
            pending.insert(id.clone(), Waiting { sender, deadline });
        }
        let _cancel = Cancel {
            gate: self,
            window,
            id: &id,
        };
        if !window.emit(
            "mcp-approval-request",
            json!({"id": id, "operation": operation, "target": target, "summary": summary}),
        ) {
            return Decision::Denied;
        }
        match tokio::time::timeout_at(deadline.into(), &mut receiver).await {
            // The clock decides, not the order the tasks happened to run in.
            Ok(Ok(true)) if Instant::now() <= deadline => Decision::Approved,
            Ok(_) => Decision::Denied,
            Err(_) => {
                // An answer that races the deadline loses: the id is gone
                // before anything can be approved.
                self.take(&id);
                self.resolved(window, &id, "expired");
                Decision::Denied
            }
        }
    }
    /// The user's answer. Refused for any window but `main`, and for an id that
    /// is not waiting or whose deadline has passed (late, repeated, invented).
    /// A malformed answer for a waiting id denies that request instead of
    /// leaving it open.
    pub(super) fn respond(
        &self,
        window: &Window,
        from_main: bool,
        response: Value,
    ) -> Result<(), &'static str> {
        if !from_main {
            return Err(REFUSED);
        }
        let id = response
            .get("id")
            .and_then(Value::as_str)
            .ok_or(REFUSED)?
            .to_owned();
        let waiting = self.take(&id).ok_or(REFUSED)?;
        if Instant::now() >= waiting.deadline {
            // The id is consumed: the request is denied and the UI told.
            let _ = waiting.sender.send(false);
            self.resolved(window, &id, "expired");
            return Err(REFUSED);
        }
        match approved(&response) {
            // A dropped receiver means the request is gone: nothing used it.
            Some(approved) => waiting.sender.send(approved).map_err(|_| REFUSED),
            None => {
                let _ = waiting.sender.send(false);
                self.resolved(window, &id, "cancelled");
                Err(REFUSED)
            }
        }
    }
    /// Page reload: every request still waiting is denied and the UI told.
    pub(super) fn cancel_all(&self, window: &Window) {
        let drained: Vec<_> = self.lock().drain().collect();
        for (id, waiting) in drained {
            let _ = waiting.sender.send(false);
            self.resolved(window, &id, "cancelled");
        }
    }
    pub(super) fn close(&self, window: &Window) {
        self.closed.store(true, Ordering::Release);
        self.cancel_all(window);
    }
}

#[tauri::command]
pub fn mcp_approval_respond<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    response: Value,
    registry: tauri::State<'_, Arc<Registry>>,
) -> Result<(), String> {
    registry
        .approvals
        .respond(&registry.window, webview.label() == MAIN, response)
        .map_err(str::to_owned)
}

#[cfg(test)]
#[path = "approval_tests.rs"]
mod tests;
