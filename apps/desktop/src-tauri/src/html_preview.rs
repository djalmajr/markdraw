//! `markdraw-preview://` — a custom URI scheme that serves a single HTML
//! file's DIRECTORY as an isolated web origin, so multi-file pages and SPAs
//! preview with full fidelity. The scheme is app-namespaced (not a generic
//! `htmlpreview`) to avoid colliding with other apps' custom schemes.
//!
//! Why a scheme and not the `asset:` protocol + `<base href>`: `convertFileSrc`
//! encodes the whole path as one opaque segment, so a page's **root-absolute**
//! URLs (`/index.js`, `/assets/app.css`, importmap `~/` → `/`) resolve against
//! the asset origin root (the filesystem root), not the project folder — they
//! 404. Here every preview gets its own origin `markdraw-preview://<token>`,
//! whose root maps to the file's directory, so `/index.js` → `<dir>/index.js`
//! and ES modules / importmaps / hash routing all work.
//!
//! ## Isolation
//! The previewed page lives in the `markdraw-preview://<token>` origin,
//! distinct from the app's `tauri://localhost`. The frontend frames it sandboxed
//! (`allow-scripts allow-same-origin`, where "same-origin" means the preview's
//! OWN origin, not the app's). Tauri injects its IPC bridge per top-level
//! webview, not into page-created sub-frames, and no capability grants this
//! origin any command — so the previewed page cannot reach the Tauri IPC or the
//! host DOM. Only directories explicitly registered via `html_preview_register`
//! are servable (an allowlist), and each request is path-traversal-guarded both
//! lexically and via canonicalization.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use percent_encoding::percent_decode_str;
use regex::Regex;
use tauri::http::{Request, Response};
use tauri::{AppHandle, Manager, Runtime};

/// The custom URI scheme. App-namespaced to avoid collisions; the frontend
/// builds `markdraw-preview://<token>/<file>` URLs against this.
pub const SCHEME: &str = "markdraw-preview";

/// Query marker the CSS-module transform appends to a rewritten import so the
/// handler serves that `.css` as a constructable-stylesheet JS module instead
/// of a raw stylesheet. See `rewrite_css_module_imports` / `css_module_js`.
const CSS_MODULE_MARKER: &str = "markdraw-css-module";

/// Maps preview tokens to the directory they serve, plus an optional in-memory
/// overlay so the file currently open in the editor previews its UNSAVED buffer
/// (the rest of the tree still comes from disk).
#[derive(Default)]
pub struct HtmlPreviewState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    by_token: HashMap<String, PathBuf>,
    by_dir: HashMap<PathBuf, String>,
    /// token → (normalized rel path → live content). Nested by rel so two
    /// documents that share a token — which happens in relative-document mode,
    /// where every file in a workspace folder serves from the SAME workspace
    /// root — can each carry their own unsaved buffer (split-pane previews) and
    /// dropping one preview's overlay never clobbers the other's.
    overlay: HashMap<String, HashMap<String, String>>,
    /// Most recently registered/refreshed preview — the LAST fallback for
    /// Windows requests that carry no token anywhere. A module loaded via
    /// referer recovery (`/index.js`) refers its own imports without a token
    /// (`/pages/a.js` ← referer `/index.js`), so import CASCADES need an
    /// origin-wide default. One preview is active at a time in practice;
    /// the referer path still wins for the page's direct assets.
    active_token: Option<String>,
}

/// What `html_preview_register` hands back to the frontend: the directory's
/// token, the entry file's path RELATIVE TO THE SERVED ROOT, and whether the
/// page is served from its own directory (`own_root`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTarget {
    token: String,
    entry_rel: String,
    own_root: bool,
}

