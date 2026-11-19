//! Sources of provider model lists that the webview cannot reach on its own.
//!
//! Three Tauri commands, all deliberately narrow — none of them accepts a
//! command, a file path or a free-form scheme from the webview:
//!
//! * [`ai_http_get_json`] — a bounded `GET` for any `http(s)` base URL (the
//!   `tauri-plugin-http` allowlist does not cover xAI, Gemini, LM Studio or
//!   custom providers).
//! * [`cli_list_models`] — runs `<cli> models` for exactly two known provider
//!   ids and returns the (size-bounded) stdout.
//! * [`codex_models_cache`] — reads `~/.codex/models_cache.json` only and
//!   returns just the model fields.
//!
//! This module transports raw or minimal data; parsing each list format is the
//! frontend's job.
//!
//! Secret hygiene: every error is a [`ModelListError`] whose `code` and
//! `message` are fixed strings. Nothing derived from a header value, a URL,
//! a response body, a stderr stream or an upstream error `Display` is ever put
//! in an error (reqwest errors embed the full URL, which may carry `?key=`).
//! The CLI's stderr is never captured at all.

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::cli_agent::{binary_for_provider, cli_path_env_for, resolve_cli_path};

/// Largest response body [`ai_http_get_json`] will buffer.
const HTTP_MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const HTTP_DEFAULT_TIMEOUT_MS: u64 = 15_000;
const HTTP_MAX_TIMEOUT_MS: u64 = 60_000;
const HTTP_MAX_REDIRECTS: usize = 3;
const HTTP_MAX_HEADERS: usize = 32;
const HTTP_MAX_HEADER_BYTES: usize = 8 * 1024;
const HTTP_MAX_URL_BYTES: usize = 8 * 1024;

const CLI_MAX_STDOUT_BYTES: usize = 256 * 1024;
const CLI_TIMEOUT: Duration = Duration::from_secs(25);

const CODEX_MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const CODEX_MAX_MODELS: usize = 2_000;
const CODEX_MAX_FIELD_CHARS: usize = 256;

/// Typed, secret-free failure. Both fields are fixed strings by construction
/// (`&'static str`), so no runtime value can leak through them.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct ModelListError {
    pub code: &'static str,
    pub message: &'static str,
}

const fn err(code: &'static str, message: &'static str) -> ModelListError {
    ModelListError { code, message }
}

// ── HTTP GET JSON ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetJsonRequest {
    pub url: String,
    #[serde(default)]
    pub headers: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize, Debug)]
pub struct GetJsonResponse {
    pub status: u16,
    pub body: String,
}

/// Request headers the webview may not set: they would let a caller redirect
/// the request to another virtual host or break message framing.
fn header_is_forbidden(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host" | "content-length" | "transfer-encoding" | "connection" | "upgrade" | "te"
    )
}

fn ip_is_link_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_link_local() || v4.is_unspecified(),
        IpAddr::V6(v6) => {
            let seg0 = v6.segments()[0];
            v6.is_unspecified() || (seg0 & 0xffc0) == 0xfe80
        }
    }
}

/// Validate the URL the webview asked for. `http`/`https` only, no embedded
/// credentials, and no link-local/unspecified IP *literal* (the cloud metadata
/// address). Loopback and private ranges stay allowed: LM Studio and Ollama
/// live on `localhost`. A hostname that RESOLVES to a link-local address is not
/// caught here (no resolve-time check).
fn validate_url(raw: &str) -> Result<reqwest::Url, ModelListError> {
    if raw.len() > HTTP_MAX_URL_BYTES {
        return Err(err("invalid_url", "The URL is too long."));
    }
    let url = reqwest::Url::parse(raw).map_err(|_| err("invalid_url", "The URL is not valid."))?;
    match url.scheme() {
        "http" | "https" => {}
        _ => {
            return Err(err(
                "unsupported_scheme",
                "Only http and https URLs are allowed.",
            ))
        }
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(err(
            "invalid_url",
            "URLs with embedded credentials are not allowed.",
        ));
    }
    let Some(host) = url.host_str() else {
        return Err(err("invalid_url", "The URL has no host."));
    };
    // `host_str` keeps the brackets of an IPv6 literal.
    let literal = host.trim_start_matches('[').trim_end_matches(']');
    if literal.parse::<IpAddr>().is_ok_and(ip_is_link_local) {
        return Err(err("blocked_host", "This host is not allowed."));
    }
    Ok(url)
}

fn build_headers(
    headers: Option<&std::collections::HashMap<String, String>>,
) -> Result<reqwest::header::HeaderMap, ModelListError> {
    let mut map = reqwest::header::HeaderMap::new();
    let Some(headers) = headers else {
        return Ok(map);
    };
    if headers.len() > HTTP_MAX_HEADERS {
        return Err(err("invalid_header", "Too many request headers."));
    }
    let mut total = 0usize;
    for (name, value) in headers {
        total += name.len() + value.len();
        if total > HTTP_MAX_HEADER_BYTES {
            return Err(err("invalid_header", "The request headers are too large."));
        }
        if header_is_forbidden(name) {
            return Err(err("invalid_header", "A request header is not allowed."));
        }
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| err("invalid_header", "A request header name is not valid."))?;
        let mut value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|_| err("invalid_header", "A request header value is not valid."))?;
        value.set_sensitive(true);
        map.insert(name, value);
    }
    Ok(map)
}

