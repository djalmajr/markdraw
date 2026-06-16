//! MCP (Model Context Protocol) client manager.
//!
//! Connects the desktop app to any number of MCP servers over **stdio**
//! (spawned child process) or **Streamable HTTP**, using the official `rmcp`
//! crate. This lives in Rust on purpose: the webview cannot spawn processes,
//! and routing MCP over HTTP from the webview re-hits the SSE-delivery wall
//! that already forced `generateText` over `streamText`
//! (see `packages/ai/src/engines/ai-sdk.ts`). So the JS side discovers tools
//! via [`ai_mcp_list_tools`] and invokes them via [`ai_mcp_call_tool`],
//! wrapping each as an AI SDK tool for the model's tool-calling loop.
//!
//! Tools are listed once at connect time and cached, so `ai_mcp_list_tools`
//! is a cheap read. Secrets (auth headers) belong in the OS keychain like API
//! keys (see `ai_keychain.rs`), never in `ai.json`.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use http::{HeaderName, HeaderValue};
use rmcp::model::{CallToolRequestParams, CallToolResult, Content, TaskSupport};
use rmcp::service::{RoleClient, RunningService};
use rmcp::transport::auth::AuthClient;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::ServiceExt;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};

use crate::ai_mcp_oauth;

/// A live client handle. Both transports collapse to the same type after the
/// connection is established (`RunningService` is parameterized by role +
/// handler, not by transport), so stdio and HTTP servers share one map.
type McpClient = RunningService<RoleClient, ()>;

/// One connected server: its live client handle plus the tool list captured at
/// connect time (so listing tools later needs no network round-trip).
struct Connected {
    client: McpClient,
    tools: Vec<McpToolInfo>,
}

#[derive(Default)]
pub struct McpManager {
    servers: Mutex<HashMap<String, Connected>>,
    /// In-flight tool calls keyed by a caller-supplied call id, so the webview
    /// can cancel a long-running call (e.g. when the user stops the turn).
    inflight: Mutex<HashMap<String, oneshot::Sender<()>>>,
    /// Ids of OAuth-gated HTTP servers that couldn't connect for lack of stored
    /// tokens. Surfaced by [`ai_mcp_list_servers`] as `requiresAuth` so the UI can
    /// offer "Authorize"; cleared on a successful connect or on disconnect.
    needs_auth: Mutex<HashSet<String>>,
}

/// Outcome of a connection attempt: a live client, or a signal that the server is
/// OAuth-gated and needs the interactive [`ai_mcp_authorize`] flow first.
enum ConnectOutcome {
    Connected(McpClient),
    RequiresAuth,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    /// `"stdio"` | `"http"`.
    pub transport: String,
    // stdio transport
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub cwd: Option<String>,
    // http transport
    #[serde(default)]
    pub url: Option<String>,
    /// Custom headers sent on every HTTP request (e.g. an `Authorization`
    /// token for an authenticated MCP server). Loopback servers need none.
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Raw JSON Schema for the tool's input — passes straight into the AI SDK's
    /// `jsonSchema()` helper on the JS side (no zod/valibot conversion).
    pub input_schema: serde_json::Value,
    /// Optional JSON Schema for the tool's structured output, when the server
    /// declares one. Used to prefer `structuredContent` over text on results.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub id: String,
    pub connected: bool,
    pub tool_count: usize,
    /// An OAuth-gated HTTP server with no usable stored tokens: the UI shows an
    /// "Authorize" action that triggers [`ai_mcp_authorize`]. Always `false` for
    /// a connected server.
    pub requires_auth: bool,
}

