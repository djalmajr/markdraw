//! Generic OAuth for MCP HTTP servers — works for ANY OAuth-gated server
//! (ai-memory, Linear, …), NOT coupled to any one MCP. rmcp's
//! [`AuthorizationManager`] drives the protocol (RFC 9728 discovery, Dynamic
//! Client Registration, authorization-code + PKCE, refresh); this module supplies
//! the pieces rmcp leaves to the host: a keychain-backed [`CredentialStore`] so
//! tokens + the registered client survive restarts, and the interactive browser +
//! loopback-callback that completes the authorization-code flow ([`authorize`]).

use std::time::Duration;

use keyring::Entry;
use rmcp::transport::auth::{
    AuthError, AuthorizationManager, CredentialStore, InMemoryStateStore, StoredCredentials,
};
use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Keychain service for stored MCP OAuth credentials. Distinct from the AI
/// provider API-key service (`app.markdraw`) so the two never collide;
/// the account is the MCP server id. Like that service, the dev build uses a
/// `-dev` namespace so dev/prod keychain items don't collide across signatures
/// (see the SERVICE doc in ai_keychain.rs).
#[cfg(debug_assertions)]
const OAUTH_SERVICE: &str = "app.markdraw-dev.mcp-oauth";
#[cfg(not(debug_assertions))]
const OAUTH_SERVICE: &str = "app.markdraw.mcp-oauth";

/// Persists one MCP server's OAuth credentials (access/refresh tokens + the
/// DCR-registered client id) in the OS keychain, keyed by the server id.
pub struct KeychainCredentialStore {
    server_id: String,
}

impl KeychainCredentialStore {
    pub fn new(server_id: impl Into<String>) -> Self {
        Self {
            server_id: server_id.into(),
        }
    }

    fn entry(&self) -> Result<Entry, AuthError> {
        Entry::new(OAUTH_SERVICE, &self.server_id)
            .map_err(|e| AuthError::InternalError(format!("keychain entry: {e}")))
    }
}

#[async_trait::async_trait]
impl CredentialStore for KeychainCredentialStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        match self.entry()?.get_password() {
            Ok(json) => serde_json::from_str(&json)
                .map(Some)
                .map_err(|e| AuthError::InternalError(format!("deserialize credentials: {e}"))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AuthError::InternalError(format!("keychain read: {e}"))),
        }
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        let json = serde_json::to_string(&credentials)
            .map_err(|e| AuthError::InternalError(format!("serialize credentials: {e}")))?;
        self.entry()?
            .set_password(&json)
            .map_err(|e| AuthError::InternalError(format!("keychain write: {e}")))
    }

    async fn clear(&self) -> Result<(), AuthError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AuthError::InternalError(format!("keychain delete: {e}"))),
        }
    }
}

/// Build an [`AuthorizationManager`] for `url`, backed by the keychain credential
/// store keyed on `server_id`. Shared by the connect path (which then calls
/// `initialize_from_store`) and the interactive [`authorize`] flow.
pub async fn manager_with_store(
    server_id: &str,
    url: &str,
) -> Result<AuthorizationManager, String> {
    let mut manager = AuthorizationManager::new(url)
        .await
        .map_err(|e| oauth_failure(Stage::Init, &e))?;
    manager.set_credential_store(KeychainCredentialStore::new(server_id));
    Ok(manager)
}

/// The step of the OAuth flow that failed — picks the fixed message below.
#[derive(Clone, Copy)]
enum Stage {
    Init,
    Discovery,
    Registration,
    AuthorizationUrl,
    TokenExchange,
    StoredCredentials,
}

/// Map an SDK failure to a FIXED `code` + message for the frontend. The SDK's own
/// text embeds values a third-party MCP / authorization server controls (the
/// `iss` it sent, the raw body of a failed registration, …); that detail stays in
/// Rust — it never reaches the webview card or console, and nothing is logged.
/// The two issuer variants get their own codes so the user can tell a hostile
/// or misconfigured server apart from a plain outage.
fn oauth_failure(stage: Stage, err: &AuthError) -> String {
    let (code, message) = match err {
        AuthError::AuthorizationServerMismatch { .. } => (
            "oauth_issuer_mismatch",
            "The authorization server identity does not match",
        ),
        AuthError::AuthorizationServerMissingIssuer { .. } => (
            "oauth_issuer_missing",
            "The authorization server did not identify itself",
        ),
        _ => match stage {
            Stage::Init => ("oauth_init_failed", "OAuth setup failed"),
            Stage::Discovery => ("oauth_discovery_failed", "OAuth discovery failed"),
            Stage::Registration => (
                "oauth_registration_failed",
                "OAuth client registration failed",
            ),
            Stage::AuthorizationUrl => (
                "oauth_authorization_url_failed",
                "OAuth authorization request failed",
            ),
            Stage::TokenExchange => ("oauth_token_exchange_failed", "OAuth token exchange failed"),
            Stage::StoredCredentials => (
                "oauth_credentials_failed",
                "Stored OAuth credentials could not be used",
            ),
        },
    };
    format!("{message} ({code})")
}

