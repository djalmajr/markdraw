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
/// provider API-key service (`dev.djalmajr.asciimark`) so the two never collide;
/// the account is the MCP server id. Like that service, the dev build uses a
/// `-dev` namespace so dev/prod keychain items don't collide across signatures
/// (see the SERVICE doc in ai_keychain.rs).
#[cfg(debug_assertions)]
const OAUTH_SERVICE: &str = "dev.djalmajr.asciimark-dev.mcp-oauth";
#[cfg(not(debug_assertions))]
const OAUTH_SERVICE: &str = "dev.djalmajr.asciimark.mcp-oauth";

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
        .map_err(|e| format!("OAuth init: {e}"))?;
    manager.set_credential_store(KeychainCredentialStore::new(server_id));
    Ok(manager)
}

/// Whether `url` advertises OAuth authorization metadata (RFC 9728 protected-
/// resource metadata, then RFC 8414 authorization-server metadata). Lets the
/// connect path tell an OAuth-gated server (→ offer "Authorize") apart from one
/// that is simply unreachable or genuinely needs no auth.
pub async fn server_advertises_oauth(url: &str) -> bool {
    match AuthorizationManager::new(url).await {
        Ok(manager) => manager.discover_metadata().await.is_ok(),
        Err(_) => false,
    }
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
    let metadata = manager
        .discover_metadata()
        .await
        .map_err(|e| format!("OAuth discovery: {e}"))?;
    manager.set_metadata(metadata);

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
        .map_err(|e| format!("client registration: {e}"))?;

    let auth_url = manager
        .get_authorization_url(&scope_refs)
        .await
        .map_err(|e| format!("authorization url: {e}"))?;

    app.opener()
        .open_url(auth_url, None::<String>)
        .map_err(|e| format!("open browser: {e}"))?;

    // Block (≤5 min) for the browser to redirect back to the loopback.
    let (code, csrf) = wait_for_callback(listener).await?;

    // Exchanges + persists tokens (incl. the client id) via the keychain store.
    manager
        .exchange_code_for_token(&code, &csrf)
        .await
        .map_err(|e| format!("token exchange: {e}"))?;
    Ok(())
}

/// Wait (≤5 min total) for the browser to hit the loopback redirect, returning
/// the `(code, state)` pair. Accepts in a loop so a stray connection (browser
/// preconnect, favicon, an HTTP probe) doesn't consume the one shot — only a
/// request that actually carries the OAuth params ends the wait. An AS error
/// redirect (`?error=access_denied&…`, RFC 6749 §4.1.2.1) ends it with a
/// meaningful message rather than an opaque "missing code/state".
async fn wait_for_callback(listener: TcpListener) -> Result<(String, String), String> {
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

/// Extract `code` and `state` from a callback request line. Values are
/// form-decoded (`+`→space, `%XX`→byte). Returns `None` if either is absent
/// (e.g. an error redirect — see [`parse_callback_error`]). Pure → unit-tested.
pub fn parse_callback_query(request_line: &str) -> Option<(String, String)> {
    let params = query_params(request_line);
    let get = |key: &str| params.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
    Some((get("code")?, get("state")?))
}

/// The authorization server's error redirect (RFC 6749 §4.1.2.1):
/// `?error=access_denied&error_description=…`. Returns `(error, description?)`
/// when `code` is absent but `error` is present. Pure → unit-tested.
fn parse_callback_error(request_line: &str) -> Option<(String, Option<String>)> {
    let params = query_params(request_line);
    let get = |key: &str| params.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
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
    use super::{parse_callback_error, parse_callback_query};

    #[test]
    fn parses_code_and_state() {
        assert_eq!(
            parse_callback_query("GET /callback?code=abc123&state=xyz HTTP/1.1"),
            Some(("abc123".to_string(), "xyz".to_string()))
        );
    }

    #[test]
    fn order_independent_decodes_and_ignores_extras() {
        // state before code, an unrelated param, %2F and + escapes.
        assert_eq!(
            parse_callback_query("GET /cb?state=s%2F1&foo=bar&code=c+d HTTP/1.1"),
            Some(("c d".to_string(), "s/1".to_string()))
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