/// Same origin as the original request (scheme, host, port) — the only
/// redirect we follow, so credentials never travel to another host.
fn same_origin(a: &reqwest::Url, b: &reqwest::Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

fn map_reqwest_error(e: &reqwest::Error) -> ModelListError {
    // Never `e.to_string()`: reqwest embeds the URL (and so any `?key=`).
    if e.is_timeout() {
        err("timeout", "The request timed out.")
    } else if e.is_connect() {
        err("connect_failed", "Could not connect to the server.")
    } else if e.is_redirect() {
        err("redirect_blocked", "The server redirected the request.")
    } else {
        err("request_failed", "The request failed.")
    }
}

/// Core of [`ai_http_get_json`], with the limits as parameters so the tests can
/// shrink them.
async fn get_json(
    request: GetJsonRequest,
    max_body: usize,
    default_timeout_ms: u64,
) -> Result<GetJsonResponse, ModelListError> {
    let url = validate_url(&request.url)?;
    let mut headers = build_headers(request.headers.as_ref())?;
    headers
        .entry(reqwest::header::ACCEPT)
        .or_insert(reqwest::header::HeaderValue::from_static(
            "application/json",
        ));
    let timeout_ms = request
        .timeout_ms
        .unwrap_or(default_timeout_ms)
        .clamp(1, HTTP_MAX_TIMEOUT_MS);

    let origin = url.clone();
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= HTTP_MAX_REDIRECTS || !same_origin(attempt.url(), &origin) {
            // `stop` hands back the 3xx response, which we map to an error.
            attempt.stop()
        } else {
            attempt.follow()
        }
    });
    let client = reqwest::Client::builder()
        .redirect(policy)
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|_| err("request_failed", "The request failed."))?;

    let response = client
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| map_reqwest_error(&e))?;

    let status = response.status();
    if status.is_redirection() {
        return Err(err(
            "redirect_blocked",
            "The server redirected the request.",
        ));
    }
    if response
        .content_length()
        .is_some_and(|len| len > max_body as u64)
    {
        return Err(err("too_large", "The response is too large."));
    }

    let mut stream = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| map_reqwest_error(&e))?;
        if buf.len() + bytes.len() > max_body {
            return Err(err("too_large", "The response is too large."));
        }
        buf.extend_from_slice(&bytes);
    }
    Ok(GetJsonResponse {
        status: status.as_u16(),
        body: String::from_utf8_lossy(&buf).into_owned(),
    })
}

/// Bounded `GET` of a JSON document at `request.url` (models list endpoints).
/// Redirects to another origin, non-http(s) schemes, oversized or slow
/// responses are refused with a typed error; headers and bodies are never
/// logged.
#[tauri::command]
pub async fn ai_http_get_json(request: GetJsonRequest) -> Result<GetJsonResponse, ModelListError> {
    get_json(request, HTTP_MAX_BODY_BYTES, HTTP_DEFAULT_TIMEOUT_MS).await
}

// ── CLI `models` ────────────────────────────────────────────────────────────

/// Map the Markdraw provider id the webview sends to the CLI provider kind that
/// `cli_agent` resolves binaries by. Anything else is refused — the webview
/// cannot name a binary or an argument.
fn cli_kind_for_provider_id(provider: &str) -> Result<&'static str, ModelListError> {
    match provider {
        "grok-sub" => Ok("grok-cli"),
        "antigravity-sub" => Ok("antigravity-cli"),
        _ => Err(err("unknown_provider", "Unknown CLI provider.")),
    }
}

/// Run `<binary> models` (no shell, fixed argv, stdin closed, stderr
/// discarded) and return its stdout, bounded in time and size.
async fn run_models_command(
    binary: &str,
    max_stdout: usize,
    timeout: Duration,
) -> Result<String, ModelListError> {
    let mut cmd = Command::new(binary);
    cmd.arg("models")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // stderr can carry tokens; never capture it.
        .stderr(Stdio::null())
        .env("PATH", cli_path_env_for(binary))
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|_| err("cli_spawn_failed", "Could not start the CLI."))?;
    let Some(stdout) = child.stdout.take() else {
        return Err(err("cli_spawn_failed", "Could not start the CLI."));
    };

    let work = async {
        let mut buf: Vec<u8> = Vec::new();
        // +1 so "exactly at the limit" and "over it" are distinguishable.
        let mut limited = stdout.take(max_stdout as u64 + 1);
        limited
            .read_to_end(&mut buf)
            .await
            .map_err(|_| err("cli_failed", "The CLI failed."))?;
        if buf.len() > max_stdout {
            // Dropping `child` (kill_on_drop) reaps a CLI still writing.
            return Err(err("too_large", "The CLI output is too large."));
        }
        let status = child
            .wait()
            .await
            .map_err(|_| err("cli_failed", "The CLI failed."))?;
        if !status.success() {
            return Err(err("cli_failed", "The CLI exited with an error."));
        }
        Ok(String::from_utf8_lossy(&buf).into_owned())
    };
    match tokio::time::timeout(timeout, work).await {
        Ok(result) => result,
        Err(_) => Err(err("timeout", "The CLI timed out.")),
    }
}