const DISCOVERY_UNAVAILABLE: &str =
    "The server publishes no OAuth metadata; authorize again once it does (oauth_discovery_unavailable)";

/// Whether `url` advertises OAuth authorization metadata (RFC 9728 protected-
/// resource metadata, then RFC 8414 authorization-server metadata). Lets the
/// connect path tell an OAuth-gated server (→ offer "Authorize") apart from one
/// that is simply unreachable or genuinely needs no auth.
pub async fn server_advertises_oauth(url: &str) -> bool {
    match AuthorizationManager::new(url).await {
        // Only metadata the server really published counts: rmcp 3 also answers
        // `Ok` with endpoints it synthesized from the base URL (legacy fallback),
        // which says nothing about the server supporting OAuth.
        Ok(manager) => manager
            .resolve_metadata()
            .await
            .is_ok_and(|resolution| resolution.source.is_discovered()),
        Err(_) => false,
    }
}

/// Load the stored credentials into `manager` — but only when they can be bound
/// to an authorization server the resource actually PUBLISHED. rmcp's `initialize_from_store` accepts the
/// legacy endpoint fallback (endpoints synthesized from the base URL, no issuer)
/// and then skips the issuer comparison, which would hand a stored refresh token
/// to whatever the base URL answers. Returns `Ok(false)` — "no usable
/// credentials", so the flow asks to authorize again — when nothing is stored,
/// discovery fails, or it yields only the fallback. (Published metadata without
/// an `issuer` never gets here: with `allow_missing_issuer` off, rmcp's
/// `resolve_metadata` already fails on it — pinned by a test.) The
/// stored credentials are left untouched in those cases (an outage must not
/// erase them); discovery is skipped when there is nothing to bind.
pub async fn initialize_from_store_discovered(
    manager: &mut AuthorizationManager,
    store: &impl CredentialStore,
) -> Result<bool, String> {
    let stored = store
        .load()
        .await
        .map_err(|e| oauth_failure(Stage::StoredCredentials, &e))?;
    if !stored.is_some_and(|s| s.token_response.is_some()) {
        return Ok(false);
    }
    let Ok(resolution) = manager.resolve_metadata().await else {
        return Ok(false);
    };
    if !resolution.source.is_discovered() {
        return Ok(false);
    }
    manager.set_metadata(resolution.metadata);
    manager
        .initialize_from_store()
        .await
        .map_err(|e| oauth_failure(Stage::StoredCredentials, &e))
}