/// Whether an HTML entry should be served from its OWN directory at `/` (the
/// self-contained SPA / prototype case) rather than from the workspace folder.
///
/// True when the page declares an `importmap` or references a ROOT-ABSOLUTE
/// (`/…`, but not protocol-relative `//…`) script/stylesheet — both mean the
/// page treats `/` as the prototype root (root-absolute URLs, `~/ → /`
/// importmaps, `location.pathname` routers). Such a page MUST keep `/` mapped
/// to its own directory and load at `/` so its router matches the root route.
///
/// False for relative-only documents (`../assets/styles.css`, `other.html`):
/// those want the WORKSPACE folder as the origin so `../` climbs to shared
/// sibling directories, with the entry served at its true relative path so the
/// browser resolves relatives exactly like a `file://` open.
fn html_is_self_rooted(html: &str) -> bool {
    static IMPORTMAP: OnceLock<Regex> = OnceLock::new();
    static ROOT_ABS: OnceLock<Regex> = OnceLock::new();
    let importmap = IMPORTMAP.get_or_init(|| {
        Regex::new(r#"(?i)<script[^>]*\btype\s*=\s*["']importmap["']"#)
            .expect("valid importmap regex")
    });
    // A quote, then a single `/`, then a non-`/` (or a closing quote for the
    // bare-root `href="/"` case). The non-`/` lookahead excludes
    // protocol-relative `//cdn…` URLs, which are absolute, not root-rooted.
    let root_abs = ROOT_ABS.get_or_init(|| {
        Regex::new(r#"(?i)\b(?:src|href)\s*=\s*["']/(?:[^/]|["'])"#)
            .expect("valid root-absolute regex")
    });
    importmap.is_match(html) || root_abs.is_match(html)
}

/// Register the previewed file and return its (stable, per-session) token plus
/// the entry path relative to whatever directory ended up serving it.
///
/// `root` is the workspace folder the file was opened under; `rel` is the
/// file's path relative to it. The serving directory is chosen by inspecting
/// the entry file ON DISK (see `html_is_self_rooted`): a self-rooted SPA serves
/// from its own directory; a relative document serves from the workspace folder
/// so `../` works. Reading disk here — rather than the editor buffer in JS —
/// sidesteps a registration race where the new file's buffer hasn't loaded yet;
/// the live buffer is still applied as an overlay at serve time.
///
/// Idempotent per serving directory: the same canonical directory always yields
/// the same token, so the iframe URL stays cache-friendly across re-previews.
#[tauri::command]
pub fn html_preview_register(
    state: tauri::State<'_, HtmlPreviewState>,
    root: String,
    rel: String,
) -> Result<PreviewTarget, String> {
    let root_canon = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
    if !root_canon.is_dir() {
        return Err("html_preview_register: root is not a directory".into());
    }
    let rel_clean = clean_rel(&rel);
    let entry_abs = root_canon.join(&rel_clean);
    // Best-effort: an unreadable / not-yet-saved entry reads as empty, which is
    // not self-rooted → relative-document mode (the safe `file://`-like default).
    let content = std::fs::read_to_string(&entry_abs).unwrap_or_default();
    let own_root = html_is_self_rooted(&content);

    let (serve_dir, entry_rel) = if own_root {
        let dir = entry_abs
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| root_canon.clone());
        let name = entry_abs
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| rel_clean.clone());
        (dir, name)
    } else {
        (root_canon.clone(), rel_clean.clone())
    };
    let serve_dir = std::fs::canonicalize(&serve_dir).map_err(|e| e.to_string())?;

    let mut inner = state.inner.lock().unwrap();
    let token = if let Some(token) = inner.by_dir.get(&serve_dir).cloned() {
        token
    } else {
        let token = format!("r{}", inner.next_id);
        inner.next_id += 1;
        inner.by_token.insert(token.clone(), serve_dir.clone());
        inner.by_dir.insert(serve_dir, token.clone());
        token
    };
    inner.active_token = Some(token.clone());
    Ok(PreviewTarget {
        token,
        entry_rel,
        own_root,
    })
}