/// List the models a subscription CLI reports (`grok models` / `agy models`).
/// `provider` must be `grok-sub` or `antigravity-sub`.
#[tauri::command]
pub async fn cli_list_models(provider: String) -> Result<String, ModelListError> {
    let kind = cli_kind_for_provider_id(&provider)?;
    debug_assert!(binary_for_provider(kind).is_ok());
    let binary = resolve_cli_path(kind, None)
        .map_err(|_| err("cli_not_found", "The CLI was not found on PATH."))?;
    run_models_command(&binary, CLI_MAX_STDOUT_BYTES, CLI_TIMEOUT).await
}

// ── Codex models cache ──────────────────────────────────────────────────────

/// The model fields of one `models_cache.json` entry — nothing else is
/// forwarded.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    pub slug: String,
    pub display_name: Option<String>,
    pub context_window: Option<u64>,
    pub visibility: Option<String>,
    pub default_reasoning_level: Option<String>,
    pub reasoning_efforts: Vec<String>,
}

fn malformed() -> ModelListError {
    err("malformed", "The Codex model cache is not valid.")
}

fn short_string(v: &serde_json::Value) -> Result<String, ModelListError> {
    let s = v.as_str().ok_or_else(malformed)?;
    if s.chars().count() > CODEX_MAX_FIELD_CHARS {
        return Err(malformed());
    }
    Ok(s.to_string())
}

fn optional_string(
    obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Option<String>, ModelListError> {
    match obj.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => short_string(v).map(Some),
    }
}

/// Extract the model fields from the cache file's text. The whole document is
/// rejected on any structural problem (no partial results).
fn parse_codex_models(text: &str) -> Result<Vec<CodexModel>, ModelListError> {
    let root: serde_json::Value = serde_json::from_str(text).map_err(|_| malformed())?;
    let models = root
        .get("models")
        .and_then(|m| m.as_array())
        .ok_or_else(malformed)?;
    if models.len() > CODEX_MAX_MODELS {
        return Err(malformed());
    }
    let mut out = Vec::with_capacity(models.len());
    for entry in models {
        let obj = entry.as_object().ok_or_else(malformed)?;
        let slug = short_string(obj.get("slug").ok_or_else(malformed)?)?;
        if slug.is_empty() {
            return Err(malformed());
        }
        let context_window = match obj.get("context_window") {
            None | Some(serde_json::Value::Null) => None,
            Some(v) => Some(v.as_u64().ok_or_else(malformed)?),
        };
        let reasoning_efforts = match obj.get("supported_reasoning_levels") {
            None | Some(serde_json::Value::Null) => Vec::new(),
            Some(v) => {
                let levels = v.as_array().ok_or_else(malformed)?;
                if levels.len() > 32 {
                    return Err(malformed());
                }
                let mut efforts = Vec::with_capacity(levels.len());
                for level in levels {
                    let effort = level.get("effort").ok_or_else(malformed)?;
                    efforts.push(short_string(effort)?);
                }
                efforts
            }
        };
        out.push(CodexModel {
            slug,
            display_name: optional_string(obj, "display_name")?,
            context_window,
            visibility: optional_string(obj, "visibility")?,
            default_reasoning_level: optional_string(obj, "default_reasoning_level")?,
            reasoning_efforts,
        });
    }
    Ok(out)
}

/// Read at most `limit` bytes of UTF-8 text from `reader`; one byte more is
/// `too_large`. Pure over `Read` so an endless or growing source is testable.
fn read_text_bounded<R: std::io::Read>(reader: R, limit: u64) -> Result<String, ModelListError> {
    use std::io::Read;
    let mut text = String::new();
    reader
        .take(limit + 1)
        .read_to_string(&mut text)
        .map_err(|_| err("read_failed", "Could not read the Codex model cache."))?;
    if text.len() as u64 > limit {
        return Err(err("too_large", "The Codex model cache is too large."));
    }
    Ok(text)
}