/// Run the interactive authorization-code + PKCE flow for an OAuth-gated MCP
/// server and persist the resulting tokens in the keychain. GENERIC: every step
/// (RFC 9728 discovery, Dynamic Client Registration, scope selection, the
/// loopback redirect) is driven from the server's own metadata — nothing here is
/// specific to any one MCP. On return the connect path can `initialize_from_store`
/// and attach a bearer-injecting `AuthClient`.
pub async fn authorize<R: Runtime>(
    app: &AppHandle<R>,
    server_id: &str,
    url: &str,
) -> Result<(), String> {
    // Loopback listener on an ephemeral port — the redirect target the browser
    // hits with `?code=…&state=…` once the user consents.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind loopback: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("loopback addr: {e}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let mut manager = manager_with_store(server_id, url).await?;
    // In-memory state store: the PKCE verifier + CSRF token live only for the
    // duration of this one flow, in this one process.
    manager.set_state_store(InMemoryStateStore::new());

    // Discovery must precede registration — register/configure both read metadata.
    let resolution = manager
        .resolve_metadata()
        .await
        .map_err(|e| oauth_failure(Stage::Discovery, &e))?;
    // Legacy fallback = endpoints guessed from the base URL: never register a
    // client or send the user's code there (rmcp 1.x refused this too).
    if !resolution.source.is_discovered() {
        return Err(DISCOVERY_UNAVAILABLE.to_string());
    }
    manager.set_metadata(resolution.metadata);

    // SEP-835 scope selection (resource metadata → AS metadata; + offline_access
    // so the AS issues a refresh token), then a fresh public-client DCR bound to
    // THIS loopback redirect. Re-registering each run is intentional: the port
    // changes per run and `configure_client_id` would force redirect_uri =
    // base_url, which the authorization request would then reject.
    let scopes = manager.select_scopes(None, &[]);
    let scope_refs: Vec<&str> = scopes.iter().map(|s| s.as_str()).collect();
    manager
        .register_client("Markdraw", &redirect_uri, &scope_refs)
        .await
        .map_err(|e| oauth_failure(Stage::Registration, &e))?;

    let auth_url = manager
        .get_authorization_url(&scope_refs)
        .await
        .map_err(|e| oauth_failure(Stage::AuthorizationUrl, &e))?;

    app.opener()
        .open_url(auth_url, None::<String>)
        .map_err(|e| format!("open browser: {e}"))?;

    // Block (≤5 min) for the browser to redirect back to the loopback.
    let callback = wait_for_callback(listener).await?;

    // Exchanges + persists tokens (incl. the client id) via the keychain store.
    exchange_callback(&manager, &callback).await
}

/// Exchange the callback's code, handing the SDK the `iss` the authorization
/// server put on the redirect (RFC 9207). The SDK compares it with the issuer it
/// recorded at discovery — and, for a server that advertises
/// `authorization_response_iss_parameter_supported`, also refuses a callback
/// without one — BEFORE consuming the PKCE state or calling the token endpoint.
/// Passing `None` here would drop that check and wrongly reject a compliant
/// server's own callback.
async fn exchange_callback(
    manager: &AuthorizationManager,
    callback: &CallbackParams,
) -> Result<(), String> {
    manager
        .exchange_code_for_token_with_issuer(
            &callback.code,
            &callback.state,
            callback.iss.as_deref(),
        )
        .await
        .map(|_| ())
        .map_err(|e| oauth_failure(Stage::TokenExchange, &e))
}

/// What the loopback redirect carried: the authorization `code`, the CSRF
/// `state` and, when the server sent one, its RFC 9207 `iss`.
#[derive(Debug, PartialEq, Eq)]
pub struct CallbackParams {
    pub code: String,
    pub state: String,
    pub iss: Option<String>,
}

/// Wait (≤5 min total) for the browser to hit the loopback redirect, returning
/// the [`CallbackParams`]. Accepts in a loop so a stray connection (browser
/// preconnect, favicon, an HTTP probe) doesn't consume the one shot — only a
/// request that actually carries the OAuth params ends the wait. An AS error
/// redirect (`?error=access_denied&…`, RFC 6749 §4.1.2.1) ends it with a
/// meaningful message rather than an opaque "missing code/state".
async fn wait_for_callback(listener: TcpListener) -> Result<CallbackParams, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    let timeout = tokio::time::sleep_until(deadline);
    tokio::pin!(timeout);
    loop {
        let accepted = tokio::select! {
            _ = &mut timeout => {
                return Err("authorization timed out (no redirect within 5 min)".to_string());
            }
            res = listener.accept() => res,
        };
        let (mut stream, _) = accepted.map_err(|e| format!("loopback accept: {e}"))?;
        let request_line = read_request_line(&mut stream).await;

        if let Some(pair) = parse_callback_query(&request_line) {
            write_response(&mut stream, AUTHORIZED_PAGE).await;
            return Ok(pair);
        }
        if let Some((error, description)) = parse_callback_error(&request_line) {
            write_response(&mut stream, FAILED_PAGE).await;
            let detail = description.map(|d| format!(" — {d}")).unwrap_or_default();
            return Err(format!("authorization denied ({error}){detail}"));
        }
        // Stray/non-callback connection: close it and keep waiting for the real
        // redirect within the remaining time budget.
        drop(stream);
    }
}

