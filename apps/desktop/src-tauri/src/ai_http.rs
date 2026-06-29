//! Streaming HTTP for AI providers — the real-streaming transport (F1).
//!
//! `tauri-plugin-http` delivers a response only after buffering it whole, so
//! SSE never reaches the webview incrementally — the reason the chat engine
//! shipped on `generateText` + fake chunking (see `engines/ai-sdk.ts`). This
//! module performs the provider POST in Rust with `reqwest`, reads the body
//! as it arrives and pushes COMPLETE LINES to the webview over a
//! [`tauri::ipc::Channel`]. SSE is line-delimited, so line framing both
//! preserves UTF-8 (a multibyte character never spans a `\n` byte) and lets
//! the JS side rebuild a streaming `Response` body for the AI SDK verbatim.

use std::collections::HashMap;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::{oneshot, Mutex};

/// In-flight streams keyed by a caller-supplied id so the webview can cancel
/// (the chat's Stop button aborts the fetch, which invokes the cancel command).
#[derive(Default)]
pub struct HttpStreamManager {
    inflight: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamRequest {
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    /// First event: response status + headers (the JS Response envelope).
    Status {
        status: u16,
        headers: HashMap<String, String>,
    },
    /// One complete line of the body, WITHOUT its trailing `\n`.
    Line { line: String },
    /// Body finished cleanly.
    Done,
    /// Transport-level failure (connect, TLS, mid-body). Terminal.
    Error { message: String },
}

/// Drain every complete `\n`-terminated line out of `buf`, returning them
/// without the terminator and leaving the unterminated tail in place. Pure so
/// the framing is unit-testable without a socket.
fn drain_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let mut line: Vec<u8> = buf.drain(..=pos).collect();
        line.pop(); // the '\n'
        if line.last() == Some(&b'\r') {
            line.pop(); // SSE allows CRLF
        }
        out.push(String::from_utf8_lossy(&line).into_owned());
    }
    out
}

async fn run_stream(
    request: StreamRequest,
    on_event: &Channel<StreamEvent>,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let method = request.method.as_deref().unwrap_or("POST");
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("invalid method: {e}"))?;
    let mut req = client.request(method, &request.url);
    if let Some(headers) = &request.headers {
        for (name, value) in headers {
            req = req.header(name, value);
        }
    }
    if let Some(body) = request.body {
        req = req.body(body);
    }

    let response = req.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let headers: HashMap<String, String> = response
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string())))
        .collect();
    let _ = on_event.send(StreamEvent::Status { status, headers });

    let mut stream = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        tokio::select! {
            chunk = stream.next() => match chunk {
                Some(Ok(bytes)) => {
                    buf.extend_from_slice(&bytes);
                    for line in drain_lines(&mut buf) {
                        let _ = on_event.send(StreamEvent::Line { line });
                    }
                }
                Some(Err(e)) => return Err(e.to_string()),
                None => break,
            },
            _ = &mut cancel_rx => return Err("cancelled".to_string()),
        }
    }
    if !buf.is_empty() {
        let _ = on_event.send(StreamEvent::Line {
            line: String::from_utf8_lossy(&buf).into_owned(),
        });
    }
    Ok(())
}

/// Stream an AI-provider HTTP request. Always resolves `Ok` — the outcome
/// travels on the channel (`Done` / `Error`) so the JS fetch shim has a single
/// place to read it from.
#[tauri::command]
pub async fn ai_http_stream(
    state: State<'_, HttpStreamManager>,
    request: StreamRequest,
    call_id: String,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    state
        .inflight
        .lock()
        .await
        .insert(call_id.clone(), cancel_tx);

    let result = run_stream(request, &on_event, cancel_rx).await;

    state.inflight.lock().await.remove(&call_id);
    match result {
        Ok(()) => {
            let _ = on_event.send(StreamEvent::Done);
        }
        Err(message) => {
            let _ = on_event.send(StreamEvent::Error { message });
        }
    }
    Ok(())
}

/// Cancel an in-flight [`ai_http_stream`] by its `call_id`. Idempotent.
#[tauri::command]
pub async fn ai_http_stream_cancel(
    state: State<'_, HttpStreamManager>,
    call_id: String,
) -> Result<(), String> {
    if let Some(tx) = state.inflight.lock().await.remove(&call_id) {
        let _ = tx.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_lines_splits_complete_lines_and_keeps_the_tail() {
        let mut buf = b"data: a\ndata: b\npartial".to_vec();
        assert_eq!(drain_lines(&mut buf), vec!["data: a", "data: b"]);
        assert_eq!(buf, b"partial".to_vec());
    }

    #[test]
    fn drain_lines_strips_crlf() {
        let mut buf = b"data: x\r\n\r\n".to_vec();
        assert_eq!(drain_lines(&mut buf), vec!["data: x", ""]);
        assert!(buf.is_empty());
    }

    #[test]
    fn drain_lines_handles_multibyte_split_across_chunks() {
        // "é" = 0xC3 0xA9: first chunk ends mid-character; no line completes.
        let mut buf = b"data: caf\xC3".to_vec();
        assert_eq!(drain_lines(&mut buf), Vec::<String>::new());
        buf.extend_from_slice(b"\xA9\n");
        assert_eq!(drain_lines(&mut buf), vec!["data: café"]);
    }

    #[test]
    fn drain_lines_empty_lines_survive_as_event_separators() {
        let mut buf = b"data: x\n\ndata: y\n\n".to_vec();
        assert_eq!(drain_lines(&mut buf), vec!["data: x", "", "data: y", ""]);
    }
}