/// Set the live overlay for `token`: requests for `rel_path` serve `content`
/// (the editor's current, possibly unsaved, buffer) instead of the disk file.
#[tauri::command]
pub fn html_preview_set_overlay(
    state: tauri::State<'_, HtmlPreviewState>,
    token: String,
    rel_path: String,
    content: String,
) {
    let mut inner = state.inner.lock().unwrap();
    if inner.by_token.contains_key(&token) {
        inner.active_token = Some(token.clone());
        inner
            .overlay
            .entry(token)
            .or_default()
            .insert(clean_rel(&rel_path), content);
    }
}

/// Drop the live overlay for one file under `token` (e.g. when its preview
/// closes), so future requests for it fall back to disk. Only that file's
/// buffer is removed — sibling previews sharing the token (relative-document
/// mode) keep theirs. The token's map is dropped once its last file leaves.
#[tauri::command]
pub fn html_preview_clear_overlay(
    state: tauri::State<'_, HtmlPreviewState>,
    token: String,
    rel_path: String,
) {
    let mut inner = state.inner.lock().unwrap();
    if let Some(map) = inner.overlay.get_mut(&token) {
        map.remove(&clean_rel(&rel_path));
        if map.is_empty() {
            inner.overlay.remove(&token);
        }
    }
}

/// Split a cleaned path into (first segment, rest) — the Windows/WebView2
/// request shape, where the custom scheme folds into a fixed host
/// (`http://markdraw-preview.localhost/...` or plain `localhost`) and the
/// preview token travels as the FIRST path segment instead of the host.
fn token_from_path(cleaned: &str) -> (String, String) {
    match cleaned.split_once('/') {
        Some((token, rest)) => (token.to_string(), rest.to_string()),
        None => (cleaned.to_string(), String::new()),
    }
}

/// Resolve which registered token a request belongs to, plus the file path
/// under it. Shapes, in resolution order:
///
/// 1. macOS/Linux navigate the bare scheme — the token IS the host.
/// 2. The entry DOCUMENT is loaded at the origin ROOT with the token in the
///    query (`/?am-token=r0&am-entry=index.html`), so SPAs whose router
///    matches `location.pathname` see `/` — a token-leading path would never
///    match their routes.
/// 3. Windows folds the scheme into a fixed host and the token leads the
///    path (`/r0/index.html`).
/// 4. Windows + a page URL that is ROOT-ABSOLUTE (`/index.css`): the token
///    never makes it into the request path, so it is recovered from the
///    Referer (same-origin subresource requests always carry the full
///    referring URL — including the doc's `am-token` query) and the WHOLE
///    path is the file path.
fn resolve_request(
    is_registered: &dyn Fn(&str) -> bool,
    host: &str,
    cleaned: &str,
    query_token: Option<&str>,
    referer_candidates: &[String],
    active_token: Option<&str>,
) -> (String, String) {
    if is_registered(host) {
        return (host.to_string(), cleaned.to_string());
    }
    if let Some(qt) = query_token {
        if is_registered(qt) {
            return (qt.to_string(), cleaned.to_string());
        }
    }
    let (head, rest) = token_from_path(cleaned);
    if is_registered(&head) {
        return (head, rest);
    }
    for candidate in referer_candidates {
        if is_registered(candidate) {
            return (candidate.clone(), cleaned.to_string());
        }
    }
    // Import CASCADES on Windows: a module recovered via referer
    // (`/index.js`) refers ITS imports without a token either, so the last
    // resort is the most recently active preview.
    if let Some(active) = active_token {
        return (active.to_string(), cleaned.to_string());
    }
    (head, rest)
}

/// Candidate tokens from a Referer URL: its `am-token` query param (the
/// root-served document shape), its host (macOS shape) and its first path
/// segment (Windows path shape). The caller validates against the registry.
fn referer_token_candidates(headers: &tauri::http::HeaderMap) -> Vec<String> {
    let Some(raw) = headers.get("referer").and_then(|v| v.to_str().ok()) else {
        return Vec::new();
    };
    let Ok(uri) = raw.parse::<tauri::http::Uri>() else {
        return Vec::new();
    };
    let decoded = percent_decode_str(uri.path()).decode_utf8_lossy();
    let (head, _) = token_from_path(&clean_rel(&decoded));
    let mut out: Vec<String> = Vec::new();
    if let Some(t) = uri.query().and_then(|q| query_param(q, "am-token")) {
        out.push(t);
    }
    if let Some(h) = uri.host() {
        out.push(h.to_string());
    }
    out.push(head);
    out
}

