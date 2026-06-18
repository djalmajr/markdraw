//! Discovery of MCP servers that OTHER agent tools (Claude Code, Codex,
//! OpenCode) already configure — at GLOBAL (`~/…`) and per-PROJECT (`<root>/…`)
//! scope — normalized to Markdraw's `McpServerConfig` shape.
//!
//! This module ONLY reads + normalizes. It never connects: the JS host decides
//! which tools to read (gated on a *connected* Markdraw provider) and gates
//! project-scoped servers behind explicit user approval before they're spawned.
//! Secret refs (`${VAR}`) are rewritten to Markdraw's `{env:VAR}` so the
//! existing in-memory resolver expands them at connect time — nothing is
//! persisted and no value is resolved here.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

/// One MCP server found in another tool's config, normalized for Markdraw.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredMcpServer {
    /// The server's name in the source config (e.g. `linear`).
    pub name: String,
    /// `"stdio"` | `"http"`.
    pub transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    /// `"claude"` | `"codex"` | `"opencode"`.
    pub tool: String,
    /// `"global"` | `"project"`.
    pub scope: String,
    /// The project root this server belongs to (only for `scope == "project"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// Absolute path of the config file it came from.
    pub source_path: String,
}

/// Rewrite shell-style `${VAR}` references to Markdraw's `{env:VAR}` so the JS
/// resolver expands them in memory at connect time. Literal values (no `${}`)
/// pass through untouched. Claude and OpenCode both use `${VAR}`; Codex env
/// values are literal, so this is a no-op there.
fn translate_refs(value: &str) -> String {
    let re = regex::Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}").expect("valid regex");
    re.replace_all(value, "{env:$1}").into_owned()
}

fn translate_map(map: Option<HashMap<String, String>>) -> Option<HashMap<String, String>> {
    map.map(|m| {
        m.into_iter()
            .map(|(k, v)| (k, translate_refs(&v)))
            .collect()
    })
}

// ── Claude Code (~/.claude.json:mcpServers, <root>/.mcp.json, projects[root]) ──

#[derive(Deserialize)]
struct ClaudeServer {
    #[serde(default, rename = "type")]
    server_type: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    env: Option<HashMap<String, String>>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    headers: Option<HashMap<String, String>>,
}

/// Normalize a `{ name: ClaudeServer }` object (the shape under `mcpServers`).
fn claude_from_map(
    map: &serde_json::Map<String, serde_json::Value>,
    scope: &str,
    root: Option<&str>,
    source_path: &str,
) -> Vec<DiscoveredMcpServer> {
    let mut out = Vec::new();
    for (name, value) in map {
        let Ok(srv) = serde_json::from_value::<ClaudeServer>(value.clone()) else {
            continue;
        };
        // Type is optional: infer from whichever of url/command is present.
        let transport = match srv.server_type.as_deref() {
            Some("stdio") => "stdio",
            Some("http") | Some("sse") => "http",
            _ if srv.url.is_some() => "http",
            _ if srv.command.is_some() => "stdio",
            _ => continue, // neither a command nor a url — not connectable
        };
        // A declared type still needs the field that makes it connectable.
        if (transport == "stdio" && srv.command.is_none())
            || (transport == "http" && srv.url.is_none())
        {
            continue;
        }
        out.push(DiscoveredMcpServer {
            name: name.clone(),
            transport: transport.to_string(),
            command: srv.command,
            args: srv.args,
            env: translate_map(srv.env),
            url: srv.url,
            headers: translate_map(srv.headers),
            tool: "claude".to_string(),
            scope: scope.to_string(),
            root: root.map(str::to_string),
            source_path: source_path.to_string(),
        });
    }
    out
}

/// Extract the `mcpServers` object from a Claude JSON document at `path`
/// (`a/b/c` segments), then normalize it.
fn claude_servers_at(
    doc: &serde_json::Value,
    path: &[&str],
    scope: &str,
    root: Option<&str>,
    source_path: &str,
) -> Vec<DiscoveredMcpServer> {
    let mut node = doc;
    for seg in path {
        match node.get(seg) {
            Some(next) => node = next,
            None => return Vec::new(),
        }
    }
    match node.as_object() {
        Some(map) => claude_from_map(map, scope, root, source_path),
        None => Vec::new(),
    }
}

// ── Codex (~/.codex/config.toml, <root>/.codex/config.toml) ──

#[derive(Deserialize, Default)]
struct CodexConfig {
    #[serde(default)]
    mcp_servers: HashMap<String, CodexServer>,
}

#[derive(Deserialize)]
struct CodexServer {
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    env: Option<HashMap<String, String>>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    http_headers: Option<HashMap<String, String>>,
}