/// Read off a loopback connection up to the end of the HTTP request line (first
/// CRLF), so a short TCP read can't truncate `GET /callback?…` mid-query. Caps at
/// 8 KiB and tolerates EOF/error by returning whatever arrived.
async fn read_request_line<S: AsyncReadExt + Unpin>(stream: &mut S) -> String {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = buf.windows(2).position(|w| w == b"\r\n") {
                    buf.truncate(pos);
                    break;
                }
                if buf.len() > 8192 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

// Neutral wording on purpose: this page is written the moment the redirect
// arrives, BEFORE the token exchange runs — so it must not claim success the
// exchange might still deny. The real outcome surfaces back in Markdraw.
const AUTHORIZED_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Markdraw</title>\
<body style=\"font:16px system-ui;text-align:center;padding:3rem\">\
<h2>Recebido</h2><p>Pode fechar esta aba e voltar ao Markdraw.</p>";

const FAILED_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Markdraw</title>\
<body style=\"font:16px system-ui;text-align:center;padding:3rem\">\
<h2>Falha na autoriza\u{e7}\u{e3}o</h2><p>Resposta inesperada. Tente de novo no Markdraw.</p>";

/// Best-effort HTTP/1.1 reply on the loopback socket; failures here don't change
/// the auth result (the token exchange has already succeeded or failed).
async fn write_response<S: AsyncWriteExt + Unpin>(stream: &mut S, body: &str) {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
}

/// Form-decoded `(key, value)` pairs from the query of an HTTP request line such
/// as `GET /callback?code=abc&state=xyz HTTP/1.1`. Empty when there is no query.
fn query_params(request_line: &str) -> Vec<(String, String)> {
    let Some(target) = request_line.split_whitespace().nth(1) else {
        return Vec::new();
    };
    let Some((_, query)) = target.split_once('?') else {
        return Vec::new();
    };
    query
        .split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            Some((key.to_string(), form_decode(value)))
        })
        .collect()
}

/// Extract `code`, `state` and the optional `iss` from a callback request line.
/// Values are form-decoded (`+`→space, `%XX`→byte). Returns `None` if `code` or
/// `state` is absent (e.g. an error redirect — see [`parse_callback_error`]).
/// Pure → unit-tested.
pub fn parse_callback_query(request_line: &str) -> Option<CallbackParams> {
    let params = query_params(request_line);
    let get = |key: &str| {
        params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    };
    Some(CallbackParams {
        code: get("code")?,
        state: get("state")?,
        iss: get("iss"),
    })
}

/// The authorization server's error redirect (RFC 6749 §4.1.2.1):
/// `?error=access_denied&error_description=…`. Returns `(error, description?)`
/// when `code` is absent but `error` is present. Pure → unit-tested.
fn parse_callback_error(request_line: &str) -> Option<(String, Option<String>)> {
    let params = query_params(request_line);
    let get = |key: &str| {
        params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    };
    if get("code").is_some() {
        return None;
    }
    Some((get("error")?, get("error_description")))
}

