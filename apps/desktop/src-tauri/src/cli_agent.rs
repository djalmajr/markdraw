//! Claude Code / Codex subscription chat via local CLI binaries (Rust spawn).
//!
//! The webview cannot spawn processes; MCP and streaming HTTP already live in
//! Rust for the same reason. These commands detect `claude`/`codex` on PATH,
//! probe that subscription auth works, and stream JSONL stdout lines to the
//! webview over an ipc [`Channel`] (same framing model as `ai_http.rs`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};

#[derive(Default)]
pub struct CliStreamManager {
    inflight: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliDetectRequest {
    pub binary: String,
    pub path_override: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliDetectResult {
    pub found: bool,
    pub path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliProbeRequest {
    /// `claude-cli` or `codex-cli` (matches provider `kind`).
    pub provider: String,
    pub path_override: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliProbeResult {
    pub ok: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
pub struct CliMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliChatRequest {
    /// `claude-cli` or `codex-cli`.
    pub provider: String,
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<CliMessage>,
    pub path_override: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CliStreamEvent {
    /// One complete JSONL line from the CLI stdout (without trailing `\n`).
    Line { line: String },
    /// Body finished cleanly.
    Done,
    /// Transport-level failure. Terminal.
    Error { message: String },
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Resolve a bare program name through PATH (Windows: PATH × PATHEXT).
fn resolve_binary(program: &str) -> Option<String> {
    if program.contains('/') || program.contains('\\') {
        let p = Path::new(program);
        return is_executable(p).then(|| program.to_string());
    }

    #[cfg(windows)]
    {
        let exts: Vec<String> = std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(str::to_string)
            .collect();
        let dirs: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        for dir in dirs {
            for ext in &exts {
                let candidate = dir.join(format!("{program}{ext}"));
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
        return None;
    }

    #[cfg(not(windows))]
    {
        let dirs: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        for dir in dirs {
            let candidate = dir.join(program);
            if is_executable(&candidate) {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
        None
    }
}

fn binary_for_provider(provider: &str) -> Result<&'static str, String> {
    match provider {
        "claude-cli" => Ok("claude"),
        "codex-cli" => Ok("codex"),
        "grok-cli" => Ok("grok"),
        other => Err(format!("unknown CLI provider kind: {other}")),
    }
}

fn resolve_cli_path(provider: &str, path_override: Option<String>) -> Result<String, String> {
    if let Some(path) = path_override {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err("path override is empty".to_string());
        }
        if !is_executable(Path::new(trimmed)) {
            return Err(format!("CLI not found at {trimmed}"));
        }
        return Ok(trimmed.to_string());
    }
    let name = binary_for_provider(provider)?;
    resolve_binary(name).ok_or_else(|| format!("{name} not found on PATH"))
}

fn format_prompt(messages: &[CliMessage], system: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(sys) = system {
        let trimmed = sys.trim();
        if !trimmed.is_empty() {
            parts.push(format!("System: {trimmed}"));
        }
    }
    for m in messages {
        if m.role == "system" {
            let trimmed = m.content.trim();
            if !trimmed.is_empty() {
                parts.push(format!("System: {trimmed}"));
            }
            continue;
        }
        let role = match m.role.as_str() {
            "assistant" => "Assistant",
            _ => "User",
        };
        parts.push(format!("{role}: {}", m.content));
    }
    parts.join("\n\n")
}

fn build_probe_command(provider: &str, binary: &str) -> Result<Command, String> {
    let mut cmd = Command::new(binary);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true); // reaped if the probe times out (see cli_probe_subscription)
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    match provider {
        "claude-cli" => {
            cmd.args([
                "-p",
                "reply with exactly: ok",
                "--output-format",
                "json",
                "--max-turns",
                "1",
            ]);
        }
        "codex-cli" => {
            cmd.args(["exec", "reply with exactly: ok", "--json"]);
        }
        "grok-cli" => {
            cmd.args([
                "-p",
                "reply with exactly: ok",
                "--output-format",
                "json",
                "--max-turns",
                "1",
            ]);
        }
        other => return Err(format!("unknown CLI provider kind: {other}")),
    }
    Ok(cmd)
}

fn build_chat_command(request: &CliChatRequest, binary: &str) -> Result<Command, String> {
    let prompt = format_prompt(&request.messages, request.system.as_deref());
    let mut cmd = Command::new(binary);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    match request.provider.as_str() {
        "claude-cli" => {
            cmd.arg("-p").arg(&prompt);
            cmd.args(["--output-format", "stream-json", "--include-partial-messages"]);
            cmd.arg("--model").arg(&request.model);
            if let Some(sys) = request.system.as_deref() {
                let trimmed = sys.trim();
                if !trimmed.is_empty() {
                    cmd.arg("--append-system-prompt").arg(trimmed);
                }
            }
        }
        "codex-cli" => {
            cmd.arg("exec").arg(&prompt).arg("--json");
            cmd.arg("-m").arg(&request.model);
        }
        "grok-cli" => {
            cmd.arg("-p").arg(&prompt);
            cmd.args(["--output-format", "streaming-json"]);
            cmd.arg("-m").arg(&request.model);
        }
        other => return Err(format!("unknown CLI provider kind: {other}")),
    }
    Ok(cmd)
}

async fn read_stdout_lines(
    mut child: Child,
    on_event: &Channel<CliStreamEvent>,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "CLI stdout not captured".to_string())?;
    let mut reader = BufReader::new(stdout).lines();

    loop {
        tokio::select! {
            line = reader.next_line() => match line {
                Ok(Some(line)) => {
                    let _ = on_event.send(CliStreamEvent::Line { line });
                }
                Ok(None) => break,
                Err(e) => return Err(e.to_string()),
            },
            _ = &mut cancel_rx => {
                let _ = child.kill().await;
                return Err("cancelled".to_string());
            }
        }
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("CLI exited with {status}"));
    }
    Ok(())
}

/// Locate a CLI binary (`claude` or `codex`) on PATH or at an optional override.
#[tauri::command]
pub async fn cli_detect_binary(request: CliDetectRequest) -> Result<CliDetectResult, String> {
    if let Some(path) = request.path_override {
        let trimmed = path.trim();
        let found = !trimmed.is_empty() && is_executable(Path::new(trimmed));
        return Ok(CliDetectResult {
            found,
            path: found.then(|| trimmed.to_string()),
        });
    }
    let path = resolve_binary(request.binary.trim());
    Ok(CliDetectResult {
        found: path.is_some(),
        path,
    })
}

/// Run a minimal prompt to verify subscription auth via the local CLI.
#[tauri::command]
pub async fn cli_probe_subscription(request: CliProbeRequest) -> Result<CliProbeResult, String> {
    let path = match resolve_cli_path(&request.provider, request.path_override) {
        Ok(p) => p,
        Err(e) => {
            return Ok(CliProbeResult {
                ok: false,
                path: None,
                error: Some(e),
            });
        }
    };

    let mut cmd = build_probe_command(&request.provider, &path)?;
    // Bound the probe: the CLI runs a real (tiny) model turn, and an
    // unauthenticated / hung binary must not leave the Settings "Continue"
    // button (and refreshConnectedProviders) stuck forever. kill_on_drop reaps
    // the child when this future is dropped on timeout.
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(25),
        cmd.output(),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Ok(CliProbeResult { ok: false, path: Some(path), error: Some(e.to_string()) });
        }
        Err(_) => {
            return Ok(CliProbeResult {
                ok: false,
                path: Some(path),
                error: Some(
                    "CLI probe timed out — make sure the CLI is installed and signed in, then try again."
                        .to_string(),
                ),
            });
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = if stderr.trim().is_empty() {
            format!("CLI probe failed ({})", output.status)
        } else {
            stderr.trim().to_string()
        };
        return Ok(CliProbeResult {
            ok: false,
            path: Some(path),
            error: Some(msg),
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let ok = match request.provider.as_str() {
        "claude-cli" => stdout
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .any(|v| {
                v.get("type").and_then(|t| t.as_str()) == Some("result")
                    && v.get("subtype").and_then(|s| s.as_str()) == Some("success")
                    && v.get("is_error").and_then(|b| b.as_bool()) == Some(false)
            }),
        "codex-cli" => stdout
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .any(|v| {
                v.get("type").and_then(|t| t.as_str()) == Some("item.completed")
                    && v.pointer("/item/type")
                        .and_then(|t| t.as_str())
                        == Some("agent_message")
            }),
        // Grok `--output-format json` prints a single object: a success carries
        // `text`/`stopReason`; a failure is `{"type":"error",...}`. Parse the
        // whole stdout (json may be pretty-printed) and any NDJSON lines.
        "grok-cli" => {
            let mut values: Vec<serde_json::Value> = Vec::new();
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
                values.push(v);
            }
            for line in stdout.lines() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                    values.push(v);
                }
            }
            values.iter().any(|v| {
                v.get("type").and_then(|t| t.as_str()) != Some("error")
                    && (v.get("text").is_some() || v.get("stopReason").is_some())
            })
        }
        _ => false,
    };

    Ok(CliProbeResult {
        ok,
        path: Some(path),
        error: if ok {
            None
        } else {
            Some("CLI ran but subscription auth did not succeed".to_string())
        },
    })
}

/// Stream a chat turn over the local CLI. Always resolves `Ok` — outcome on channel.
#[tauri::command]
pub async fn cli_chat_stream(
    state: State<'_, CliStreamManager>,
    request: CliChatRequest,
    call_id: String,
    on_event: Channel<CliStreamEvent>,
) -> Result<(), String> {
    let path = resolve_cli_path(&request.provider, request.path_override.clone())?;
    let mut cmd = build_chat_command(&request, &path)?;
    let child = cmd.spawn().map_err(|e| e.to_string())?;

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    state.inflight.lock().await.insert(call_id.clone(), cancel_tx);

    let result = read_stdout_lines(child, &on_event, cancel_rx).await;
    state.inflight.lock().await.remove(&call_id);

    match result {
        Ok(()) => {
            let _ = on_event.send(CliStreamEvent::Done);
        }
        Err(message) => {
            let _ = on_event.send(CliStreamEvent::Error { message });
        }
    }
    Ok(())
}

/// Cancel an in-flight [`cli_chat_stream`] by its `call_id`. Idempotent.
#[tauri::command]
pub async fn cli_chat_cancel(
    state: State<'_, CliStreamManager>,
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
    fn format_prompt_merges_system_and_turns() {
        let messages = vec![
            CliMessage {
                role: "user".to_string(),
                content: "Hi".to_string(),
            },
            CliMessage {
                role: "assistant".to_string(),
                content: "Hello".to_string(),
            },
            CliMessage {
                role: "user".to_string(),
                content: "Bye".to_string(),
            },
        ];
        let out = format_prompt(&messages, Some("Be brief"));
        assert!(out.contains("System: Be brief"));
        assert!(out.contains("User: Hi"));
        assert!(out.contains("Assistant: Hello"));
        assert!(out.contains("User: Bye"));
    }

    #[test]
    fn binary_for_provider_maps_kinds() {
        assert_eq!(binary_for_provider("claude-cli").unwrap(), "claude");
        assert_eq!(binary_for_provider("codex-cli").unwrap(), "codex");
        assert_eq!(binary_for_provider("grok-cli").unwrap(), "grok");
        assert!(binary_for_provider("anthropic").is_err());
    }

    #[test]
    fn build_commands_cover_grok() {
        // The probe/chat builders must accept the grok-cli kind without erroring.
        assert!(build_probe_command("grok-cli", "grok").is_ok());
        let req = CliChatRequest {
            provider: "grok-cli".to_string(),
            model: "grok-composer-2.5-fast".to_string(),
            system: None,
            messages: vec![CliMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
            }],
            path_override: None,
        };
        assert!(build_chat_command(&req, "grok").is_ok());
    }
}