/// Pure PATH × PATHEXT scan (first hit wins, directories outrank extensions —
/// the same order cmd.exe uses), split from the env/filesystem reads so it
/// unit-tests on every platform.
#[cfg(any(windows, test))]
fn find_in_path(
    program: &str,
    dirs: &[std::path::PathBuf],
    exts: &[String],
    is_file: &dyn Fn(&std::path::Path) -> bool,
) -> Option<std::path::PathBuf> {
    for dir in dirs {
        for ext in exts {
            let candidate = dir.join(format!("{program}{ext}"));
            if is_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// CreateProcess only auto-appends `.exe`, so a bare `npx`/`bunx` (Node/Bun CLI
/// shims are `.cmd` scripts on Windows) fails with "program not found" even
/// though it runs fine in any shell. Resolve bare names through PATH × PATHEXT
/// like the shell would; names with a path separator or an explicit extension
/// pass through untouched. Returning the full `…\npx.cmd` path is enough:
/// std::process routes `.bat`/`.cmd` through cmd.exe itself (with safe arg
/// escaping post-BatBadBut), and tokio's Command wraps std's.
#[cfg(windows)]
fn resolve_program(program: &str) -> String {
    if program.contains('/')
        || program.contains('\\')
        || std::path::Path::new(program).extension().is_some()
    {
        return program.to_string();
    }
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .filter(|e| !e.is_empty())
        .map(str::to_string)
        .collect();
    let dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    find_in_path(program, &dirs, &exts, &|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| program.to_string())
}

fn build_command(config: &McpServerConfig) -> Result<Command, String> {
    let program = config
        .command
        .clone()
        .ok_or_else(|| "stdio transport requires `command`".to_string())?;
    #[cfg(windows)]
    let program = resolve_program(&program);
    let mut cmd = Command::new(program);
    // Stdio servers are background children — without this every spawn flashes
    // a console window on Windows.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    if let Some(args) = &config.args {
        cmd.args(args);
    }
    if let Some(env) = &config.env {
        cmd.envs(env);
    }
    if let Some(cwd) = &config.cwd {
        cmd.current_dir(cwd);
    }
    Ok(cmd)
}

async fn connect_client(config: &McpServerConfig) -> Result<ConnectOutcome, String> {
    match config.transport.as_str() {
        "stdio" => {
            let cmd = build_command(config)?;
            let transport = TokioChildProcess::new(cmd).map_err(|e| e.to_string())?;
            let client = ().serve(transport).await.map_err(|e| e.to_string())?;
            Ok(ConnectOutcome::Connected(client))
        }
        "http" => {
            let url = config
                .url
                .clone()
                .ok_or_else(|| "http transport requires `url`".to_string())?;
            // Static custom headers (a server with a fixed Bearer/API token) take
            // the simple non-OAuth path: OAuth is attempted only when no headers
            // are supplied, so a statically-authed server is never disturbed.
            if let Some(headers) = config.headers.as_ref().filter(|h| !h.is_empty()) {
                let mut map: HashMap<HeaderName, HeaderValue> = HashMap::new();
                for (key, value) in headers {
                    let name = HeaderName::from_bytes(key.as_bytes())
                        .map_err(|e| format!("invalid MCP header name {key:?}: {e}"))?;
                    let val = HeaderValue::from_str(value)
                        .map_err(|e| format!("invalid MCP header value for {key:?}: {e}"))?;
                    map.insert(name, val);
                }
                let http_config =
                    StreamableHttpClientTransportConfig::with_uri(url).custom_headers(map);
                let transport = StreamableHttpClientTransport::from_config(http_config);
                let client = ().serve(transport).await.map_err(|e| e.to_string())?;
                return Ok(ConnectOutcome::Connected(client));
            }
            connect_http_oauth(&config.id, &url).await
        }
        other => Err(format!("unknown MCP transport: {other}")),
    }
}

/// Connect to an HTTP MCP server that may be OAuth-gated. With usable stored
/// tokens, wraps the client in an [`AuthClient`] that injects + refreshes the
/// bearer per request. Without tokens, tries a plain connection (the server may
/// be public); if that fails AND the server advertises OAuth metadata, reports
/// [`ConnectOutcome::RequiresAuth`] so the UI can offer "Authorize" — WITHOUT
/// opening a browser (only the explicit [`ai_mcp_authorize`] command does that).
async fn connect_http_oauth(server_id: &str, url: &str) -> Result<ConnectOutcome, String> {
    let mut manager = ai_mcp_oauth::manager_with_store(server_id, url).await?;
    let has_creds = manager
        .initialize_from_store()
        .await
        .map_err(|e| format!("load OAuth credentials: {e}"))?;
    let http_config = StreamableHttpClientTransportConfig::with_uri(url.to_string());

    let served = if has_creds {
        // `reqwest_oauth` is reqwest 0.13 (rmcp's pin) — see Cargo.toml. The
        // AuthClient injects the bearer + refreshes it per request.
        let auth_client = AuthClient::new(reqwest_oauth::Client::new(), manager);
        let transport = StreamableHttpClientTransport::with_client(auth_client, http_config);
        ().serve(transport).await
    } else {
        let transport = StreamableHttpClientTransport::from_config(http_config);
        ().serve(transport).await
    };

    match served {
        Ok(client) => Ok(ConnectOutcome::Connected(client)),
        // A real authorization failure (401/403/token rejected → "Auth required",
        // "Insufficient scope", AuthorizationRequired) is fixable by (re)authorizing.
        // So is ANY failure when we hold no token yet but the server advertises
        // OAuth (first-time auth). Everything else (5xx, network, protocol) is a
        // genuine error — surface it instead of pushing a pointless browser flow
        // that can't fix a server outage.
        Err(e) => {
            if is_auth_error(&e) || (!has_creds && ai_mcp_oauth::server_advertises_oauth(url).await)
            {
                Ok(ConnectOutcome::RequiresAuth)
            } else {
                Err(e.to_string())
            }
        }
    }
}

/// Whether a connect error is an authorization failure (vs a transient/protocol
/// error). rmcp's reqwest transport maps HTTP 401→"Auth required",
/// 403→"Insufficient scope", and an exhausted token→"Auth error: OAuth
/// authorization required"; thiserror interpolates the full source chain into the
/// top-level Display, so a substring scan is reliable and avoids a brittle
/// downcast through `DynamicTransportError` (whose concrete transport type
/// differs between the plain and AuthClient branches).
fn is_auth_error<E: std::error::Error>(err: &E) -> bool {
    let s = err.to_string().to_ascii_lowercase();
    s.contains("auth required")
        || s.contains("insufficient scope")
        || s.contains("authorization required")
        || s.contains("unauthorized")
}

/// Whether a tool can be surfaced to the model. Tools that *require* task-based
/// invocation can't be called via the plain `call_tool` path, so offering them
/// would only produce a guaranteed call-time failure — drop them at list time.
fn keep_tool(task_support: TaskSupport) -> bool {
    !matches!(task_support, TaskSupport::Required)
}

fn tool_infos(server: &str, tools: Vec<rmcp::model::Tool>) -> Vec<McpToolInfo> {
    tools
        .into_iter()
        .filter(|t| keep_tool(t.task_support()))
        .map(|t| McpToolInfo {
            server: server.to_string(),
            name: t.name.to_string(),
            description: t.description.map(|d| d.to_string()),
            input_schema: serde_json::Value::Object((*t.input_schema).clone()),
            output_schema: t
                .output_schema
                .as_ref()
                .map(|s| serde_json::Value::Object((**s).clone())),
        })
        .collect()
}

/// Parse a text block as JSON when it round-trips, else keep it as a string —
/// gives the model structured data instead of a stringified blob when possible.
fn parse_text_or_json(text: &str) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(text)
        .unwrap_or_else(|_| serde_json::Value::String(text.to_string()))
}

/// Collapse MCP result content into a model-friendly value: a lone text block
/// becomes a string (or parsed JSON); multiple text blocks join with newlines;
/// anything with non-text blocks (images/resources) keeps the raw envelope so
/// nothing is lost.
fn flatten_content(content: &[Content]) -> serde_json::Value {
    let texts: Vec<String> = content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.clone()))
        .collect();
    if texts.len() != content.len() {
        return serde_json::to_value(content).unwrap_or(serde_json::Value::Null);
    }
    match texts.as_slice() {
        [] => serde_json::Value::Null,
        [one] => parse_text_or_json(one),
        many => serde_json::Value::String(many.join("\n")),
    }
}