/// Extract a query parameter's percent-decoded value from a raw query string.
fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (k == key).then(|| percent_decode_str(v).decode_utf8_lossy().into_owned())
    })
}

/// The file to serve once the token is known: the request path when it has
/// one, else the `am-entry` query param (the root-served document shape),
/// else the conventional `index.html`.
fn effective_rel(rel: String, query: &str) -> String {
    if !rel.is_empty() {
        return rel;
    }
    query_param(query, "am-entry")
        .map(|e| clean_rel(&e))
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| "index.html".to_string())
}

/// Serve one preview request (see `resolve_request` for the URL shapes).
/// Registered on the Tauri builder; runs on Tauri's protocol thread (blocking
/// file IO is fine — preview assets are small and local).
pub fn serve<R: Runtime>(app: &AppHandle<R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let state = app.state::<HtmlPreviewState>();
    let uri = request.uri();
    // Path arrives percent-encoded; decode, then lexically strip `..`/`.`/root.
    let decoded = percent_decode_str(uri.path()).decode_utf8_lossy();
    let host = uri.host().unwrap_or("").to_string();
    let cleaned = clean_rel(&decoded);
    let query = uri.query().unwrap_or("");
    let query_token = query_param(query, "am-token");
    let referer_candidates = referer_token_candidates(request.headers());
    let (token, rel) = {
        let inner = state.inner.lock().unwrap();
        let is_registered = |t: &str| inner.by_token.contains_key(t);
        resolve_request(
            &is_registered,
            &host,
            &cleaned,
            query_token.as_deref(),
            &referer_candidates,
            inner.active_token.as_deref(),
        )
    };
    let rel = effective_rel(rel, query);

    // A rewritten CSS-module import (see rewrite_css_module_imports) asks for
    // the `.css` as a JS module exporting a constructable stylesheet.
    let as_css_module = query.contains(CSS_MODULE_MARKER);

    let inner = state.inner.lock().unwrap();
    let Some(root) = inner.by_token.get(&token).cloned() else {
        return not_found();
    };
    // Live overlay wins for the open file (shows unsaved edits). The entry doc
    // is HTML, never a CSS module or JS, so serve it verbatim.
    if let Some(content) = inner.overlay.get(&token).and_then(|m| m.get(&rel)) {
        return ok(
            inject_preview_chrome(content).into_bytes(),
            content_type_for("page.html"),
        );
    }
    drop(inner);

    // `clean_rel` already removed traversal lexically; canonicalize is the
    // second guard, catching symlinks that point outside the root.
    let candidate = root.join(&rel);
    let Ok(canon) = std::fs::canonicalize(&candidate) else {
        return not_found();
    };
    if !canon.starts_with(&root) {
        return not_found();
    }
    let Ok(bytes) = std::fs::read(&canon) else {
        return not_found();
    };

    // WKWebView rejects `import … with { type: "css" }`, so the preview acts as
    // a tiny bundler: CSS imported as a module is served as a JS module that
    // builds a CSSStyleSheet, and JS files have their CSS-module imports
    // rewritten to hit that path. Binary/invalid-UTF-8 files pass through.
    if as_css_module {
        let css = String::from_utf8_lossy(&bytes);
        return ok(css_module_js(&css).into_bytes(), content_type_for("m.js"));
    }
    if is_js_module(&rel) {
        if let Ok(js) = std::str::from_utf8(&bytes) {
            return ok(
                rewrite_css_module_imports(js).into_bytes(),
                content_type_for(&rel),
            );
        }
    }
    if is_html(&rel) {
        if let Ok(html) = std::str::from_utf8(&bytes) {
            return ok(inject_preview_chrome(html).into_bytes(), content_type_for(&rel));
        }
    }
    ok(bytes, content_type_for(&rel))
}