fn codex_from_toml(
    content: &str,
    scope: &str,
    root: Option<&str>,
    source_path: &str,
) -> Vec<DiscoveredMcpServer> {
    let Ok(cfg) = toml::from_str::<CodexConfig>(content) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (name, srv) in cfg.mcp_servers {
        let transport = if srv.url.is_some() {
            "http"
        } else if srv.command.is_some() {
            "stdio"
        } else {
            continue;
        };
        out.push(DiscoveredMcpServer {
            name,
            transport: transport.to_string(),
            command: srv.command,
            args: srv.args,
            env: translate_map(srv.env),
            url: srv.url,
            headers: translate_map(srv.http_headers),
            tool: "codex".to_string(),
            scope: scope.to_string(),
            root: root.map(str::to_string),
            source_path: source_path.to_string(),
        });
    }
    out
}

// ── OpenCode (~/.config/opencode/opencode.json, <root>/opencode.json) ──

#[derive(Deserialize, Default)]
struct OpencodeConfig {
    #[serde(default)]
    mcp: HashMap<String, OpencodeServer>,
}

#[derive(Deserialize)]
struct OpencodeServer {
    #[serde(default, rename = "type")]
    server_type: Option<String>,
    /// OpenCode bundles the program + its args into one array.
    #[serde(default)]
    command: Option<Vec<String>>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    headers: Option<HashMap<String, String>>,
    #[serde(default)]
    environment: Option<HashMap<String, String>>,
    #[serde(default)]
    enabled: Option<bool>,
}

fn opencode_from_json(
    content: &str,
    scope: &str,
    root: Option<&str>,
    source_path: &str,
) -> Vec<DiscoveredMcpServer> {
    let Ok(cfg) = serde_json::from_str::<OpencodeConfig>(content) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (name, srv) in cfg.mcp {
        // Honor OpenCode's own per-server disable.
        if srv.enabled == Some(false) {
            continue;
        }
        let is_remote = srv.server_type.as_deref() == Some("remote") || srv.url.is_some();
        let (transport, command, args) = if is_remote {
            if srv.url.is_none() {
                continue; // remote without a url is not connectable
            }
            ("http", None, None)
        } else {
            // local: command[0] is the program, the rest are args.
            let mut parts = srv.command.unwrap_or_default().into_iter();
            let Some(program) = parts.next() else {
                continue;
            };
            ("stdio", Some(program), Some(parts.collect::<Vec<_>>()))
        };
        out.push(DiscoveredMcpServer {
            name,
            transport: transport.to_string(),
            command,
            args: args.filter(|a| !a.is_empty()),
            env: translate_map(srv.environment),
            url: srv.url,
            headers: translate_map(srv.headers),
            tool: "opencode".to_string(),
            scope: scope.to_string(),
            root: root.map(str::to_string),
            source_path: source_path.to_string(),
        });
    }
    out
}

// ── Filesystem wiring ──