/// Turn an rmcp `CallToolResult` into the value handed to the model. Errors are
/// surfaced as `{ isError: true, error }` so the model (and the chat store's
/// `result.isError` check) can tell the call failed; successes are flattened,
/// preferring `structuredContent` when the tool declares an output schema.
fn normalize_call_result(result: CallToolResult, has_output_schema: bool) -> serde_json::Value {
    if result.is_error == Some(true) {
        // Prefer structured error detail; else flatten the content text.
        let detail = result
            .structured_content
            .or_else(|| match flatten_content(&result.content) {
                serde_json::Value::Null => None,
                other => Some(other),
            })
            .unwrap_or_else(|| serde_json::Value::String("MCP tool returned an error".to_string()));
        return serde_json::json!({ "isError": true, "error": detail });
    }
    if has_output_schema {
        if let Some(structured) = result.structured_content {
            return structured;
        }
    }
    let flattened = flatten_content(&result.content);
    if !flattened.is_null() {
        return flattened;
    }
    result
        .structured_content
        .unwrap_or_else(|| serde_json::Value::Object(Default::default()))
}

#[tauri::command]
pub async fn ai_mcp_connect(
    state: State<'_, McpManager>,
    config: McpServerConfig,
) -> Result<McpServerStatus, String> {
    let id = config.id.clone();
    // Drop any prior connection for this id before reconnecting.
    if let Some(prev) = state.servers.lock().await.remove(&id) {
        let _ = prev.client.cancel().await;
    }
    match connect_client(&config).await? {
        ConnectOutcome::Connected(client) => {
            let tools = client.list_all_tools().await.map_err(|e| e.to_string())?;
            let tools = tool_infos(&id, tools);
            let tool_count = tools.len();
            state.needs_auth.lock().await.remove(&id);
            state
                .servers
                .lock()
                .await
                .insert(id.clone(), Connected { client, tools });
            Ok(McpServerStatus {
                id,
                connected: true,
                tool_count,
                requires_auth: false,
            })
        }
        ConnectOutcome::RequiresAuth => {
            state.needs_auth.lock().await.insert(id.clone());
            Ok(McpServerStatus {
                id,
                connected: false,
                tool_count: 0,
                requires_auth: true,
            })
        }
    }
}