/// Read `<home>/.codex/models_cache.json` — that exact path, nothing else under
/// `~/.codex` — and return the model fields.
fn read_codex_models(home: &Path) -> Result<Vec<CodexModel>, ModelListError> {
    let path: PathBuf = home.join(".codex").join("models_cache.json");
    let file = std::fs::File::open(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            err("not_found", "The Codex model cache does not exist.")
        } else {
            err("read_failed", "Could not read the Codex model cache.")
        }
    })?;
    let meta = file
        .metadata()
        .map_err(|_| err("read_failed", "Could not read the Codex model cache."))?;
    if !meta.is_file() {
        return Err(err("read_failed", "Could not read the Codex model cache."));
    }
    if meta.len() > CODEX_MAX_FILE_BYTES {
        return Err(err("too_large", "The Codex model cache is too large."));
    }
    // The bound also holds if the file grows after the size check above.
    let text = read_text_bounded(file, CODEX_MAX_FILE_BYTES)?;
    parse_codex_models(&text)
}

/// The Codex CLI's own model list (`~/.codex/models_cache.json`), reduced to
/// the model fields. Never reads `auth.json` or any other file.
#[tauri::command]
pub async fn codex_models_cache<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<CodexModel>, ModelListError> {
    let home = app
        .path()
        .home_dir()
        .map_err(|_| err("no_home", "Could not resolve the home directory."))?;
    tokio::task::spawn_blocking(move || read_codex_models(&home))
        .await
        .map_err(|_| err("read_failed", "Could not read the Codex model cache."))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::Read;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const MARKER: &str = "SECRET-MARKER-9f3a1c";

    /// A one-connection-at-a-time raw HTTP server. `handler` gets the raw
    /// request text and returns the full raw response bytes; the returned
    /// counter is how many requests it served.
    async fn serve<F>(handler: F) -> (u16, Arc<AtomicUsize>)
    where
        F: Fn(String) -> Vec<u8> + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let handler = handler.clone();
                let counter = counter.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    counter.fetch_add(1, Ordering::SeqCst);
                    let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let resp = handler(req);
                    let _ = sock.write_all(&resp).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (port, hits)
    }

    fn ok_json(body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .into_bytes()
    }

    fn req(url: &str) -> GetJsonRequest {
        GetJsonRequest {
            url: url.to_string(),
            headers: None,
            timeout_ms: None,
        }
    }

    async fn get(r: GetJsonRequest) -> Result<GetJsonResponse, ModelListError> {
        get_json(r, HTTP_MAX_BODY_BYTES, 5_000).await
    }

    // ── HTTP ──

    #[tokio::test]
    async fn get_json_returns_status_and_body_and_sends_headers() {
        let (port, _) = serve(|raw| {
            let lower = raw.to_ascii_lowercase();
            assert!(lower.starts_with("get /v1/models "));
            assert!(lower.contains("x-api-key: k-123"));
            assert!(lower.contains("accept: application/json"));
            ok_json(r#"{"data":[{"id":"m1"}]}"#)
        })
        .await;
        let mut r = req(&format!("http://127.0.0.1:{port}/v1/models"));
        r.headers = Some(HashMap::from([("x-api-key".into(), "k-123".into())]));
        let resp = get(r).await.unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, r#"{"data":[{"id":"m1"}]}"#);
    }

    #[tokio::test]
    async fn get_json_passes_non_2xx_status_through() {
        let (port, _) = serve(|_| {
            b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
                .to_vec()
        })
        .await;
        let resp = get(req(&format!("http://127.0.0.1:{port}/m")))
            .await
            .unwrap();
        assert_eq!(resp.status, 401);
    }

    #[tokio::test]
    async fn get_json_rejects_non_http_schemes_without_connecting() {
        for url in [
            "file:///etc/passwd",
            "ftp://127.0.0.1/models",
            "javascript:alert(1)",
            "data:application/json,{}",
            "ws://127.0.0.1:1/x",
        ] {
            let e = get(req(url)).await.unwrap_err();
            assert!(
                e.code == "unsupported_scheme" || e.code == "invalid_url",
                "{url} -> {e:?}"
            );
        }
        assert_eq!(
            get(req("file:///etc/passwd")).await.unwrap_err().code,
            "unsupported_scheme"
        );
    }

    #[tokio::test]
    async fn get_json_rejects_malformed_urls_credentials_and_metadata_ip() {
        assert_eq!(get(req("not a url")).await.unwrap_err().code, "invalid_url");
        assert_eq!(get(req("")).await.unwrap_err().code, "invalid_url");
        assert_eq!(
            get(req("http://user:pw@127.0.0.1:1/x"))
                .await
                .unwrap_err()
                .code,
            "invalid_url"
        );
        assert_eq!(
            get(req("http://169.254.169.254/latest/meta-data"))
                .await
                .unwrap_err()
                .code,
            "blocked_host"
        );
        assert_eq!(
            get(req("http://[fe80::1]/x")).await.unwrap_err().code,
            "blocked_host"
        );
        let long = format!("http://127.0.0.1:1/{}", "a".repeat(HTTP_MAX_URL_BYTES));
        assert_eq!(get(req(&long)).await.unwrap_err().code, "invalid_url");
    }

    #[tokio::test]
    async fn get_json_allows_loopback_for_local_servers() {
        // LM Studio / Ollama live on localhost, so loopback must stay reachable.
        let (port, _) = serve(|_| ok_json("{}")).await;
        assert!(get(req(&format!("http://127.0.0.1:{port}/m")))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn get_json_refuses_redirect_to_another_host_and_never_contacts_it() {
        let (target_port, target_hits) = serve(|_| ok_json("{}")).await;
        // Same server, different host name: 127.0.0.1 redirects to `localhost`.
        let location = format!("http://localhost:{target_port}/steal");
        let (port, _) = serve(move |_| {
            format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .into_bytes()
        })
        .await;
        let mut r = req(&format!("http://127.0.0.1:{port}/m"));
        r.headers = Some(HashMap::from([(
            "authorization".into(),
            format!("Bearer {MARKER}"),
        )]));
        let e = get(r).await.unwrap_err();
        assert_eq!(e.code, "redirect_blocked");
        assert_eq!(
            target_hits.load(Ordering::SeqCst),
            0,
            "other host was contacted"
        );
        assert!(!format!("{e:?}").contains(MARKER));
    }

    #[tokio::test]
    async fn get_json_refuses_redirect_to_another_port_and_scheme_change() {
        let (other_port, other_hits) = serve(|_| ok_json("{}")).await;
        let location = format!("http://127.0.0.1:{other_port}/x");
        let (port, _) = serve(move |_| {
            format!("HTTP/1.1 301 Moved\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .into_bytes()
        })
        .await;
        let e = get(req(&format!("http://127.0.0.1:{port}/m")))
            .await
            .unwrap_err();
        assert_eq!(e.code, "redirect_blocked");
        assert_eq!(other_hits.load(Ordering::SeqCst), 0);
        // https downgrade/upgrade on the same host is a different origin too.
        let (port2, _) = serve(move |_| {
            b"HTTP/1.1 301 Moved\r\nLocation: https://127.0.0.1:1/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
        })
        .await;
        let e = get(req(&format!("http://127.0.0.1:{port2}/m")))
            .await
            .unwrap_err();
        assert_eq!(e.code, "redirect_blocked");
    }

    #[tokio::test]
    async fn get_json_follows_same_origin_redirect() {
        let (port, hits) = serve(|raw| {
            if raw.starts_with("GET /old ") {
                b"HTTP/1.1 302 Found\r\nLocation: /new\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
            } else {
                ok_json(r#"{"ok":true}"#)
            }
        })
        .await;
        let resp = get(req(&format!("http://127.0.0.1:{port}/old")))
            .await
            .unwrap();
        assert_eq!(resp.body, r#"{"ok":true}"#);
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn get_json_stops_redirect_loops() {
        let (port, _) = serve(|_| {
            b"HTTP/1.1 302 Found\r\nLocation: /again\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
        })
        .await;
        let e = get(req(&format!("http://127.0.0.1:{port}/m")))
            .await
            .unwrap_err();
        assert_eq!(e.code, "redirect_blocked");
    }

    #[tokio::test]
    async fn get_json_rejects_oversized_response_by_content_length() {
        let (port, _) = serve(|_| ok_json(&"x".repeat(2_000))).await;
        let e = get_json(req(&format!("http://127.0.0.1:{port}/m")), 1_000, 5_000)
            .await
            .unwrap_err();
        assert_eq!(e.code, "too_large");
    }

    #[tokio::test]
    async fn get_json_rejects_oversized_streamed_body_without_content_length() {
        // No Content-Length (close-delimited): only the running count can stop it.
        let (port, _) = serve(|_| {
            let mut r = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
            r.extend(std::iter::repeat_n(b'x', 5_000));
            r
        })
        .await;
        let e = get_json(req(&format!("http://127.0.0.1:{port}/m")), 1_000, 5_000)
            .await
            .unwrap_err();
        assert_eq!(e.code, "too_large");
    }

    #[tokio::test]
    async fn get_json_rejects_declared_oversize_before_reading_the_body() {
        // Declares 2000 bytes (limit 1000) but never sends them: only the
        // Content-Length check can refuse before the timeout fires.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _holder = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2000\r\n\r\n{")
                .await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let e = get_json(req(&format!("http://127.0.0.1:{port}/m")), 1_000, 5_000)
            .await
            .unwrap_err();
        assert_eq!(e.code, "too_large");
    }

    #[tokio::test]
    async fn get_json_accepts_body_exactly_at_the_limit() {
        let (port, _) = serve(|_| ok_json(&"x".repeat(1_000))).await;
        let resp = get_json(req(&format!("http://127.0.0.1:{port}/m")), 1_000, 5_000)
            .await
            .unwrap();
        assert_eq!(resp.body.len(), 1_000);
    }

    #[tokio::test]
    async fn get_json_times_out_on_a_stalled_server() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // Accept and never answer.
        let _holder = tokio::spawn(async move {
            let (_sock, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let mut r = req(&format!("http://127.0.0.1:{port}/m"));
        r.timeout_ms = Some(300);
        let started = std::time::Instant::now();
        let e = get(r).await.unwrap_err();
        assert_eq!(e.code, "timeout");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn get_json_times_out_on_a_body_that_stalls_midway() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _holder = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{")
                .await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let mut r = req(&format!("http://127.0.0.1:{port}/m"));
        r.timeout_ms = Some(300);
        assert_eq!(get(r).await.unwrap_err().code, "timeout");
    }

    #[tokio::test]
    async fn get_json_connection_refused_error_never_contains_header_or_url_secret() {
        // Bind then drop to get a port nothing listens on.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let mut r = req(&format!("http://127.0.0.1:{port}/models?key={MARKER}"));
        r.headers = Some(HashMap::from([(
            "Authorization".into(),
            format!("Bearer {MARKER}"),
        )]));
        let e = get(r).await.unwrap_err();
        assert_eq!(e.code, "connect_failed");
        let shown = format!("{e:?} {} {}", e.code, e.message);
        let json = serde_json::to_string(&e).unwrap();
        assert!(!shown.contains(MARKER), "marker leaked in Debug: {shown}");
        assert!(!json.contains(MARKER), "marker leaked in JSON: {json}");
    }

    #[tokio::test]
    async fn get_json_invalid_header_error_never_contains_the_value() {
        let mut r = req("http://127.0.0.1:1/m");
        r.headers = Some(HashMap::from([(
            "Authorization".into(),
            format!("Bearer {MARKER}\r\nX-Injected: 1"),
        )]));
        let e = get(r).await.unwrap_err();
        assert_eq!(e.code, "invalid_header");
        assert!(!serde_json::to_string(&e).unwrap().contains(MARKER));

        let mut r = req("http://127.0.0.1:1/m");
        r.headers = Some(HashMap::from([(format!("bad name {MARKER}"), "v".into())]));
        let e = get(r).await.unwrap_err();
        assert_eq!(e.code, "invalid_header");
        assert!(!serde_json::to_string(&e).unwrap().contains(MARKER));
    }

    #[tokio::test]
    async fn get_json_rejects_forbidden_and_excessive_headers() {
        for name in ["Host", "content-length", "Transfer-Encoding", "Connection"] {
            let mut r = req("http://127.0.0.1:1/m");
            r.headers = Some(HashMap::from([(name.into(), "x".into())]));
            assert_eq!(get(r).await.unwrap_err().code, "invalid_header", "{name}");
        }
        let mut r = req("http://127.0.0.1:1/m");
        r.headers = Some(
            (0..=HTTP_MAX_HEADERS)
                .map(|i| (format!("x-h{i}"), "v".to_string()))
                .collect(),
        );
        assert_eq!(get(r).await.unwrap_err().code, "invalid_header");
        let mut r = req("http://127.0.0.1:1/m");
        r.headers = Some(HashMap::from([(
            "x-big".into(),
            "v".repeat(HTTP_MAX_HEADER_BYTES),
        )]));
        assert_eq!(get(r).await.unwrap_err().code, "invalid_header");
    }

    // ── CLI ──

    #[test]
    fn cli_kind_accepts_only_the_two_provider_ids() {
        assert_eq!(cli_kind_for_provider_id("grok-sub").unwrap(), "grok-cli");
        assert_eq!(
            cli_kind_for_provider_id("antigravity-sub").unwrap(),
            "antigravity-cli"
        );
        for bad in [
            "",
            "grok",
            "grok-cli",
            "claude-sub",
            "codex-sub",
            "bash",
            "/bin/sh",
            "../../bin/sh",
            "grok-sub; rm -rf /",
            "grok-sub models",
            "GROK-SUB",
        ] {
            assert_eq!(
                cli_kind_for_provider_id(bad).unwrap_err().code,
                "unknown_provider",
                "{bad:?}"
            );
        }
    }

    #[tokio::test]
    async fn cli_list_models_command_rejects_unknown_provider_before_resolving() {
        let e = cli_list_models("/bin/sh".to_string()).await.unwrap_err();
        assert_eq!(e.code, "unknown_provider");
    }

    #[cfg(unix)]
    mod cli {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        /// Write an executable fake CLI into `dir`; `body` is the shell script.
        fn fake_cli(dir: &Path, name: &str, body: &str) -> String {
            let path = dir.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path.to_string_lossy().into_owned()
        }

        async fn run(bin: &str, max: usize, secs: u64) -> Result<String, ModelListError> {
            // A freshly written script can hit ETXTBSY when a sibling test forks
            // concurrently; that is a harness race, not behavior under test.
            for _ in 0..20 {
                match run_models_command(bin, max, Duration::from_secs(secs)).await {
                    Err(e) if e.code == "cli_spawn_failed" => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    other => return other,
                }
            }
            run_models_command(bin, max, Duration::from_secs(secs)).await
        }

        #[tokio::test]
        async fn returns_stdout_and_passes_only_the_models_argument() {
            let dir = tempfile::tempdir().unwrap();
            let bin = fake_cli(
                dir.path(),
                "fakecli",
                r#"[ "$#" -eq 1 ] && [ "$1" = "models" ] || exit 7
printf 'Default model: m1\n  * m1 (default)\n  - m2\n'"#,
            );
            let out = run(&bin, 1024, 10).await.unwrap();
            assert_eq!(out, "Default model: m1\n  * m1 (default)\n  - m2\n");
        }

        #[tokio::test]
        async fn missing_binary_is_a_typed_error_not_a_panic() {
            let dir = tempfile::tempdir().unwrap();
            let missing = dir.path().join("nope").to_string_lossy().into_owned();
            let e = run_models_command(&missing, 1024, Duration::from_secs(5))
                .await
                .unwrap_err();
            assert_eq!(e.code, "cli_spawn_failed");
        }

        #[tokio::test]
        async fn hung_cli_times_out_and_is_killed() {
            let dir = tempfile::tempdir().unwrap();
            let marker = dir.path().join("still-alive");
            let bin = fake_cli(
                dir.path(),
                "hang",
                &format!("sleep 3\ntouch '{}'", marker.display()),
            );
            let started = std::time::Instant::now();
            let e = run_models_command(&bin, 1024, Duration::from_millis(400))
                .await
                .unwrap_err();
            assert_eq!(e.code, "timeout");
            assert!(started.elapsed() < Duration::from_secs(3));
            // The shell was killed on drop, so it never reaches `touch`.
            tokio::time::sleep(Duration::from_millis(3_500)).await;
            assert!(!marker.exists(), "hung CLI outlived the timeout");
        }

        #[tokio::test]
        async fn oversized_stdout_is_rejected() {
            let dir = tempfile::tempdir().unwrap();
            let bin = fake_cli(dir.path(), "big", "yes x | head -c 100000");
            let e = run(&bin, 1_000, 10).await.unwrap_err();
            assert_eq!(e.code, "too_large");
        }

        #[tokio::test]
        async fn endless_stdout_is_cut_at_the_limit_not_buffered() {
            let dir = tempfile::tempdir().unwrap();
            let bin = fake_cli(dir.path(), "endless", "yes x");
            let started = std::time::Instant::now();
            let e = run(&bin, 4_096, 10).await.unwrap_err();
            assert_eq!(e.code, "too_large");
            assert!(started.elapsed() < Duration::from_secs(5));
        }

        #[tokio::test]
        async fn stdout_exactly_at_the_limit_is_accepted() {
            let dir = tempfile::tempdir().unwrap();
            let bin = fake_cli(dir.path(), "exact", "head -c 1000 /dev/zero | tr '\\0' a");
            let out = run(&bin, 1_000, 10).await.unwrap();
            assert_eq!(out.len(), 1_000);
        }

        #[tokio::test]
        async fn failing_cli_never_leaks_stderr_or_stdout_into_the_error() {
            let dir = tempfile::tempdir().unwrap();
            let bin = fake_cli(
                dir.path(),
                "fail",
                &format!("echo 'token={MARKER}' >&2\necho 'out={MARKER}'\nexit 3"),
            );
            let e = run(&bin, 1024, 10).await.unwrap_err();
            assert_eq!(e.code, "cli_failed");
            assert!(!serde_json::to_string(&e).unwrap().contains(MARKER));
        }

        #[tokio::test]
        async fn successful_cli_does_not_forward_stderr() {
            let dir = tempfile::tempdir().unwrap();
            let bin = fake_cli(
                dir.path(),
                "noisy",
                &format!("echo 'token={MARKER}' >&2\necho models"),
            );
            let out = run(&bin, 1024, 10).await.unwrap();
            assert_eq!(out, "models\n");
            assert!(!out.contains(MARKER));
        }
    }

    // ── Codex cache ──

    fn home_with_cache(contents: &str) -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".codex")).unwrap();
        std::fs::write(home.path().join(".codex/models_cache.json"), contents).unwrap();
        home
    }

    #[test]
    fn codex_cache_returns_only_the_model_fields() {
        let home = home_with_cache(&format!(
            r#"{{"client_version":"1","etag":"{MARKER}","identity":"{MARKER}","models":[
              {{"slug":"gpt-x","display_name":"GPT X","context_window":272000,"visibility":"list",
                "default_reasoning_level":"medium",
                "supported_reasoning_levels":[{{"effort":"low","description":"d"}},{{"effort":"high","description":"d"}}],
                "model_messages":"{MARKER}","description":"{MARKER}"}},
              {{"slug":"gpt-y"}}]}}"#
        ));
        let models = read_codex_models(home.path()).unwrap();
        assert_eq!(
            models,
            vec![
                CodexModel {
                    slug: "gpt-x".into(),
                    display_name: Some("GPT X".into()),
                    context_window: Some(272000),
                    visibility: Some("list".into()),
                    default_reasoning_level: Some("medium".into()),
                    reasoning_efforts: vec!["low".into(), "high".into()],
                },
                CodexModel {
                    slug: "gpt-y".into(),
                    display_name: None,
                    context_window: None,
                    visibility: None,
                    default_reasoning_level: None,
                    reasoning_efforts: vec![],
                },
            ]
        );
        let json = serde_json::to_string(&models).unwrap();
        assert!(!json.contains(MARKER), "non-model field forwarded: {json}");
        assert!(json.contains("\"displayName\"") && json.contains("\"reasoningEfforts\""));
    }

    #[test]
    fn codex_cache_missing_file_is_not_found() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            read_codex_models(home.path()).unwrap_err().code,
            "not_found"
        );
        std::fs::create_dir_all(home.path().join(".codex")).unwrap();
        assert_eq!(
            read_codex_models(home.path()).unwrap_err().code,
            "not_found"
        );
    }

    #[test]
    fn codex_cache_rejects_malformed_documents_whole() {
        for bad in [
            "",
            "not json",
            "[]",
            r#"{"models":"x"}"#,
            r#"{"nomodels":[]}"#,
            r#"{"models":[1]}"#,
            r#"{"models":[{"display_name":"no slug"}]}"#,
            r#"{"models":[{"slug":""}]}"#,
            r#"{"models":[{"slug":7}]}"#,
            r#"{"models":[{"slug":"ok"},{"slug":"b","context_window":"big"}]}"#,
            r#"{"models":[{"slug":"ok"},{"slug":"b","context_window":-1}]}"#,
            r#"{"models":[{"slug":"a","supported_reasoning_levels":"x"}]}"#,
            r#"{"models":[{"slug":"a","supported_reasoning_levels":[{"nope":1}]}]}"#,
        ] {
            assert_eq!(
                read_codex_models(home_with_cache(bad).path())
                    .unwrap_err()
                    .code,
                "malformed",
                "{bad}"
            );
        }
        let long = "a".repeat(CODEX_MAX_FIELD_CHARS + 1);
        let doc = format!(r#"{{"models":[{{"slug":"{long}"}}]}}"#);
        assert_eq!(
            read_codex_models(home_with_cache(&doc).path())
                .unwrap_err()
                .code,
            "malformed"
        );
        let many = (0..=CODEX_MAX_MODELS)
            .map(|i| format!(r#"{{"slug":"m{i}"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        let doc = format!(r#"{{"models":[{many}]}}"#);
        assert_eq!(
            read_codex_models(home_with_cache(&doc).path())
                .unwrap_err()
                .code,
            "malformed"
        );
    }

    #[test]
    fn codex_cache_malformed_error_never_contains_file_content() {
        let home = home_with_cache(&format!(r#"{{"models":[{{"slug":7,"x":"{MARKER}"}}]}}"#));
        let e = read_codex_models(home.path()).unwrap_err();
        assert!(!serde_json::to_string(&e).unwrap().contains(MARKER));
    }

    #[test]
    fn codex_cache_rejects_a_giant_file_before_parsing_it() {
        let pad = "x".repeat(CODEX_MAX_FILE_BYTES as usize + 16);
        let home = home_with_cache(&format!(r#"{{"models":[{{"slug":"a"}}],"pad":"{pad}"}}"#));
        assert_eq!(
            read_codex_models(home.path()).unwrap_err().code,
            "too_large"
        );
    }

    #[test]
    fn read_text_bounded_stops_an_endless_source_and_accepts_the_exact_limit() {
        // `repeat` never ends: only the take() bound stops the read.
        let e = read_text_bounded(std::io::repeat(b'a'), 1_000).unwrap_err();
        assert_eq!(e.code, "too_large");
        let ok = read_text_bounded(std::io::repeat(b'a').take(1_000), 1_000).unwrap();
        assert_eq!(ok.len(), 1_000);
        let over = read_text_bounded(std::io::repeat(b'a').take(1_001), 1_000).unwrap_err();
        assert_eq!(over.code, "too_large");
    }

    #[test]
    fn codex_cache_rejects_a_directory_in_place_of_the_file() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".codex/models_cache.json")).unwrap();
        assert_eq!(
            read_codex_models(home.path()).unwrap_err().code,
            "read_failed"
        );
    }

    #[test]
    fn codex_cache_never_reads_auth_json() {
        // Only models_cache.json exists as a readable credential-free file; an
        // auth.json holding a marker must never surface.
        let home = home_with_cache(r#"{"models":[{"slug":"a"}]}"#);
        std::fs::write(
            home.path().join(".codex/auth.json"),
            format!(r#"{{"OPENAI_API_KEY":"{MARKER}"}}"#),
        )
        .unwrap();
        let json = serde_json::to_string(&read_codex_models(home.path()).unwrap()).unwrap();
        assert!(!json.contains(MARKER));
    }
}