fn is_html(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower.ends_with(".html") || lower.ends_with(".htm")
}

/// A discreet, theme-agnostic scrollbar for the previewed page. The iframe is a
/// separate document/origin, so neither the app's global scrollbar CSS nor
/// <ScrollArea> reach inside it — without this, a page that doesn't style its
/// own scrollbar shows WKWebView's thick default. Injected at the very top of
/// <head> so a page that DOES style its scrollbar still overrides ours.
///
/// Deliberately uses ONLY `::-webkit-scrollbar` (a fixed-width custom bar) and
/// NOT the standard `scrollbar-width`/`scrollbar-color`: in WebKit, setting
/// those switches the element to the NATIVE macOS overlay scrollbar (which
/// fattens on hover/scroll) and makes WebKit ignore `::-webkit-scrollbar`. So
/// the standard props are intentionally absent — they'd reintroduce the thick
/// native bar this fix removes.
const PREVIEW_SCROLLBAR_CSS: &str = "<style data-markdraw-preview>\
::-webkit-scrollbar{width:8px;height:8px}\
::-webkit-scrollbar-track{background:transparent}\
::-webkit-scrollbar-thumb{background-color:rgba(128,128,128,.45);border:1px solid transparent;background-clip:padding-box;border-radius:9999px}\
::-webkit-scrollbar-thumb:hover{background-color:rgba(128,128,128,.65)}\
</style>";

/// Insert `PREVIEW_SCROLLBAR_CSS` right after the opening `<head>` (so the page
/// can still override it), or prepend it when there's no head.
fn inject_preview_chrome(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if let Some(h) = lower.find("<head") {
        if let Some(gt) = lower[h..].find('>') {
            let pos = h + gt + 1;
            return format!("{}{}{}", &html[..pos], PREVIEW_SCROLLBAR_CSS, &html[pos..]);
        }
    }
    format!("{PREVIEW_SCROLLBAR_CSS}{html}")
}

/// True for files the browser loads as ES modules (where CSS-module imports may
/// appear and need rewriting).
fn is_js_module(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs")
}

/// Rewrite `import x from "y.css" with { type: "css" }` (and the legacy
/// `assert { type: "css" }`) into `import x from "y.css?markdraw-css-module"`,
/// dropping the unsupported import attribute. The marked URL is served by
/// `serve` as a JS module (see `css_module_js`). Best-effort and conservative:
/// it only touches imports that carry a `type: "css"` attribute, so ordinary
/// code is untouched. Files without such imports return unchanged (cheap).
fn rewrite_css_module_imports(js: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(
            r#"(?s)\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+(?:"([^"]+)"|'([^']+)')\s*(?:with|assert)\s*\{\s*type\s*:\s*(?:"css"|'css')\s*,?\s*\}"#,
        )
        .expect("valid css-module import regex")
    });
    re.replace_all(js, |caps: &regex::Captures| {
        let binding = &caps[1];
        let spec = caps
            .get(2)
            .or_else(|| caps.get(3))
            .map(|m| m.as_str())
            .unwrap_or("");
        let sep = if spec.contains('?') { '&' } else { '?' };
        format!("import {binding} from \"{spec}{sep}{CSS_MODULE_MARKER}\"")
    })
    .into_owned()
}

/// Wrap CSS text as a JS module exporting a constructable CSSStyleSheet — the
/// runtime shape `import sheet from "x.css" with { type: "css" }` would have
/// produced. The CSS is embedded as a JSON string literal (valid JS), so any
/// quotes/newlines/unicode are escaped safely.
fn css_module_js(css: &str) -> String {
    let literal = serde_json::to_string(css).unwrap_or_else(|_| "\"\"".to_string());
    format!("const sheet = new CSSStyleSheet();\nsheet.replaceSync({literal});\nexport default sheet;\n")
}