/// Decode one `application/x-www-form-urlencoded` value (`+`→space, `%XX`→byte).
fn form_decode(value: &str) -> String {
    let spaced = value.replace('+', " ");
    percent_encoding::percent_decode_str(&spaced)
        .decode_utf8_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::{parse_callback_error, parse_callback_query, CallbackParams};

    fn params(code: &str, state: &str, iss: Option<&str>) -> Option<CallbackParams> {
        Some(CallbackParams {
            code: code.to_string(),
            state: state.to_string(),
            iss: iss.map(str::to_string),
        })
    }

    // ---- loopback authorization server (synthetic; 127.0.0.1 only) ----

    use super::{
        exchange_callback, initialize_from_store_discovered, oauth_failure,
        server_advertises_oauth, Stage,
    };
    use rmcp::transport::auth::{
        AuthError, AuthorizationManager, CredentialStore, InMemoryCredentialStore,
        InMemoryStateStore, OAuthTokenResponse, StoredCredentials,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Clone, Default)]
    struct Cfg {
        /// Serve RFC 8414 metadata (else every well-known path is a 404, so
        /// rmcp answers with its legacy endpoint fallback).
        publish: bool,
        /// Advertise `authorization_response_iss_parameter_supported`.
        iss_supported: bool,
        /// Issuer written into the metadata (default: the server's own origin).
        issuer: Option<String>,
        /// Publish metadata without an `issuer` member.
        omit_issuer: bool,
        /// `(status, body)` for POST /register (default: a valid 201 client).
        register: Option<(u16, String)>,
    }

    struct Mock {
        base: String,
        token_hits: Arc<AtomicUsize>,
        any_hits: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Mock {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<(String, String)> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 2048];
        let head_end = loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return None,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
        let len = head
            .lines()
            .find_map(|l| {
                l.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(str::to_owned)
            })
            .and_then(|v| v.trim().parse::<usize>().ok())
            .unwrap_or(0);
        while buf.len() < head_end + len {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
        let mut parts = head.split_whitespace();
        Some((parts.next()?.to_string(), parts.next()?.to_string()))
    }

    async fn mock(cfg: Cfg) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let token_hits = Arc::new(AtomicUsize::new(0));
        let any_hits = Arc::new(AtomicUsize::new(0));
        let (b, t, a) = (base.clone(), token_hits.clone(), any_hits.clone());
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let (cfg, b, t, a) = (cfg.clone(), b.clone(), t.clone(), a.clone());
                tokio::spawn(async move {
                    let Some((method, path)) = read_request(&mut stream).await else {
                        return;
                    };
                    a.fetch_add(1, Ordering::SeqCst);
                    let (status, body) =
                        if cfg.publish && path == "/.well-known/oauth-authorization-server" {
                            let mut meta = serde_json::json!({
                                "issuer": cfg.issuer.clone().unwrap_or_else(|| b.clone()),
                                "authorization_endpoint": format!("{b}/authorize"),
                                "token_endpoint": format!("{b}/token"),
                                "registration_endpoint": format!("{b}/register"),
                                "response_types_supported": ["code"],
                                "code_challenge_methods_supported": ["S256"],
                            });
                            if cfg.omit_issuer {
                                meta.as_object_mut().unwrap().remove("issuer");
                            }
                            if cfg.iss_supported {
                                meta["authorization_response_iss_parameter_supported"] =
                                    serde_json::json!(true);
                            }
                            (200, meta.to_string())
                        } else if method == "POST" && path == "/register" {
                            cfg.register.clone().unwrap_or_else(|| {
                                (
                                    201,
                                    serde_json::json!({
                                        "client_id": "cid",
                                        "redirect_uris": ["http://127.0.0.1:1/callback"],
                                    })
                                    .to_string(),
                                )
                            })
                        } else if method == "POST" && path == "/token" {
                            t.fetch_add(1, Ordering::SeqCst);
                            (
                            200,
                            r#"{"access_token":"at","token_type":"Bearer","refresh_token":"rt"}"#
                                .to_string(),
                        )
                        } else {
                            (404, "{}".to_string())
                        };
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(reply.as_bytes()).await;
                    let _ = stream.flush().await;
                });
            }
        });
        Mock {
            base,
            token_hits,
            any_hits,
            task,
        }
    }

    /// A manager that has discovered + registered against `mock` and holds a
    /// pending authorization state; returns it with that state's CSRF token.
    async fn manager_ready_for_callback(mock: &Mock) -> (AuthorizationManager, String) {
        let mut manager = AuthorizationManager::new(&mock.base).await.unwrap();
        manager.set_credential_store(InMemoryCredentialStore::new());
        manager.set_state_store(InMemoryStateStore::new());
        let resolution = manager.resolve_metadata().await.unwrap();
        assert!(resolution.source.is_discovered());
        manager.set_metadata(resolution.metadata);
        manager
            .register_client("Markdraw", "http://127.0.0.1:1/callback", &[])
            .await
            .unwrap();
        let url = manager.get_authorization_url(&[]).await.unwrap();
        let state = url
            .split(['?', '&'])
            .find_map(|kv| kv.strip_prefix("state="))
            .unwrap()
            .to_string();
        (manager, state)
    }

    fn token() -> OAuthTokenResponse {
        serde_json::from_str(
            r#"{"access_token":"stored","token_type":"Bearer","refresh_token":"r"}"#,
        )
        .unwrap()
    }

    // F1: the callback's `iss` reaches the SDK. Rows: (server advertises iss
    // support, `iss` on the redirect, expected result). A rejection must happen
    // BEFORE the token endpoint is called.
    #[tokio::test]
    async fn callback_iss_is_validated_per_advertised_support() {
        let evil = "https://evil.example/SECRET-ISSUER";
        let cases: [(bool, Option<&str>, Result<(), &str>); 6] = [
            (false, None, Ok(())),
            (false, Some("SELF"), Ok(())),
            (false, Some(evil), Err("oauth_issuer_mismatch")),
            (true, None, Err("oauth_issuer_missing")),
            (true, Some("SELF"), Ok(())),
            (true, Some(evil), Err("oauth_issuer_mismatch")),
        ];
        for (iss_supported, iss, expected) in cases {
            let server = mock(Cfg {
                publish: true,
                iss_supported,
                ..Cfg::default()
            })
            .await;
            let (manager, state) = manager_ready_for_callback(&server).await;
            let iss = iss.map(|v| {
                if v == "SELF" {
                    server.base.clone()
                } else {
                    v.to_string()
                }
            });
            let callback = CallbackParams {
                code: "code".into(),
                state,
                iss: iss.clone(),
            };
            let result = exchange_callback(&manager, &callback).await;
            let label = format!("iss_supported={iss_supported} iss={iss:?}");
            match expected {
                Ok(()) => {
                    assert!(result.is_ok(), "{label}: {result:?}");
                    assert_eq!(server.token_hits.load(Ordering::SeqCst), 1, "{label}");
                }
                Err(code) => {
                    let err = result.unwrap_err();
                    assert!(err.contains(code), "{label}: {err}");
                    // F3 at the same boundary: the remote `iss` never leaves Rust.
                    assert!(
                        !err.contains("evil.example") && !err.contains("SECRET"),
                        "{err}"
                    );
                    assert_eq!(server.token_hits.load(Ordering::SeqCst), 0, "{label}");
                }
            }
        }
    }

    async fn stored_with_token(issuer: Option<&str>) -> InMemoryCredentialStore {
        let store = InMemoryCredentialStore::new();
        store
            .save(
                StoredCredentials::new("cid".into(), Some(token()), vec![], None)
                    .with_issuer(issuer.map(str::to_string)),
            )
            .await
            .unwrap();
        store
    }

    async fn bind(mock: &Mock, store: &InMemoryCredentialStore) -> Result<bool, String> {
        let mut manager = AuthorizationManager::new(&mock.base).await.unwrap();
        manager.set_credential_store(store.clone());
        initialize_from_store_discovered(&mut manager, store).await
    }

    // F2: legacy fallback metadata (nothing published) must not bind stored
    // credentials; published metadata does (control).
    #[tokio::test]
    async fn legacy_fallback_does_not_bind_stored_credentials() {
        let fallback = mock(Cfg::default()).await;
        let store = stored_with_token(None).await;
        assert_eq!(bind(&fallback, &store).await, Ok(false));
        // Left untouched: an outage / missing metadata must not erase them.
        assert!(store.load().await.unwrap().is_some());
        assert!(!server_advertises_oauth(&fallback.base).await);

        let published = mock(Cfg {
            publish: true,
            ..Cfg::default()
        })
        .await;
        assert_eq!(bind(&published, &store).await, Ok(true));
        assert!(server_advertises_oauth(&published.base).await);
    }

    // Premise of dropping a separate issuer check: published metadata that omits
    // `issuer` is refused by rmcp itself (allow_missing_issuer stays false), so
    // it never binds stored credentials either.
    #[tokio::test]
    async fn published_metadata_without_issuer_is_refused_and_never_binds() {
        let server = mock(Cfg {
            publish: true,
            omit_issuer: true,
            ..Cfg::default()
        })
        .await;
        let manager = AuthorizationManager::new(&server.base).await.unwrap();
        assert!(manager.resolve_metadata().await.is_err());
        let store = stored_with_token(None).await;
        assert_eq!(bind(&server, &store).await, Ok(false));
        assert!(!server_advertises_oauth(&server.base).await);
    }

    #[tokio::test]
    async fn nothing_stored_or_no_token_does_no_discovery() {
        let server = mock(Cfg {
            publish: true,
            ..Cfg::default()
        })
        .await;
        assert_eq!(
            bind(&server, &InMemoryCredentialStore::new()).await,
            Ok(false)
        );
        let no_token = InMemoryCredentialStore::new();
        no_token
            .save(StoredCredentials::new("cid".into(), None, vec![], None))
            .await
            .unwrap();
        assert_eq!(bind(&server, &no_token).await, Ok(false));
        assert_eq!(server.any_hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn published_issuer_change_still_drops_the_old_binding() {
        // Control for the SDK's own check, kept behind the new discovery gate.
        let server = mock(Cfg {
            publish: true,
            ..Cfg::default()
        })
        .await;
        let store = stored_with_token(Some("https://previous-as.example")).await;
        assert_eq!(bind(&server, &store).await, Ok(false));
        assert!(store.load().await.unwrap().is_none());
    }

    // F3: SDK errors that embed remote content reach the frontend as fixed
    // code + message.
    #[tokio::test]
    async fn remote_error_content_never_reaches_the_frontend_string() {
        // Registration: the server's raw error body.
        let server = mock(Cfg {
            publish: true,
            register: Some((400, r#"{"error":"SECRET-REGISTRATION-BODY"}"#.to_string())),
            ..Cfg::default()
        })
        .await;
        let mut manager = AuthorizationManager::new(&server.base).await.unwrap();
        manager.set_credential_store(InMemoryCredentialStore::new());
        let resolution = manager.resolve_metadata().await.unwrap();
        manager.set_metadata(resolution.metadata);
        let sdk_err = manager
            .register_client("Markdraw", "http://127.0.0.1:1/callback", &[])
            .await
            .unwrap_err();
        assert!(
            sdk_err.to_string().contains("SECRET-REGISTRATION-BODY"),
            "premise: the SDK text carries the remote body: {sdk_err}"
        );
        let shown = oauth_failure(Stage::Registration, &sdk_err);
        assert_eq!(
            shown,
            "OAuth client registration failed (oauth_registration_failed)"
        );

        // Discovery: a published issuer that is not the server's own origin.
        let hostile = mock(Cfg {
            publish: true,
            issuer: Some("https://evil.example/SECRET-DISCOVERY-ISSUER".to_string()),
            ..Cfg::default()
        })
        .await;
        let manager = AuthorizationManager::new(&hostile.base).await.unwrap();
        let sdk_err = manager.resolve_metadata().await.unwrap_err();
        assert!(
            matches!(sdk_err, AuthError::AuthorizationServerMismatch { .. }),
            "{sdk_err}"
        );
        assert!(
            sdk_err.to_string().contains("SECRET-DISCOVERY-ISSUER"),
            "premise: {sdk_err}"
        );
        let shown = oauth_failure(Stage::Discovery, &sdk_err);
        assert_eq!(
            shown,
            "The authorization server identity does not match (oauth_issuer_mismatch)"
        );
    }

    #[test]
    fn parses_code_and_state() {
        assert_eq!(
            parse_callback_query("GET /callback?code=abc123&state=xyz HTTP/1.1"),
            params("abc123", "xyz", None)
        );
    }

    #[test]
    fn carries_the_iss_param_through_the_parser() {
        // RFC 9207: the redirect may carry `iss`; it must reach the exchange.
        assert_eq!(
            parse_callback_query(
                "GET /callback?code=c&state=s&iss=https%3A%2F%2Fas.example HTTP/1.1"
            ),
            params("c", "s", Some("https://as.example"))
        );
    }

    #[test]
    fn order_independent_decodes_and_ignores_extras() {
        // state before code, an unrelated param, %2F and + escapes.
        assert_eq!(
            parse_callback_query("GET /cb?state=s%2F1&foo=bar&code=c+d HTTP/1.1"),
            params("c d", "s/1", None)
        );
    }

    #[test]
    fn none_when_code_or_state_missing() {
        assert_eq!(
            parse_callback_query("GET /callback?code=only HTTP/1.1"),
            None
        );
        assert_eq!(parse_callback_query("GET /callback HTTP/1.1"), None);
        assert_eq!(parse_callback_query("garbage"), None);
        assert_eq!(parse_callback_query(""), None);
    }

    #[test]
    fn extracts_error_redirect_with_description() {
        assert_eq!(
            parse_callback_error(
                "GET /callback?error=access_denied&error_description=User+said+no&state=xyz HTTP/1.1"
            ),
            Some(("access_denied".to_string(), Some("User said no".to_string())))
        );
        // error without a description.
        assert_eq!(
            parse_callback_error("GET /callback?error=invalid_scope HTTP/1.1"),
            Some(("invalid_scope".to_string(), None))
        );
    }

    #[test]
    fn no_error_when_code_present_or_no_error_param() {
        // A successful redirect carries `code` → not an error.
        assert_eq!(
            parse_callback_error("GET /callback?code=ok&state=xyz&error=ignored HTTP/1.1"),
            None
        );
        // Neither code nor error → stray connection, not an error redirect.
        assert_eq!(parse_callback_error("GET /favicon.ico HTTP/1.1"), None);
    }
}
