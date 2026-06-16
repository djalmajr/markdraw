//! Generic OAuth for MCP HTTP servers — works for ANY OAuth-gated server
//! (ai-memory, Linear, …), NOT coupled to any one MCP. rmcp's
//! [`AuthorizationManager`] drives the protocol (RFC 9728 discovery, Dynamic
//! Client Registration, authorization-code + PKCE, refresh); this module supplies
//! the pieces rmcp leaves to the host: a keychain-backed [`CredentialStore`] so
//! tokens + the registered client survive restarts, and (later) the interactive
//! browser + loopback-callback that completes the authorization-code flow.

use keyring::Entry;
use rmcp::transport::auth::{AuthError, CredentialStore, StoredCredentials};

/// Keychain service for stored MCP OAuth credentials. Distinct from the AI
/// provider API-key service (`dev.djalmajr.asciimark`) so the two never collide;
/// the account is the MCP server id.
const OAUTH_SERVICE: &str = "dev.djalmajr.asciimark.mcp-oauth";

/// Persists one MCP server's OAuth credentials (access/refresh tokens + the
/// DCR-registered client id) in the OS keychain, keyed by the server id.
// Wired into the connect flow in the next block (the AuthorizationManager).
#[allow(dead_code)]
pub struct KeychainCredentialStore {
    server_id: String,
}

#[allow(dead_code)]
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