/// Lexically normalize a URL path into a safe relative path: percent-decoded
/// already, here we drop the leading slash and every `.`/`..`/root component,
/// keeping only `Normal` segments. `..` can never climb out of the root.
fn clean_rel(path: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for comp in Path::new(path).components() {
        if let Component::Normal(s) = comp {
            parts.push(s.to_string_lossy().to_string());
        }
    }
    parts.join("/")
}

/// Content-Type by extension. Critical: `.js`/`.mjs` MUST be `text/javascript`
/// (not `text/plain`) or the webview refuses to execute `<script type=module>`,
/// which is the whole point of serving SPAs.
fn content_type_for(rel: &str) -> &'static str {
    let ext = Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

fn ok(bytes: Vec<u8>, content_type: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(200)
        .header("Content-Type", content_type)
        // The preview page is same-origin to its own assets; no app code reads
        // these, so keep them uncached during live editing.
        .header("Cache-Control", "no-store")
        .body(bytes)
        .unwrap()
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(404)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(b"Not Found".to_vec())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_request_handles_all_url_shapes() {
        let is_reg = |t: &str| t == "r0" || t == "r1";
        // macOS: token = host.
        assert_eq!(
            resolve_request(&is_reg, "r0", "index.html", None, &[], None),
            ("r0".to_string(), "index.html".to_string())
        );
        // Root-served document: empty path, token in the query. The path stays
        // `/` so SPA path routers match their root route.
        assert_eq!(
            resolve_request(&is_reg, "markdraw-preview.localhost", "", Some("r0"), &[], None),
            ("r0".to_string(), String::new())
        );
        // An UNREGISTERED query token must not hijack resolution.
        assert_eq!(
            resolve_request(&is_reg, "r1", "a.js", Some("zz"), &[], None),
            ("r1".to_string(), "a.js".to_string())
        );
        // Windows: token leads the path.
        assert_eq!(
            resolve_request(
                &is_reg,
                "markdraw-preview.localhost",
                "r0/assets/app.js",
                None,
                &[],
                None,
            ),
            ("r0".to_string(), "assets/app.js".to_string())
        );
        // Windows + ROOT-ABSOLUTE page URL (/index.css): no token in the
        // request — recovered from the Referer; the whole path is the file.
        assert_eq!(
            resolve_request(
                &is_reg,
                "markdraw-preview.localhost",
                "index.css",
                None,
                &["markdraw-preview.localhost".to_string(), "r1".to_string()],
                None,
            ),
            ("r1".to_string(), "index.css".to_string())
        );
        // No referer match → falls through (and 404s at the registry lookup).
        assert_eq!(
            resolve_request(&is_reg, "localhost", "nope.css", None, &["zz".to_string()], None),
            ("nope.css".to_string(), String::new())
        );
        // Import CASCADE: a module loaded via referer recovery refers its own
        // imports tokenlessly (referer "/index.js") — the ACTIVE preview
        // catches them.
        assert_eq!(
            resolve_request(
                &is_reg,
                "markdraw-preview.localhost",
                "pages/user-edit.js",
                None,
                &["markdraw-preview.localhost".to_string(), "index.js".to_string()],
                Some("r1"),
            ),
            ("r1".to_string(), "pages/user-edit.js".to_string())
        );
    }

    #[test]
    fn query_param_extracts_and_decodes() {
        assert_eq!(
            query_param("am-token=r0&am-entry=index.html&v=3", "am-token"),
            Some("r0".to_string())
        );
        assert_eq!(
            query_param("am-entry=sub%2Fpage.html", "am-entry"),
            Some("sub/page.html".to_string())
        );
        // Mutation: matching by `contains` instead of exact key would let
        // `am-token` answer for `token` (or vice versa).
        assert_eq!(query_param("am-token=r0", "token"), None);
        assert_eq!(query_param("v=1", "am-token"), None);
    }

    #[test]
    fn effective_rel_prefers_path_then_entry_then_index() {
        // A real path wins even when an am-entry is present.
        assert_eq!(
            effective_rel("assets/app.js".to_string(), "am-entry=index.html"),
            "assets/app.js"
        );
        // Root-served document: `/` + am-entry → the registered entry file.
        assert_eq!(
            effective_rel(String::new(), "am-token=r0&am-entry=demo.html&v=0"),
            "demo.html"
        );
        // am-entry is traversal-guarded like any other path.
        assert_eq!(
            effective_rel(String::new(), "am-entry=..%2F..%2Fetc%2Fpasswd"),
            "etc/passwd"
        );
        assert_eq!(effective_rel(String::new(), "v=0"), "index.html");
    }

    #[test]
    fn referer_candidates_lead_with_the_query_token() {
        let mut headers = tauri::http::HeaderMap::new();
        headers.insert(
            "referer",
            "http://markdraw-preview.localhost/?am-token=r7&am-entry=index.html&v=2"
                .parse()
                .unwrap(),
        );
        let candidates = referer_token_candidates(&headers);
        // The explicit am-token is the most precise source — it must come
        // before the host/path-head guesses.
        assert_eq!(candidates.first().map(String::as_str), Some("r7"));
        assert!(candidates.contains(&"markdraw-preview.localhost".to_string()));
    }

    #[test]
    fn token_from_path_splits_first_segment() {
        // Windows folds the scheme into a fixed host and moves the token into
        // the path — first segment is the token, the rest is the file path.
        assert_eq!(
            token_from_path("r0/index.html"),
            ("r0".to_string(), "index.html".to_string())
        );
        assert_eq!(
            token_from_path("r0/assets/app.js"),
            ("r0".to_string(), "assets/app.js".to_string())
        );
        // Root request → empty rel (caller defaults to index.html).
        assert_eq!(token_from_path("r0"), ("r0".to_string(), String::new()));
        assert_eq!(token_from_path(""), (String::new(), String::new()));
    }

    #[test]
    fn clean_rel_strips_traversal_and_roots() {
        // Mutation: keeping `..` would let `htmlpreview://t/../../etc/passwd`
        // climb out of the served directory.
        assert_eq!(clean_rel("/../../etc/passwd"), "etc/passwd");
        assert_eq!(clean_rel("/assets/../assets/app.js"), "assets/assets/app.js");
        assert_eq!(clean_rel("/./index.html"), "index.html");
        assert_eq!(clean_rel("/"), "");
        assert_eq!(clean_rel("/a/b/c.css"), "a/b/c.css");
    }

    #[test]
    fn clean_rel_join_stays_under_root() {
        let root = Path::new("/srv/preview");
        let joined = root.join(clean_rel("/../../../etc/shadow"));
        assert!(joined.starts_with(root), "join escaped root: {joined:?}");
    }

    #[test]
    fn content_type_modules_are_javascript() {
        // Mutation: returning text/plain here breaks ES module execution.
        assert_eq!(content_type_for("a.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for("a.mjs"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type_for("s.css"), "text/css; charset=utf-8");
        assert_eq!(content_type_for("blob.bin"), "application/octet-stream");
    }

    #[test]
    fn rewrites_css_module_import_with_attribute() {
        // Mutation: leaving `with { type: "css" }` makes WKWebView throw
        // `Import attribute type "css" is not valid` and abort the module.
        let out = rewrite_css_module_imports(
            r#"import sheet from "./z-proto.css" with { type: "css" };"#,
        );
        assert_eq!(
            out,
            r#"import sheet from "./z-proto.css?markdraw-css-module";"#
        );
        assert!(!out.contains("type"));
    }

    #[test]
    fn rewrites_legacy_assert_and_single_quotes() {
        let out = rewrite_css_module_imports(
            "import s from './a/b.css' assert { type: 'css' }\n",
        );
        assert_eq!(out, "import s from \"./a/b.css?markdraw-css-module\"\n");
    }

    #[test]
    fn css_import_keeps_existing_query_with_ampersand() {
        let out = rewrite_css_module_imports(
            r#"import s from "./x.css?v=2" with { type: "css" };"#,
        );
        assert!(out.contains(r#""./x.css?v=2&markdraw-css-module""#), "{out}");
    }

    #[test]
    fn leaves_unrelated_imports_untouched() {
        // Mutation: an over-broad regex would corrupt ordinary imports or
        // JSON-module imports (which WKWebView DOES support).
        let src = "import x from \"./m.js\";\nimport d from \"./d.json\" with { type: \"json\" };\n";
        assert_eq!(rewrite_css_module_imports(src), src);
    }

    #[test]
    fn css_module_js_exports_a_constructable_sheet() {
        let js = css_module_js(".a{content:\"x\"}\n");
        assert!(js.contains("new CSSStyleSheet()"));
        assert!(js.contains("replaceSync("));
        assert!(js.contains("export default sheet"));
        // CSS embedded as a JSON string literal → quotes/newlines escaped.
        assert!(js.contains(r#"".a{content:\"x\"}\n""#), "{js}");
    }

    #[test]
    fn is_js_module_matches_module_extensions() {
        assert!(is_js_module("a.js"));
        assert!(is_js_module("dir/b.mjs"));
        assert!(is_js_module("c.cjs"));
        assert!(!is_js_module("style.css"));
        assert!(!is_js_module("page.html"));
    }

    #[test]
    fn injects_scrollbar_style_after_head() {
        let out = inject_preview_chrome("<html><head><title>x</title></head><body>y</body></html>");
        // Lands right after <head>, before the page's own head content, so the
        // page can still override it.
        assert!(out.contains("<head><style data-markdraw-preview>"), "{out}");
        assert!(out.find("data-markdraw-preview").unwrap() < out.find("<title>").unwrap());
        assert!(out.contains("::-webkit-scrollbar-thumb"));
    }

    #[test]
    fn injects_scrollbar_style_when_no_head() {
        // Mutation: skipping the prepend would leave a head-less fragment with
        // WKWebView's thick default scrollbar.
        let out = inject_preview_chrome("<p>fragment</p>");
        assert!(out.starts_with("<style data-markdraw-preview>"));
        assert!(out.ends_with("<p>fragment</p>"));
    }

    #[test]
    fn self_rooted_detects_importmap_and_root_absolute() {
        // importmap → the page treats `/` as its prototype root.
        assert!(html_is_self_rooted(
            r#"<script type="importmap">{"imports":{"~/":"/"}}</script>"#
        ));
        // root-absolute script / stylesheet → same.
        assert!(html_is_self_rooted(
            r#"<script type="module" src="/index.js"></script>"#
        ));
        assert!(html_is_self_rooted(
            r#"<link rel="stylesheet" href="/index.css">"#
        ));
        // bare root href still counts.
        assert!(html_is_self_rooted(r#"<a href="/">home</a>"#));
    }

    #[test]
    fn self_rooted_false_for_relative_documents() {
        // Mutation: classifying these as self-rooted would keep `/` mapped to
        // the file's own dir, so `../assets` could never climb to siblings.
        assert!(!html_is_self_rooted(
            r#"<link rel="stylesheet" href="../assets/styles.css">"#
        ));
        assert!(!html_is_self_rooted(r#"<a href="0002-lesson.html">next</a>"#));
        assert!(!html_is_self_rooted(r#"<img src="./pic.png">"#));
        // Absolute & protocol-relative URLs are NOT root-absolute paths.
        assert!(!html_is_self_rooted(
            r#"<script src="//cdn.example.com/x.js"></script>"#
        ));
        assert!(!html_is_self_rooted(
            r#"<link href="https://fonts.example/x.css">"#
        ));
    }

    #[test]
    fn is_html_matches_html_extensions() {
        assert!(is_html("index.html"));
        assert!(is_html("a/b.htm"));
        assert!(!is_html("app.js"));
        assert!(!is_html("style.css"));
    }
}