/// Run the interactive OAuth authorization flow for an OAuth-gated HTTP MCP
/// server (opens the browser, captures the loopback redirect, stores tokens),
/// then reconnect so its tools go live. Generic across any OAuth-gated server.
#[tauri::command]
pub async fn ai_mcp_authorize<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, McpManager>,
    config: McpServerConfig,
) -> Result<McpServerStatus, String> {
    let url = config
        .url
        .clone()
        .ok_or_else(|| "OAuth authorization requires an http `url`".to_string())?;
    ai_mcp_oauth::authorize(&app, &config.id, &url).await?;
    // Tokens are now in the keychain; a normal connect picks them up.
    ai_mcp_connect(state, config).await
}

#[tauri::command]
pub async fn ai_mcp_disconnect(state: State<'_, McpManager>, id: String) -> Result<(), String> {
    if let Some(conn) = state.servers.lock().await.remove(&id) {
        let _ = conn.client.cancel().await;
    }
    state.needs_auth.lock().await.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn ai_mcp_list_servers(
    state: State<'_, McpManager>,
) -> Result<Vec<McpServerStatus>, String> {
    // Snapshot pending-auth ids first (lock, clone, drop) so we never hold two
    // manager locks at once.
    let pending: Vec<String> = state.needs_auth.lock().await.iter().cloned().collect();
    let servers = state.servers.lock().await;
    let mut out: Vec<McpServerStatus> = servers
        .iter()
        .map(|(id, conn)| McpServerStatus {
            id: id.clone(),
            connected: true,
            tool_count: conn.tools.len(),
            requires_auth: false,
        })
        .collect();
    for id in pending {
        // A connected server is never also pending-auth, but guard anyway.
        if !servers.contains_key(&id) {
            out.push(McpServerStatus {
                id,
                connected: false,
                tool_count: 0,
                requires_auth: true,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn ai_mcp_list_tools(state: State<'_, McpManager>) -> Result<Vec<McpToolInfo>, String> {
    let servers = state.servers.lock().await;
    let mut out = Vec::new();
    for conn in servers.values() {
        out.extend(conn.tools.iter().cloned());
    }
    Ok(out)
}

/// Which of the three racing events won in [`run_with_cancel`].
enum CallOutcome<T> {
    Done(T),
    Cancelled,
    TimedOut,
}

/// A timeout future that is `Some(sleep)` or, for `None`, never resolves.
async fn sleep_opt(dur: Option<Duration>) {
    match dur {
        Some(d) => tokio::time::sleep(d).await,
        None => std::future::pending::<()>().await,
    }
}

/// Race a tool-call future against a cancel signal and an optional timeout.
/// Generic over the future so it is unit-testable without rmcp.
///
/// Cancellation/timeout is CLIENT-LOCAL: it stops awaiting and returns control,
/// but dropping the `call_tool` future does not abort server-side execution, so
/// a side-effecting tool may still complete on the server. (Server-side cancel
/// would need `peer.send_cancellable_request` + a CancelledNotification.)
async fn run_with_cancel<F: std::future::Future>(
    fut: F,
    cancel: oneshot::Receiver<()>,
    timeout: Option<Duration>,
) -> CallOutcome<F::Output> {
    tokio::select! {
        out = fut => CallOutcome::Done(out),
        _ = cancel => CallOutcome::Cancelled,
        _ = sleep_opt(timeout) => CallOutcome::TimedOut,
    }
}

#[tauri::command]
pub async fn ai_mcp_call_tool(
    state: State<'_, McpManager>,
    server: String,
    name: String,
    args: serde_json::Value,
    call_id: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    // Clone the cheap Peer handle out from under the lock so the network call
    // doesn't serialize against other manager operations. Capture whether the
    // tool declares an output schema while we hold the lock (cheap read).
    let (peer, has_output_schema) = {
        let servers = state.servers.lock().await;
        let conn = servers
            .get(&server)
            .ok_or_else(|| format!("MCP server not connected: {server}"))?;
        let has_output_schema = conn
            .tools
            .iter()
            .any(|t| t.name == name && t.output_schema.is_some());
        (conn.client.peer().clone(), has_output_schema)
    };

    let mut request = CallToolRequestParams::new(name.clone());
    if let Some(map) = args.as_object().cloned() {
        request = request.with_arguments(map);
    }

    // Register a cancel channel keyed by call_id so the webview can abort the
    // call; with no id, keep the sender alive locally so the receiver stays
    // pending (and the call simply can't be cancelled).
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let mut local_keep = None;
    match &call_id {
        Some(id) => {
            state.inflight.lock().await.insert(id.clone(), cancel_tx);
        }
        None => local_keep = Some(cancel_tx),
    }

    // `0` disables the timeout (long agentic sub-tasks); `None` -> default 60s.
    let timeout = match timeout_ms {
        Some(0) => None,
        Some(ms) => Some(Duration::from_millis(ms)),
        None => Some(Duration::from_secs(60)),
    };

    let outcome = run_with_cancel(peer.call_tool(request), cancel_rx, timeout).await;

    // Drop the inflight entry (no-op if a cancel already removed it).
    if let Some(id) = &call_id {
        state.inflight.lock().await.remove(id);
    }
    drop(local_keep);

    match outcome {
        CallOutcome::Done(Ok(result)) => Ok(normalize_call_result(result, has_output_schema)),
        CallOutcome::Done(Err(e)) => Err(e.to_string()),
        CallOutcome::Cancelled => Err(format!("MCP tool call cancelled: {server}/{name}")),
        CallOutcome::TimedOut => Err(format!("MCP tool call timed out: {server}/{name}")),
    }
}

/// Cancel an in-flight [`ai_mcp_call_tool`] by its `call_id`. Idempotent: a
/// no-op if the call already finished (the entry was removed).
#[tauri::command]
pub async fn ai_mcp_cancel_call(
    state: State<'_, McpManager>,
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
    use rmcp::model::CallToolResult;
    use serde_json::json;

    #[test]
    fn keep_tool_drops_only_task_required() {
        assert!(keep_tool(TaskSupport::Forbidden));
        assert!(keep_tool(TaskSupport::Optional));
        assert!(!keep_tool(TaskSupport::Required));
    }

    #[test]
    fn find_in_path_resolves_a_cmd_shim() {
        use std::path::{Path, PathBuf};
        let dirs = vec![PathBuf::from("C:/util"), PathBuf::from("C:/nodejs")];
        let exts = vec![".COM".to_string(), ".EXE".to_string(), ".CMD".to_string()];
        let exists = |p: &Path| p == Path::new("C:/nodejs/npx.CMD");
        assert_eq!(
            find_in_path("npx", &dirs, &exts, &exists),
            Some(PathBuf::from("C:/nodejs/npx.CMD")),
        );
    }

    #[test]
    fn find_in_path_earlier_dir_wins_over_earlier_ext() {
        use std::path::{Path, PathBuf};
        let dirs = vec![PathBuf::from("/a"), PathBuf::from("/b")];
        let exts = vec![".EXE".to_string(), ".CMD".to_string()];
        // /a has only the .CMD; /b has the .EXE. cmd.exe picks /a/tool.CMD —
        // directory order outranks extension order.
        let exists =
            |p: &Path| p == Path::new("/a/tool.CMD") || p == Path::new("/b/tool.EXE");
        assert_eq!(
            find_in_path("tool", &dirs, &exts, &exists),
            Some(PathBuf::from("/a/tool.CMD")),
        );
    }

    #[test]
    fn find_in_path_returns_none_when_absent() {
        use std::path::PathBuf;
        let dirs = vec![PathBuf::from("/a")];
        let exts = vec![".EXE".to_string()];
        assert_eq!(find_in_path("ghost", &dirs, &exts, &|_| false), None);
    }

    #[test]
    fn normalize_single_text_block_parses_json() {
        let result = CallToolResult::success(vec![Content::text("{\"a\":1}")]);
        assert_eq!(normalize_call_result(result, false), json!({ "a": 1 }));
    }

    #[test]
    fn normalize_single_plain_text_stays_a_string() {
        let result = CallToolResult::success(vec![Content::text("hello world")]);
        assert_eq!(normalize_call_result(result, false), json!("hello world"));
    }

    #[test]
    fn normalize_multiple_text_blocks_join_with_newlines() {
        let result = CallToolResult::success(vec![Content::text("a"), Content::text("b")]);
        assert_eq!(normalize_call_result(result, false), json!("a\nb"));
    }

    #[test]
    fn normalize_error_surfaces_is_error_and_message() {
        let result = CallToolResult::error(vec![Content::text("boom")]);
        assert_eq!(
            normalize_call_result(result, false),
            json!({ "isError": true, "error": "boom" }),
        );
    }

    #[test]
    fn normalize_error_without_content_has_default_message() {
        let result = CallToolResult::error(vec![]);
        assert_eq!(
            normalize_call_result(result, false),
            json!({ "isError": true, "error": "MCP tool returned an error" }),
        );
    }

    #[test]
    fn normalize_prefers_structured_content_when_output_schema_declared() {
        let result = CallToolResult::structured(json!({ "temp": 22 }));
        assert_eq!(normalize_call_result(result, true), json!({ "temp": 22 }));
    }

    #[test]
    fn normalize_error_prefers_structured_detail() {
        let result = CallToolResult::structured_error(json!({ "code": "E_OOPS", "msg": "bad" }));
        assert_eq!(
            normalize_call_result(result, false),
            json!({ "isError": true, "error": { "code": "E_OOPS", "msg": "bad" } }),
        );
    }

    #[tokio::test]
    async fn run_with_cancel_returns_done_when_future_completes() {
        let (_tx, rx) = oneshot::channel::<()>(); // sender kept alive -> never cancels
        let outcome = run_with_cancel(async { 42 }, rx, Some(Duration::from_secs(10))).await;
        assert!(matches!(outcome, CallOutcome::Done(42)));
    }

    #[tokio::test]
    async fn run_with_cancel_times_out_a_hanging_future() {
        let (_tx, rx) = oneshot::channel::<()>();
        let outcome = run_with_cancel(
            std::future::pending::<()>(),
            rx,
            Some(Duration::from_millis(10)),
        )
        .await;
        assert!(matches!(outcome, CallOutcome::TimedOut));
    }

    #[tokio::test]
    async fn run_with_cancel_cancels_when_signalled() {
        let (tx, rx) = oneshot::channel::<()>();
        tx.send(()).unwrap(); // signal before awaiting
        let outcome = run_with_cancel(std::future::pending::<()>(), rx, None).await;
        assert!(matches!(outcome, CallOutcome::Cancelled));
    }

    #[tokio::test]
    async fn run_with_cancel_no_timeout_waits_for_completion() {
        let (_tx, rx) = oneshot::channel::<()>();
        let outcome = run_with_cancel(async { "ok" }, rx, None).await;
        assert!(matches!(outcome, CallOutcome::Done("ok")));
    }
}