fn read(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// Discover MCP servers from the requested `tools` (`"claude"`/`"codex"`/
/// `"opencode"`) at global scope and per-project scope for each open `root`.
/// Unreadable/malformed sources are skipped, never fatal.
#[tauri::command]
pub async fn mcp_discover<R: Runtime>(
    app: AppHandle<R>,
    roots: Vec<String>,
    tools: Vec<String>,
) -> Result<Vec<DiscoveredMcpServer>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home dir: {e}"))?;
    let want = |t: &str| tools.iter().any(|x| x == t);
    let mut out: Vec<DiscoveredMcpServer> = Vec::new();

    // ── Claude Code ──
    if want("claude") {
        let global = home.join(".claude.json");
        if let Some(content) = read(&global) {
            if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&content) {
                let src = global.to_string_lossy();
                out.extend(claude_servers_at(&doc, &["mcpServers"], "global", None, &src));
                // Per-project MCP servers stored inside ~/.claude.json.
                for root in &roots {
                    out.extend(claude_servers_at(
                        &doc,
                        &["projects", root, "mcpServers"],
                        "project",
                        Some(root),
                        &src,
                    ));
                }
            }
        }
        // Project `.mcp.json` files.
        for root in &roots {
            let file = Path::new(root).join(".mcp.json");
            if let Some(content) = read(&file) {
                if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&content) {
                    out.extend(claude_servers_at(
                        &doc,
                        &["mcpServers"],
                        "project",
                        Some(root),
                        &file.to_string_lossy(),
                    ));
                }
            }
        }
    }

    // ── Codex ──
    if want("codex") {
        let global = home.join(".codex").join("config.toml");
        if let Some(content) = read(&global) {
            out.extend(codex_from_toml(
                &content,
                "global",
                None,
                &global.to_string_lossy(),
            ));
        }
        for root in &roots {
            let file = Path::new(root).join(".codex").join("config.toml");
            if let Some(content) = read(&file) {
                out.extend(codex_from_toml(
                    &content,
                    "project",
                    Some(root),
                    &file.to_string_lossy(),
                ));
            }
        }
    }

    // ── OpenCode ──
    if want("opencode") {
        let global = home.join(".config").join("opencode").join("opencode.json");
        if let Some(content) = read(&global) {
            out.extend(opencode_from_json(
                &content,
                "global",
                None,
                &global.to_string_lossy(),
            ));
        }
        for root in &roots {
            let file = Path::new(root).join("opencode.json");
            if let Some(content) = read(&file) {
                out.extend(opencode_from_json(
                    &content,
                    "project",
                    Some(root),
                    &file.to_string_lossy(),
                ));
            }
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find<'a>(v: &'a [DiscoveredMcpServer], name: &str) -> &'a DiscoveredMcpServer {
        v.iter().find(|s| s.name == name).expect("server present")
    }

    #[test]
    fn claude_http_and_stdio_with_ref_rewrite() {
        let doc: serde_json::Value = serde_json::from_str(
            r#"{ "mcpServers": {
                "linear": { "type": "http", "url": "https://mcp.linear.app/mcp",
                            "headers": { "Authorization": "Bearer ${LINEAR_API_KEY}" } },
                "tauri": { "command": "npx", "args": ["-y", "pkg"],
                           "env": { "PORT": "9223" } }
            } }"#,
        )
        .unwrap();
        let got = claude_servers_at(&doc, &["mcpServers"], "global", None, "/p");
        assert_eq!(got.len(), 2);
        let linear = find(&got, "linear");
        assert_eq!(linear.transport, "http");
        assert_eq!(
            linear.headers.as_ref().unwrap()["Authorization"],
            "Bearer {env:LINEAR_API_KEY}"
        );
        let tauri = find(&got, "tauri");
        assert_eq!(tauri.transport, "stdio");
        assert_eq!(tauri.command.as_deref(), Some("npx"));
        assert_eq!(tauri.env.as_ref().unwrap()["PORT"], "9223");
        assert_eq!(tauri.scope, "global");
    }

    #[test]
    fn codex_toml_ignores_unrelated_keys_and_infers_transport() {
        let content = r#"
            model = "gpt-5.5"
            [tui]
            status_line = ["x"]
            [mcp_servers.repl]
            command = "/bin/repl"
            args = []
            [mcp_servers.repl.env]
            A = "1"
            [mcp_servers.mem]
            url = "https://memory.example/mcp"
        "#;
        let got = codex_from_toml(content, "project", Some("/r"), "/r/.codex/config.toml");
        assert_eq!(got.len(), 2);
        let repl = find(&got, "repl");
        assert_eq!(repl.transport, "stdio");
        assert_eq!(repl.command.as_deref(), Some("/bin/repl"));
        assert_eq!(repl.env.as_ref().unwrap()["A"], "1");
        assert_eq!(repl.scope, "project");
        assert_eq!(repl.root.as_deref(), Some("/r"));
        let mem = find(&got, "mem");
        assert_eq!(mem.transport, "http");
        assert_eq!(mem.url.as_deref(), Some("https://memory.example/mcp"));
    }

    #[test]
    fn opencode_local_splits_command_and_skips_disabled() {
        let content = r#"{ "mcp": {
            "chrome": { "type": "local", "command": ["npx", "-y", "chrome-mcp"] },
            "remote-one": { "type": "remote", "url": "https://x/mcp",
                            "headers": { "Authorization": "Bearer ${TOK}" } },
            "off": { "type": "local", "command": ["foo"], "enabled": false }
        } }"#;
        let got = opencode_from_json(content, "global", None, "/p");
        assert_eq!(got.len(), 2, "disabled server is skipped");
        let chrome = find(&got, "chrome");
        assert_eq!(chrome.transport, "stdio");
        assert_eq!(chrome.command.as_deref(), Some("npx"));
        assert_eq!(chrome.args.as_ref().unwrap(), &vec!["-y", "chrome-mcp"]);
        let remote = find(&got, "remote-one");
        assert_eq!(remote.transport, "http");
        assert_eq!(
            remote.headers.as_ref().unwrap()["Authorization"],
            "Bearer {env:TOK}"
        );
    }

    #[test]
    fn opencode_local_single_element_command_has_no_args() {
        let content = r#"{ "mcp": { "p": { "type": "local", "command": ["/bin/p"] } } }"#;
        let got = opencode_from_json(content, "global", None, "/p");
        assert_eq!(got[0].command.as_deref(), Some("/bin/p"));
        assert!(got[0].args.is_none(), "empty args list is dropped");
    }

    #[test]
    fn claude_skips_entries_without_command_or_url() {
        let doc: serde_json::Value =
            serde_json::from_str(r#"{ "mcpServers": { "bad": { "type": "stdio" } } }"#).unwrap();
        assert!(claude_servers_at(&doc, &["mcpServers"], "global", None, "/p").is_empty());
    }
}
