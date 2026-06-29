//! Claude Code / Codex subscription chat via local CLI binaries (Rust spawn).
//!
//! The webview cannot spawn processes; MCP and streaming HTTP already live in
//! Rust for the same reason. These commands detect `claude`/`codex` on PATH,
//! probe that subscription auth works, and stream JSONL stdout lines to the
//! webview over an ipc [`Channel`] (same framing model as `ai_http.rs`).

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;

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

/// Merge the process PATH, the login-shell PATH, and well-known install dirs
/// into one ordered, de-duplicated search list (process PATH wins ties). Pure so
/// it can be tested without touching the environment or spawning a shell.
fn build_search_dirs(
    env_path: Option<OsString>,
    login_path: Option<OsString>,
    common: Vec<PathBuf>,
) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let mut add = |p: PathBuf| {
        if !p.as_os_str().is_empty() && seen.insert(p.clone()) {
            dirs.push(p);
        }
    };
    for source in [env_path, login_path].into_iter().flatten() {
        for p in std::env::split_paths(&source) {
            add(p);
        }
    }
    for p in common {
        add(p);
    }
    dirs
}

/// Run `shell -lc <script>` and return the trimmed stdout, bounding the WHOLE
/// operation (read-to-EOF + exit) by `timeout`. The shell runs in its own process
/// group; on timeout the entire group is SIGKILLed, so a login profile that
/// hangs, blocks on a prompt, or backgrounds a child that inherits stdout can't
/// wedge detection or leak descendants — reading stdout alone would otherwise
/// block forever on EOF while a backgrounded child holds the pipe open. Returns
/// None on spawn error, non-zero exit, empty output, or timeout.
#[cfg(not(windows))]
fn run_path_query(
    shell: &std::ffi::OsStr,
    script: &str,
    timeout: std::time::Duration,
) -> Option<OsString> {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::sync::mpsc;
    let mut child = std::process::Command::new(shell)
        .args(["-lc", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0) // own group so the timeout can kill the whole tree
        .spawn()
        .ok()?;
    let pgid = child.id() as libc::pid_t;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    // Bound BOTH stdout-to-EOF AND process exit by ONE deadline. A profile can
    // close/redirect stdout (instant EOF) yet keep running, or hold stdout open
    // while it hangs — neither the read nor the wait may block past the deadline.
    let deadline = std::time::Instant::now() + timeout;
    let mut output: Option<String> = None;
    let mut status: Option<std::process::ExitStatus> = None;
    loop {
        if output.is_none() {
            if let Ok(buf) = rx.try_recv() {
                output = Some(buf);
            }
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(s) => status = s,
                Err(_) => break,
            }
        }
        if output.is_some() && status.is_some() {
            break;
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    match (output, status) {
        (Some(buf), Some(s)) if s.success() => {
            let path = buf.trim().to_string();
            (!path.is_empty()).then(|| OsString::from(path))
        }
        _ => {
            // Timeout, spawn/wait error, or non-zero exit: SIGKILL the whole
            // process group (shell + foreground/backgrounded descendants), which
            // also closes stdout so the reader thread unblocks. Then reap.
            unsafe {
                libc::killpg(pgid, libc::SIGKILL);
            }
            let _ = child.wait();
            None
        }
    }
}

/// Sentinel prefixing the shell's PATH line, so a profile banner printed to
/// stdout before it can't corrupt the value we parse.
const PATH_MARKER: &str = "__MDPATH__";

/// Extract the PATH that follows the sentinel from a login shell's stdout,
/// ignoring anything printed before the marker (profile banners/warnings). Takes
/// the last marker occurrence and the rest of that line. Pure for testability.
fn parse_path_after_marker(output: &str) -> Option<String> {
    let after = output.rsplit_once(PATH_MARKER)?.1;
    let path = after.lines().next().unwrap_or("").trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// The PATH a user's login shell exports — it sources their profile (`~/.zprofile`
/// / `~/.profile`, where `brew shellenv` lives). GUI apps launched from Finder/
/// Dock on macOS only get the minimal launchd PATH (`/etc/paths`), which on Apple
/// Silicon omits `/opt/homebrew/bin`, so a Homebrew-installed CLI is invisible
/// without this. Bounded to 3s, child killed on timeout (see `run_path_query`).
/// Uses `printenv PATH` (the OS-separated value even on non-POSIX shells like
/// fish, unlike `echo "$PATH"`) behind a sentinel that survives a noisy profile.
#[cfg(not(windows))]
fn login_shell_path() -> Option<OsString> {
    let shell = std::env::var_os("SHELL")?;
    let script = format!("printf %s '{PATH_MARKER}'; printenv PATH");
    let raw = run_path_query(&shell, &script, std::time::Duration::from_secs(3))?;
    parse_path_after_marker(raw.to_str()?).map(OsString::from)
}

#[cfg(windows)]
fn login_shell_path() -> Option<OsString> {
    None
}

/// Well-known directories CLIs install into, searched as a last resort even when
/// neither the process nor the login-shell PATH lists them.
#[cfg(not(windows))]
fn common_cli_dirs_in(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = home {
        // Tool-manager shim dirs (stable, version-independent) first: asdf/mise
        // install CLIs like a Node-based `claude` under a shim here, and a
        // GUI-launched app's minimal PATH — and even a `-lc` login PATH, since
        // these are usually wired in the interactive rc — omits them. Then the
        // common per-user bins.
        for sub in [
            ".asdf/shims",
            ".local/share/mise/shims",
            ".bun/bin",
            ".cargo/bin",
            ".local/bin",
            ".deno/bin",
        ] {
            dirs.push(home.join(sub));
        }
    }
    dirs
}

#[cfg(not(windows))]
fn common_cli_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME");
    common_cli_dirs_in(home.as_deref().map(Path::new))
}

#[cfg(windows)]
fn common_cli_dirs() -> Vec<PathBuf> {
    Vec::new()
}

/// Directories to search for a CLI binary, computed once: the process PATH plus
/// the login-shell PATH and well-known dirs (so a Finder-launched app still finds
/// Homebrew/per-user installs — see `login_shell_path`).
fn cli_search_dirs() -> &'static [PathBuf] {
    static DIRS: OnceLock<Vec<PathBuf>> = OnceLock::new();
    DIRS.get_or_init(|| {
        build_search_dirs(
            std::env::var_os("PATH"),
            login_shell_path(),
            common_cli_dirs(),
        )
    })
}

/// The PATH to hand a spawned CLI: the resolved binary's OWN directory FIRST,
/// then the merged search dirs (process + login-shell + common). A resolved CLI
/// can be a shebang script — e.g. `claude` ships as `#!/usr/bin/env node` — and
/// its interpreter is most often installed alongside it (nvm/asdf/mise/homebrew
/// layouts) in a directory that may be on none of the search lists, especially
/// for an explicit user override. Without it, a GUI-launched or overridden CLI
/// would resolve but its child would inherit a PATH lacking the interpreter and
/// fail to launch. Falls back to the inherited PATH if the dirs can't be joined.
fn cli_path_env_for(binary: &str) -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(parent) = Path::new(binary).parent() {
        if !parent.as_os_str().is_empty() {
            dirs.push(parent.to_path_buf());
        }
    }
    dirs.extend(cli_search_dirs().iter().cloned());
    std::env::join_paths(dirs).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

/// Resolve a bare program name through the augmented search dirs (Windows: each
/// dir × PATHEXT). An absolute/relative path is checked as-is.
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
        for dir in cli_search_dirs() {
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
        for dir in cli_search_dirs() {
            let candidate = dir.join(program);
            if is_executable(&candidate) {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
        None
    }
}

/// Whether agy's plain-text stdout indicates an authenticated, successful reply.
/// `agy --print` exits 0 even when NOT signed in (it prints an OAuth URL / an
/// "authentication timed out" message instead of a reply), so success can't rely
/// on the exit code — only a non-empty reply lacking those markers counts.
fn antigravity_probe_ok(stdout: &str) -> bool {
    let s = stdout.trim();
    !s.is_empty()
        && !s.contains("Authentication required")
        && !s.contains("authentication timed out")
        && !s.contains("Please visit the URL")
}

fn binary_for_provider(provider: &str) -> Result<&'static str, String> {
    match provider {
        "claude-cli" => Ok("claude"),
        "codex-cli" => Ok("codex"),
        "grok-cli" => Ok("grok"),
        "antigravity-cli" => Ok("agy"),
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
        // The child inherits the (minimal, on GUI launch) process PATH otherwise;
        // give it the augmented PATH so a shebang CLI's interpreter resolves.
        .env("PATH", cli_path_env_for(binary))
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
            // `exec` refuses to run outside a trusted Git repo ("Not inside a
            // trusted directory and --skip-git-repo-check was not specified"),
            // and a GUI launch's cwd rarely is one — so the subscription probe
            // failed for every user not sitting in a trusted repo. We use Codex
            // purely as a chat backend (no repo edits), so opt out of the gate.
            cmd.args([
                "exec",
                "--skip-git-repo-check",
                "reply with exactly: ok",
                "--json",
            ]);
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
        "antigravity-cli" => {
            // agy --print emits plain text; --print-timeout bounds its own wait
            // (incl. the 30s auth wait when not logged in) so the probe resolves.
            cmd.args(["-p", "reply with exactly: ok", "--print-timeout", "20s"]);
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
        .stderr(Stdio::piped())
        // See build_probe_command: a resolved shebang CLI's interpreter may only
        // be on the augmented PATH, not the child's inherited (minimal) one.
        .env("PATH", cli_path_env_for(binary));
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    match request.provider.as_str() {
        "claude-cli" => {
            cmd.arg("-p").arg(&prompt);
            // `--print --output-format=stream-json` REQUIRES `--verbose` (Claude
            // CLI ≥ 2.x rejects the combo otherwise, exiting 1). The probe uses
            // plain `json`, which doesn't need it — so a Claude subscription
            // connects fine but every chat turn failed until this was added.
            cmd.args([
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--verbose",
            ]);
            cmd.arg("--model").arg(&request.model);
            if let Some(sys) = request.system.as_deref() {
                let trimmed = sys.trim();
                if !trimmed.is_empty() {
                    cmd.arg("--append-system-prompt").arg(trimmed);
                }
            }
        }
        "codex-cli" => {
            // See build_probe_command: opt out of the Git-repo trust gate so a
            // GUI launch (cwd not a trusted repo) doesn't abort every turn.
            cmd.arg("exec")
                .arg("--skip-git-repo-check")
                .arg(&prompt)
                .arg("--json");
            cmd.arg("-m").arg(&request.model);
        }
        "grok-cli" => {
            cmd.arg("-p").arg(&prompt);
            cmd.args(["--output-format", "streaming-json"]);
            cmd.arg("-m").arg(&request.model);
        }
        "antigravity-cli" => {
            // agy --print prints plain text. The model is the `agy models`
            // display string, passed verbatim via --model. No --print-timeout
            // here (unlike the probe): a chat turn is long-lived and bounded by
            // cancellation (cli_chat_cancel) / process exit, not a fixed deadline.
            cmd.arg("-p").arg(&prompt);
            if !request.model.trim().is_empty() {
                cmd.arg("--model").arg(&request.model);
            }
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
    let output = match tokio::time::timeout(std::time::Duration::from_secs(25), cmd.output()).await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Ok(CliProbeResult {
                ok: false,
                path: Some(path),
                error: Some(e.to_string()),
            });
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
                    && v.pointer("/item/type").and_then(|t| t.as_str()) == Some("agent_message")
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
        // agy --print emits plain text; see antigravity_probe_ok for why exit
        // code alone is unreliable.
        "antigravity-cli" => antigravity_probe_ok(&stdout),
        _ => false,
    };

    // Distinguish "no output at all" (crash / not installed) from "ran but the
    // subscription auth didn't take" so the Settings error is actionable.
    let error = if ok {
        None
    } else if stdout.trim().is_empty() {
        Some(
            "The CLI produced no output — make sure it's installed and signed in, then try again."
                .to_string(),
        )
    } else {
        Some("CLI ran but subscription auth did not succeed".to_string())
    };
    Ok(CliProbeResult {
        ok,
        path: Some(path),
        error,
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
    state
        .inflight
        .lock()
        .await
        .insert(call_id.clone(), cancel_tx);

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

    /// Build a platform-correct PATH string (`:`-joined on Unix, `;` on Windows)
    /// so these tests pass on every desktop target, not just Unix.
    fn join(parts: &[&str]) -> OsString {
        std::env::join_paths(parts.iter().map(PathBuf::from)).unwrap()
    }

    #[test]
    fn build_search_dirs_dedups_keeping_first() {
        let dirs = build_search_dirs(
            Some(join(&["/usr/bin", "/bin"])),
            Some(join(&["/opt/homebrew/bin", "/usr/bin"])),
            vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/custom")],
        );
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/usr/bin"),
                PathBuf::from("/bin"),
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/custom"),
            ]
        );
    }

    #[test]
    fn build_search_dirs_recovers_install_dir_under_minimal_path() {
        // A Finder-launched GUI app: minimal PATH, login shell unavailable, the
        // CLI lives in Homebrew. The common-dirs fallback must still surface it.
        let dirs = build_search_dirs(
            Some(join(&["/usr/bin", "/bin"])),
            None,
            vec![PathBuf::from("/opt/homebrew/bin")],
        );
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
    }

    #[test]
    fn build_search_dirs_skips_empty_entries() {
        let dirs = build_search_dirs(Some(join(&["/usr/bin", "", "/bin"])), None, vec![]);
        assert_eq!(dirs, vec![PathBuf::from("/usr/bin"), PathBuf::from("/bin")]);
    }

    #[cfg(not(windows))]
    #[test]
    fn common_dirs_cover_tool_manager_shims() {
        let dirs = common_cli_dirs_in(Some(std::path::Path::new("/home/u")));
        assert!(dirs.contains(&PathBuf::from("/home/u/.asdf/shims")));
        assert!(dirs.contains(&PathBuf::from("/home/u/.local/share/mise/shims")));
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
    }

    #[cfg(not(windows))]
    #[test]
    fn build_search_dirs_finds_asdf_shim_under_minimal_path() {
        // GUI launch: minimal PATH, no login-shell PATH — an asdf-installed CLI
        // (e.g. `claude`) must still be reachable via the common-dir shim list.
        let dirs = build_search_dirs(
            Some(join(&["/usr/bin", "/bin"])),
            None,
            common_cli_dirs_in(Some(std::path::Path::new("/home/u"))),
        );
        assert!(dirs.contains(&PathBuf::from("/home/u/.asdf/shims")));
    }

    #[cfg(not(windows))]
    #[test]
    fn run_path_query_returns_trimmed_stdout() {
        let out = run_path_query(
            std::ffi::OsStr::new("/bin/sh"),
            "echo \"/a:/b\"",
            std::time::Duration::from_secs(3),
        );
        assert_eq!(out, Some(OsString::from("/a:/b")));
    }

    #[cfg(not(windows))]
    #[test]
    fn run_path_query_none_on_empty_output() {
        let out = run_path_query(
            std::ffi::OsStr::new("/bin/sh"),
            "true",
            std::time::Duration::from_secs(3),
        );
        assert_eq!(out, None);
    }

    #[cfg(not(windows))]
    #[test]
    fn run_path_query_times_out_on_foreground_child() {
        let start = std::time::Instant::now();
        // No `exec`: the shell forks `sleep` as a child. Killing only the shell
        // would orphan it — the process-group kill must take the whole tree down.
        let out = run_path_query(
            std::ffi::OsStr::new("/bin/sh"),
            "sleep 30",
            std::time::Duration::from_millis(300),
        );
        assert_eq!(out, None);
        // Returns on the timeout, not after the 30s sleep.
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
    }

    #[cfg(not(windows))]
    #[test]
    fn run_path_query_times_out_when_background_child_holds_stdout() {
        let start = std::time::Instant::now();
        // The shell prints and exits, but a backgrounded child inherits stdout
        // and holds the pipe open — read-to-EOF alone would block forever. The
        // op-wide timeout + process-group kill must still return promptly.
        let out = run_path_query(
            std::ffi::OsStr::new("/bin/sh"),
            "echo hi; sleep 30 &",
            std::time::Duration::from_millis(300),
        );
        assert_eq!(out, None);
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
    }

    #[cfg(not(windows))]
    #[test]
    fn run_path_query_times_out_when_stdout_closes_but_process_runs() {
        let start = std::time::Instant::now();
        // The profile redirects stdout away (instant EOF) then keeps running —
        // the WAIT must be bounded too, not just the stdout read.
        let out = run_path_query(
            std::ffi::OsStr::new("/bin/sh"),
            "exec >/dev/null; sleep 30",
            std::time::Duration::from_millis(300),
        );
        assert_eq!(out, None);
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
    }

    #[cfg(not(windows))]
    #[test]
    fn spawned_cli_commands_carry_augmented_path() {
        let req = CliChatRequest {
            provider: "codex-cli".to_string(),
            model: "gpt-5.5".to_string(),
            system: None,
            messages: vec![CliMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
            }],
            path_override: None,
        };
        for cmd in [
            build_probe_command("codex-cli", "/usr/bin/codex").unwrap(),
            build_chat_command(&req, "/usr/bin/codex").unwrap(),
        ] {
            let path = cmd
                .as_std()
                .get_envs()
                .find(|(k, _)| *k == std::ffi::OsStr::new("PATH"))
                .and_then(|(_, v)| v)
                .map(|v| v.to_string_lossy().into_owned())
                .unwrap_or_default();
            // cli_path_env() always includes the common-dir fallback.
            assert!(
                path.contains("/opt/homebrew/bin"),
                "child PATH lacks augmented dirs: {path}"
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn augmented_path_lets_shebang_interpreter_resolve() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        // The real failure mode: a resolved CLI is a shebang script whose
        // interpreter is reachable ONLY via PATH (like `claude` = env node).
        let dir = std::env::temp_dir().join(format!("markdraw-clitest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let write_exec = |path: &std::path::Path, body: &str| {
            let mut f = std::fs::File::create(path).unwrap();
            f.write_all(body.as_bytes()).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let interp = dir.join("fakeinterp");
        write_exec(&interp, "#!/bin/sh\necho INTERP_OK\n");
        let cli = dir.join("fakecli");
        write_exec(&cli, "#!/usr/bin/env fakeinterp\n");
        // PATH points only at our dir: the shebang's `env fakeinterp` must resolve
        // through it for the CLI to launch at all.
        let out = std::process::Command::new(&cli)
            .env("PATH", &dir)
            .output()
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            out.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "INTERP_OK");
    }

    #[test]
    fn parse_path_after_marker_ignores_profile_banner() {
        assert_eq!(
            parse_path_after_marker(
                "Welcome to your shell!\n__MDPATH__/opt/homebrew/bin:/usr/bin\n"
            ),
            Some("/opt/homebrew/bin:/usr/bin".to_string())
        );
        // Banner with no trailing newline before the marker.
        assert_eq!(
            parse_path_after_marker("noise__MDPATH__/a:/b"),
            Some("/a:/b".to_string())
        );
    }

    #[test]
    fn parse_path_after_marker_none_without_marker_or_value() {
        assert_eq!(parse_path_after_marker("just some output"), None);
        assert_eq!(parse_path_after_marker("__MDPATH__"), None);
        assert_eq!(parse_path_after_marker("__MDPATH__   "), None);
    }

    #[cfg(not(windows))]
    #[test]
    fn cli_path_env_for_prepends_binary_parent_dir() {
        let path = cli_path_env_for("/custom/nvm/bin/claude");
        let path = path.to_string_lossy();
        // The binary's own dir leads so a co-located interpreter (env node) resolves.
        assert!(
            path.starts_with("/custom/nvm/bin"),
            "binary dir must lead: {path}"
        );
        // The merged search dirs still follow.
        assert!(
            path.contains("/opt/homebrew/bin"),
            "search dirs must follow: {path}"
        );
    }

    #[test]
    fn cli_path_env_for_bare_name_has_no_empty_lead() {
        // A bare program name has no parent dir to prepend — must not inject an
        // empty (cwd) PATH entry.
        let path = cli_path_env_for("codex");
        assert!(
            !path.to_string_lossy().starts_with(':'),
            "no empty lead entry: {path:?}"
        );
    }

    #[test]
    fn binary_for_provider_maps_kinds() {
        assert_eq!(binary_for_provider("claude-cli").unwrap(), "claude");
        assert_eq!(binary_for_provider("codex-cli").unwrap(), "codex");
        assert_eq!(binary_for_provider("grok-cli").unwrap(), "grok");
        assert_eq!(binary_for_provider("antigravity-cli").unwrap(), "agy");
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

    #[test]
    fn antigravity_probe_detects_auth_state() {
        // A real reply (authenticated) → ok.
        assert!(antigravity_probe_ok("ok"));
        assert!(antigravity_probe_ok("  Here is your answer.\n"));
        // No output (crash / not installed) → not ok.
        assert!(!antigravity_probe_ok(""));
        assert!(!antigravity_probe_ok("   \n  "));
        // Auth-required / timed-out markers → not ok (agy still exits 0).
        assert!(!antigravity_probe_ok(
            "Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/..."
        ));
        assert!(!antigravity_probe_ok("Error: authentication timed out."));
    }

    #[test]
    fn build_commands_cover_antigravity() {
        assert!(build_probe_command("antigravity-cli", "agy").is_ok());
        let req = CliChatRequest {
            provider: "antigravity-cli".to_string(),
            model: "Gemini 3.5 Flash (Medium)".to_string(),
            system: None,
            messages: vec![CliMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
            }],
            path_override: None,
        };
        assert!(build_chat_command(&req, "agy").is_ok());
    }
}
